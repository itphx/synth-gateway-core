import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Readable } from 'node:stream';

import { Hono } from 'hono';

import { SynthApi } from './api.js';
import { AuthTokenProvider, isOidcPartial } from './auth.js';
import type { ChannelAdapter, ChannelContext, PublishResult } from './channel.js';
import { tenantStoreDir, type ChannelTenantSchema, type GatewayDefaults, type TenantConfig } from './config.js';
import {
  GatewayHealth,
  GatewayHealthRegistry,
  SynthHealthProbe,
  type AuthMode,
  type ChannelStatus,
  type HealthSnapshot,
  type HealthStatus,
  type OverallStatus,
  type TokenStatus,
} from './health.js';
import { Ingress, ROUTES_BUCKET } from './ingress.js';
import { createLogger, createTenantLogger, GATEWAY_LOG_PREFIX } from './logger.js';
import { DEFAULT_MCP_HTTP_PORT, startMcpHttpServer, type McpHttpServerHandle } from './mcp/http.js';
import type { McpToolset } from './mcp/toolset.js';
import { FileStore, RecordStore, StateStore } from './store.js';
import type { InboundMessage, SessionRoute } from './types.js';
import { ResponseWatcher } from './watcher.js';

/**
 * Рантайм-оркестрация ядра шлюза (ADR-103, §4.8 контракта пакета).
 *
 * Порт `src/gateway/index.ts` + `src/gateway/runtime.ts` + `src/gateway/server.ts`
 * эталонного Telegram-шлюза. Разница — в разделении ответственности: ядро
 * **не знает** wire-протокола канала, канал создаётся шлюзом через
 * {@link GatewayOptions.createChannel} и получает готовые компоненты
 * ({@link ChannelDeps}).
 *
 * Порядок запуска (важен для деплоя):
 *
 * 1. **health-сервер поднимается ДО каналов** — пробы деплоя не должны зависеть
 *    от доступности внешнего мира (мессенджер, Synth);
 * 2. для каждого тенанта собираются состояние, аутентификация, клиент API,
 *    health, приём (ingress) и канал;
 * 3. демон: каналы принимают, watcher'ы раздают ответы;
 * 4. `SIGINT`/`SIGTERM` — корректная остановка (каналы, watcher'ы, health-проба,
 *    health-сервер, MCP-сервер).
 *
 * Ядро не бросает исключений из-за канала: ошибка `channel.start` — лог +
 * `health.setChannel('down')`, процесс продолжает жить.
 */

/** Значение `source` в health-ответе: ядро не знает про конкретный канал. */
export const GATEWAY_HEALTH_SOURCE = 'gateway';

/**
 * Таймаут ожидания завершения watcher'ов при остановке, мс.
 *
 * Страховка: канал, который не отпускает SSE-соединение, не должен держать
 * процесс при остановке.
 */
export const WATCHER_STOP_TIMEOUT_MS = 5000;

/** Конфигурация рантайма шлюза (собирается каналом из CLI/env/`tenants.json`). */
export interface GatewayConfig<TChannel> {
  /** Версия пакета. */
  version: string;
  /** Каталог состояния (изоляция по тенантам — внутри). */
  dataDir: string;
  /** Адрес health-сервера. */
  host: string;
  /** Порт health-сервера (`0` — порт назначит ОС). */
  port: number;
  /** Режим без внешних вызовов (dry-run). */
  dryRun: boolean;
  /** Включён ли исходящий watcher. */
  watch: boolean;
  /** Тенанты шлюза (канал → среда Synth). */
  tenants: TenantConfig<TChannel>[];
  /** Путь к файлу тенантов (для health/логов; `undefined` — legacy-режим). */
  tenantsFile?: string;
}

/**
 * Компоненты, которые ядро передаёт каналу.
 *
 * Канал получает всё, что нужно для работы с Synth, но **не** получает
 * доступа к внутренностям ядра: только `publish` (публикация входящего
 * сообщения) и клиент API v2 (привязки/сессии/пользователи).
 */
export interface ChannelDeps {
  /** Состояние тенанта. */
  state: StateStore;
  /** Клиент API v2 Synth. */
  synth: SynthApi;
  /** Аутентификация в API Synth. */
  auth: AuthTokenProvider;
  /** Health тенанта. */
  health: GatewayHealth;
  /** Логгер тенанта: `[gateway][<tenantId>]`. */
  log: (message: string) => void;
  /**
   * Приём: нормализованное сообщение → публикация в Synth.
   *
   * После успешной публикации ядро помечает входящее сообщение прочитанным
   * (`channel.markRead`), если канал это умеет.
   */
  publish: (message: InboundMessage) => Promise<PublishResult>;
}

/** Опции запуска шлюза (то, что задаёт канал). */
export interface GatewayOptions<TChannel> {
  /** Версия пакета. */
  version: string;
  /** Схема канальной секции тенанта (ключи записи `tenants.json`). */
  schema: ChannelTenantSchema<TChannel>;
  /** Дефолты тенанта (канал + synth + allowlist + unknownAction + watch). */
  defaults: GatewayDefaults<TChannel>;
  /** Создать канал тенанта. */
  createChannel: (tenant: TenantConfig<TChannel>, deps: ChannelDeps) => ChannelAdapter;
  /** Набор MCP-тулов тенанта (необязательно — без него MCP-часть не поднимается). */
  createMcpTools?: (tenant: TenantConfig<TChannel>, deps: ChannelDeps) => McpToolset;
  /** Bearer-токен HTTP-MCP (необязательно — без него MCP не поднимается). */
  mcpToken?: string;
  /** Порт HTTP-MCP (по умолчанию 7101). */
  mcpPort?: number;
  /** Сигналы остановки (по умолчанию SIGINT/SIGTERM). */
  signals?: NodeJS.Signals[];
}

/** Тело `GET /health` ядра (без аутентификации — инвариант 4 контракта). */
export interface GatewayHealthBody {
  /** Агрегатный статус процесса. */
  status: OverallStatus;
  /** Версия пакета. */
  version: string;
  /** Источник health-ответа (ядро не знает про конкретный канал). */
  source: string;
  /** Доступность Synth API. */
  synth: HealthStatus;
  /** Состояние каналов. */
  channel: ChannelStatus;
  /** Состояние watcher'ов ответов агента. */
  watcher: HealthStatus;
  /** Режим аутентификации Synth API. */
  auth: AuthMode;
  /** Доступность токена аутентификации. */
  token: TokenStatus;
  /** Снимки по тенантам. */
  tenants: Record<string, HealthSnapshot>;
}

/** Запущенный шлюз (управление остановкой без сигналов). */
export interface GatewayRuntime {
  /** Реестр health-контекстов тенантов. */
  health: GatewayHealthRegistry;
  /** Порт health-сервера (фактический — при `port: 0` назначенный ОС). */
  healthPort: number;
  /** Порт HTTP-MCP (если MCP-сервер поднят). */
  mcpPort?: number;
  /** Резолвится после полной остановки шлюза. */
  done: Promise<void>;
  /** Корректная остановка (идемпотентна): каналы, watcher'ы, серверы. */
  stop(): Promise<void>;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Человекочитаемая метка режима аутентификации Synth API (без секретов). */
function authLabel(mode: AuthMode): string {
  switch (mode) {
    case 'service-key':
      return 'service-key (scoped)';
    case 'oidc':
      return 'OIDC client-credentials';
    case 'api-key':
      return 'Bearer-ключ';
    default:
      return 'без ключа';
  }
}

/** Логи запуска тенанта (без секретов). */
function logTenantStartup(
  tenant: TenantConfig<unknown>,
  authMode: AuthMode,
  log: (message: string) => void,
): void {
  log(`[gateway] тенант «${tenant.id}»`);
  log(`[gateway] API v2: ${tenant.synth.baseUrl} (auth: ${authLabel(authMode)})`);
  log(`[gateway] список доступа: ${Object.keys(tenant.allowlist).length} записей`);
  log(`[gateway] политика неизвестного отправителя: ${tenant.unknownAction}`);
}

/** Собранные компоненты одного тенанта. */
interface TenantRuntimeParts<TChannel> {
  tenant: TenantConfig<TChannel>;
  deps: ChannelDeps;
  channel: ChannelAdapter;
  ingress: Ingress;
  watcher?: ResponseWatcher;
  healthProbe?: SynthHealthProbe;
}

/**
 * Собирает компоненты одного тенанта: состояние (изолированное по тенанту),
 * аутентификацию, клиент API, health, приём (ingress) и канал.
 *
 * Сетевых вызовов, кроме best-effort прогрева токена, не делает.
 */
async function buildTenant<TChannel>(
  config: GatewayConfig<TChannel>,
  options: GatewayOptions<TChannel>,
  tenant: TenantConfig<TChannel>,
  health: GatewayHealth,
  log: (message: string) => void,
  legacy: boolean,
): Promise<TenantRuntimeParts<TChannel>> {
  // Состояние тенанта: legacy `default` — в корне dataDir, остальные — в
  // `dataDir/tenants/<id>` (изоляция по тенантам, §4.3 контракта).
  const store = new FileStore(tenantStoreDir(config.dataDir, tenant.id, legacy));
  await store.init();
  const state = new StateStore(store);

  const auth = new AuthTokenProvider({
    serviceKey: tenant.synth.serviceKey,
    apiKey: tenant.synth.apiKey,
    oidc: tenant.synth.oidc,
    health,
    log,
  });
  health.setAuth(auth.mode);
  if (!config.dryRun && isOidcPartial(tenant.synth.oidc)) {
    log(
      '[gateway] OIDC настроен неполно (нужны token/discovery URL, client_id, client_secret) — используется API-ключ/без auth',
    );
  }
  // Best-effort прогрев токена: health-поле `token` не должно «врать» до первого
  // события. В dry-run сетевых вызовов нет — прогрев пропускается.
  if (!config.dryRun) void auth.check();

  const baseUrl = tenant.synth.baseUrl.trim() || options.defaults.synth.baseUrl;
  const synth = new SynthApi({
    baseUrl,
    apiKey: tenant.synth.apiKey,
    bearer: auth,
    log,
    health,
  });

  // Приём создаётся после канала: `source` события задаёт сам канал. Поэтому
  // `publish` закрывается на ссылку, которая заполняется сразу после сборки.
  const ingressRef: { current?: Ingress } = {};
  const deps: ChannelDeps = {
    state,
    synth,
    auth,
    health,
    log,
    publish: (message: InboundMessage) => publishMessage(ingressRef, log, message),
  };

  const channel = options.createChannel(tenant, deps);

  // Маршруты ведёт `Ingress`; рантайм читает их из того же состояния, чтобы
  // передать каналу адресата при отметке «прочитано».
  const routes = new RecordStore<SessionRoute>(state, ROUTES_BUCKET);

  const ingress = new Ingress({
    api: synth,
    state,
    allowlist: tenant.allowlist,
    unknownAction: tenant.unknownAction,
    source: channel.source,
    log,
    health,
    onIdentityHint: (code, message) => notifyIdentityHint(channel, log, code, message),
    markRead: (message) => markInboundRead(channel, routes, log, message),
  });
  ingressRef.current = ingress;

  const watchEnabled = config.watch && (tenant.watch ?? options.defaults.watch);
  const watcher =
    watchEnabled && !config.dryRun
      ? new ResponseWatcher({
          baseUrl,
          apiKey: tenant.synth.apiKey,
          bearer: auth,
          channel,
          state,
          log,
          health,
        })
      : undefined;

  const healthProbe = config.dryRun
    ? undefined
    : new SynthHealthProbe({
        baseUrl,
        // `/health` публичный, но ключ передаём для единообразия авторизации:
        // приоритет — service-key (ADR-052), иначе legacy api-key.
        apiKey: tenant.synth.serviceKey ?? tenant.synth.apiKey,
        health,
        log,
      });

  return {
    tenant,
    deps,
    channel,
    ingress,
    ...(watcher ? { watcher } : {}),
    ...(healthProbe ? { healthProbe } : {}),
  };
}

/**
 * Мост «входящее сообщение → публикация в Synth».
 *
 * Отказ политики ядра (`rejected`) и ошибка публикации (`failed`) **не**
 * пробрасываются в канал: канал не должен падать из-за политики ядра —
 * сообщение просто не публикуется (`sessionId: null`).
 */
async function publishMessage(
  ingressRef: { current?: Ingress },
  log: (message: string) => void,
  message: InboundMessage,
): Promise<PublishResult> {
  const ingress = ingressRef.current;
  if (!ingress) {
    log('[gateway] публикация отклонена: приём не инициализирован');
    return { sessionId: null };
  }
  const outcome = await ingress.handle(message);
  if (outcome.status === 'published') {
    return {
      sessionId: outcome.sessionId,
      ...(outcome.identityHint ? { identityHint: outcome.identityHint } : {}),
    };
  }
  if (outcome.status === 'rejected') {
    log(`[gateway] входящее сообщение не опубликовано: ${outcome.reason}`);
    return { sessionId: null };
  }
  log(`[gateway] входящее сообщение не опубликовано: ${describeError(outcome.error)}`);
  return { sessionId: null };
}

/**
 * Передаёт код линковки каналу (claim-flow ADR-089).
 *
 * Если канал умеет `notify` — код уходит адресату сообщения. Если не умеет —
 * код пишется в лог тенанта (код линковки не секрет: он и предназначен для
 * отправки отправителю).
 */
async function notifyIdentityHint(
  channel: ChannelAdapter,
  log: (message: string) => void,
  code: string,
  message: InboundMessage,
): Promise<void> {
  if (channel.notify) {
    await channel.notify({
      target: message.target,
      text: `Код линковки с учётной записью Synth: ${code}`,
      claimCode: code,
    });
    return;
  }
  log(`[gateway] код линковки (канал не поддерживает уведомления): ${code}`);
}

/**
 * Помечает входящее сообщение прочитанным (`channel.markRead`).
 *
 * Вызывается ядром **после** успешной публикации сообщения. Маршрут
 * («сессия → адресат в канале») берётся из состояния, которое ведёт `Ingress`:
 * к моменту вызова маршрут уже записан.
 *
 * Ошибка канала обработке не мешает: лог + продолжение (сообщение уже
 * опубликовано, повторная публикация не нужна).
 */
async function markInboundRead(
  channel: ChannelAdapter,
  routes: RecordStore<SessionRoute>,
  log: (message: string) => void,
  message: InboundMessage,
): Promise<void> {
  if (!channel.markRead) return;
  const route = await findInboundRoute(routes, message);
  if (!route) {
    log('[gateway] отметка «прочитано» пропущена: маршрут сообщения не найден');
    return;
  }
  try {
    await channel.markRead({
      route,
      ...(message.inboundMessageId !== undefined
        ? { inboundMessageId: message.inboundMessageId }
        : {}),
    });
  } catch (error) {
    log(`[gateway] не удалось пометить сообщение прочитанным: ${describeError(error)}`);
  }
}

/**
 * Ищет маршрут входящего сообщения в состоянии.
 *
 * Ключ маршрута — `sessionId`, а у сообщения его нет: сопоставляем по
 * `inboundMessageId` (id сообщения в канале), а если его нет — по адресату
 * (`target`). При нескольких совпадениях берём самый свежий (`updatedAt`).
 */
async function findInboundRoute(
  routes: RecordStore<SessionRoute>,
  message: InboundMessage,
): Promise<SessionRoute | undefined> {
  const all = Object.values(await routes.all());
  const target = JSON.stringify(message.target);
  const candidates = all.filter((route) => {
    if (message.inboundMessageId !== undefined) {
      return route.inboundMessageId === message.inboundMessageId;
    }
    return JSON.stringify(route.target) === target;
  });
  candidates.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
  return candidates[0];
}

/** Тело health-ответа по реестру тенантов. */
function healthBody(config: GatewayConfig<unknown>, registry: GatewayHealthRegistry): GatewayHealthBody {
  const { aggregate, tenants } = registry.snapshot();
  return {
    status: aggregate.status,
    version: config.version,
    source: GATEWAY_HEALTH_SOURCE,
    synth: aggregate.synth,
    channel: aggregate.channel,
    watcher: aggregate.watcher,
    auth: aggregate.auth,
    token: aggregate.token,
    tenants,
  };
}

/**
 * Hono-приложение health-сервера.
 *
 * `GET /health` (и алиас `GET /api/health`) — **без аутентификации**: пробы
 * деплоя не должны требовать секрет (инвариант 4 контракта).
 */
function createHealthApp(config: GatewayConfig<unknown>, registry: GatewayHealthRegistry): Hono {
  const app = new Hono();

  app.get('/health', (c) => c.json(healthBody(config, registry)));
  app.get('/api/health', (c) => c.json(healthBody(config, registry)));

  app.notFound((c) => c.json({ error: { code: 'not_found', message: 'Маршрут не найден' } }, 404));

  app.onError((error, c) => {
    console.error('[gateway] необработанная ошибка health-сервера:', error);
    return c.json({ error: { code: 'internal_error', message: 'Внутренняя ошибка' } }, 500);
  });

  return app;
}

/** Запущенный health-сервер. */
interface HealthServerHandle {
  server: Server;
  port: number;
  close: () => Promise<void>;
}

function toWebRequest(req: IncomingMessage): Request {
  const host = req.headers.host ?? 'localhost';
  const url = `http://${host}${req.url ?? '/'}`;
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    headers.set(key, Array.isArray(value) ? value.join(', ') : value);
  }
  const method = req.method ?? 'GET';
  const hasBody = method !== 'GET' && method !== 'HEAD';
  return new Request(url, {
    method,
    headers,
    body: hasBody ? (Readable.toWeb(req) as ReadableStream) : undefined,
    duplex: 'half',
  } as RequestInit);
}

async function handleRequest(
  app: Hono,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  try {
    const response = await app.fetch(toWebRequest(req), {});
    res.writeHead(response.status, Object.fromEntries(response.headers.entries()));
    if (response.body) {
      const reader = response.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(value);
      }
    }
    res.end();
  } catch (error) {
    console.error('[gateway] ошибка обработки запроса:', error);
    if (!res.headersSent) {
      res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
    }
    res.end(JSON.stringify({ error: { code: 'internal_error', message: 'Внутренняя ошибка' } }));
  }
}

/** Поднимает health-сервер на `config.host:config.port`. */
async function startHealthServer(
  config: GatewayConfig<unknown>,
  registry: GatewayHealthRegistry,
): Promise<HealthServerHandle> {
  const app = createHealthApp(config, registry);
  const server = createServer((req, res) => {
    void handleRequest(app, req, res);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, config.host, () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  const port =
    address !== null && typeof address === 'object' && typeof address.port === 'number'
      ? address.port
      : config.port;
  return {
    server,
    port,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/**
 * Поднимает HTTP-MCP-сервер (если заданы и набор тулов, и bearer-токен).
 *
 * MCP — необязательная часть: без токена сервер не поднимается (в лог уходит
 * предупреждение), чтобы канал мог работать без MCP-тулов.
 */
async function startMcpServer<TChannel>(
  config: GatewayConfig<TChannel>,
  options: GatewayOptions<TChannel>,
  parts: TenantRuntimeParts<TChannel>[],
  log: (message: string) => void,
): Promise<McpHttpServerHandle | undefined> {
  if (!options.createMcpTools) return undefined;
  const token = options.mcpToken?.trim();
  if (!token) {
    log('[gateway] MCP не поднят: не задан bearer-токен (options.mcpToken)');
    return undefined;
  }
  const tenants = new Map<string, McpToolset>();
  for (const part of parts) {
    const toolset = options.createMcpTools(part.tenant, part.deps);
    if (toolset) tenants.set(part.tenant.id, toolset);
  }
  if (tenants.size === 0) {
    log('[gateway] MCP не поднят: ни у одного тенанта нет набора инструментов');
    return undefined;
  }
  const handle = await startMcpHttpServer({
    tenants,
    token,
    port: options.mcpPort ?? DEFAULT_MCP_HTTP_PORT,
    version: options.version,
    log,
  });
  log(`[gateway] MCP (HTTP): порт ${handle.port}, тенантов ${tenants.size}`);
  return handle;
}

/**
 * Поднимает шлюз: health-сервер, компоненты тенантов, каналы, watcher'ы и
 * (опционально) HTTP-MCP. Остановка — {@link GatewayRuntime.stop}.
 */
export async function createGatewayRuntime<TChannel>(
  config: GatewayConfig<TChannel>,
  options: GatewayOptions<TChannel>,
): Promise<GatewayRuntime> {
  const log = createLogger(GATEWAY_LOG_PREFIX);
  const registry = new GatewayHealthRegistry();
  // Legacy-режим (без файла тенантов): тенант `default` пишет в корень dataDir.
  const legacy = config.tenantsFile === undefined;

  log(`[gateway] synth-gateway-core ${config.version}`);
  log(
    `[gateway] тенантов: ${config.tenants.length}${legacy ? ' (legacy default)' : ` (${config.tenantsFile})`}`,
  );
  log(`[gateway] данные: ${config.dataDir}`);

  // Health-сервер поднимаем ДО каналов: пробы деплоя не должны зависеть от
  // доступности внешнего мира.
  const healthServer = await startHealthServer(config, registry);
  log(`[gateway] health: http://${config.host}:${healthServer.port}/health`);

  const parts: TenantRuntimeParts<TChannel>[] = [];
  for (const tenant of config.tenants) {
    const health = registry.register(tenant.id);
    const tenantLog = createTenantLogger(tenant.id);
    const built = await buildTenant(config, options, tenant, health, tenantLog, legacy);
    parts.push(built);
    logTenantStartup(tenant, built.deps.auth.mode, tenantLog);
    built.healthProbe?.start();
  }

  const mcp = await startMcpServer(config, options, parts, log);

  // Демон: каналы принимают, watcher'ы раздают ответы.
  const watcherRuns: Promise<void>[] = [];
  for (const part of parts) {
    if (config.dryRun) {
      // Dry-run: наружу не подключаемся (достаточно, чтобы health отвечал).
      part.deps.health.setChannel('dry-run');
      part.deps.log(
        '[gateway] dry-run: канал не подключается наружу, watcher не запускается',
      );
      continue;
    }
    const ctx: ChannelContext = {
      publish: part.deps.publish,
      state: part.deps.state,
      synth: part.deps.synth,
      log: part.deps.log,
      health: part.deps.health,
      tenant: part.tenant,
    };
    try {
      await part.channel.start(ctx);
      part.deps.health.setChannel('ok');
      part.deps.log('[gateway] канал запущен');
    } catch (error) {
      // Ошибка канала не валит процесс: лог + health, остальные тенанты живы.
      // `ChannelStatus` не имеет значения `down` (см. `health.ts`), поэтому
      // неработающий канал помечается как `unknown` → агрегат `degraded`.
      part.deps.health.setChannel('unknown');
      part.deps.log(`[gateway] канал не запустился: ${describeError(error)}`);
      continue;
    }
    if (part.watcher) {
      watcherRuns.push(part.watcher.run());
    }
  }

  let stopped = false;
  let resolveDone: () => void = () => {};
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve;
  });

  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    log('[gateway] останавливаю каналы и watcher\'ы');
    for (const part of parts) {
      try {
        await part.watcher?.stop();
      } catch (error) {
        part.deps.log(`[gateway] ошибка остановки watcher: ${describeError(error)}`);
      }
      try {
        await part.channel.stop();
      } catch (error) {
        part.deps.log(`[gateway] ошибка остановки канала: ${describeError(error)}`);
      }
      part.healthProbe?.stop();
    }
    await Promise.race([
      Promise.allSettled(watcherRuns),
      // Страховка: «зависший» watcher не должен держать остановку процесса.
      new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, WATCHER_STOP_TIMEOUT_MS);
        timer.unref?.();
      }),
    ]);    if (mcp) {
      try {
        await mcp.close();
      } catch (error) {
        log(`[gateway] ошибка остановки MCP-сервера: ${describeError(error)}`);
      }
    }
    try {
      await healthServer.close();
    } catch (error) {
      log(`[gateway] ошибка остановки health-сервера: ${describeError(error)}`);
    }
    resolveDone();
  };

  return {
    health: registry,
    healthPort: healthServer.port,
    ...(mcp ? { mcpPort: mcp.port } : {}),
    done,
    stop,
  };
}

/**
 * Запускает шлюз в демоне и держит процесс до сигнала остановки.
 *
 * `SIGINT`/`SIGTERM` (или `options.signals`) → корректная остановка: watcher'ы,
 * каналы, health-проба, health-сервер и MCP-сервер. Промис резолвится после
 * полной остановки.
 */
export async function runGateway<TChannel>(
  config: GatewayConfig<TChannel>,
  options: GatewayOptions<TChannel>,
): Promise<void> {
  const runtime = await createGatewayRuntime(config, options);
  const log = createLogger(GATEWAY_LOG_PREFIX);
  const signals = options.signals ?? (['SIGINT', 'SIGTERM'] as NodeJS.Signals[]);
  const handlers = new Map<NodeJS.Signals, () => void>();

  for (const signal of signals) {
    const handler = (): void => {
      log(`[gateway] получен ${signal} — завершаю работу`);
      void runtime.stop();
    };
    handlers.set(signal, handler);
    process.on(signal, handler);
  }

  try {
    await runtime.done;
  } finally {
    for (const [signal, handler] of handlers) process.off(signal, handler);
  }
}
