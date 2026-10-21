import { join } from 'node:path';

/**
 * Конфигурация ядра шлюза: env-хелперы, список доступа, разбор `tenants.json`
 * (ADR-103, §4.4 контракта).
 *
 * Приоритет значений (в целом для шлюза): CLI-флаг > env > `secrets/` > дефолт.
 * Пустая/whitespace-строка env = отсутствие значения ({@link envOr}).
 */

/**
 * Читает переменную окружения, считая пустую/whitespace-only строку отсутствием
 * значения. Это важно для opencode: подстановка `{env:VAR}` при незаданной
 * переменной даёт **пустую строку**, а не `undefined`, поэтому голый `??` не
 * срабатывает и значение превращается в `''`.
 *
 * При наличии значения возвращается `trim()`-результат, иначе — `fallback`.
 */
export function envOr(env: NodeJS.ProcessEnv, key: string): string | undefined;
export function envOr(env: NodeJS.ProcessEnv, key: string, fallback: string): string;
export function envOr(env: NodeJS.ProcessEnv, key: string, fallback?: string): string | undefined {
  const raw = env[key];
  if (raw === undefined) return fallback;
  const value = raw.trim();
  return value.length > 0 ? value : fallback;
}

/** Разбирает булево значение env: `1/true/yes/on` → `true`, `0/false/no/off` → `false`. */
export function parseBool(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return undefined;
}

/** Разбирает строго положительное целое из env; иначе — `undefined`. */
export function parsePositiveInt(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isNaN(parsed) || parsed <= 0 ? undefined : parsed;
}

/**
 * Разбирает строку списка доступа `key:ROLE,key2:ROLE` в объект `key → роль`.
 *
 * Разделитель — **последний** `:` (адреса почты и подобные ключи содержат `:`).
 * Пустые элементы и пары без ключа/роли игнорируются; роли нормализуются в
 * верхний регистр.
 */
export function parseAllowlist(value: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const entry of value.split(',')) {
    const item = entry.trim();
    if (!item) continue;
    const separator = item.lastIndexOf(':');
    if (separator <= 0) continue;
    const key = item.slice(0, separator).trim();
    const role = item
      .slice(separator + 1)
      .trim()
      .toUpperCase();
    if (!key || !role) continue;
    result[key] = role;
  }
  return result;
}

/**
 * Политика шлюза для отправителя, не сопоставленного с учётной записью Synth
 * (ADR-089: чат — routing, человек — ownership/attribution).
 *
 * «Известность» отправителя резолвится **на стороне ядра**: `register` —
 * публиковать как есть, `hint` — публиковать и отдать каналу код линковки,
 * `reject` — не публиковать.
 */
export type UnknownAction = 'register' | 'hint' | 'reject';

/** Значение по умолчанию: событие публикуется, владельца/автора решает ядро. */
export const DEFAULT_UNKNOWN_ACTION: UnknownAction = 'register';

/** Допустимые значения политики неизвестного отправителя. */
export const UNKNOWN_ACTION_VALUES: readonly UnknownAction[] = ['register', 'hint', 'reject'];

/**
 * Нормализует значение политики: регистр/пробелы игнорируются, неизвестное
 * значение (в т.ч. пустое/`undefined`) → {@link DEFAULT_UNKNOWN_ACTION}.
 */
export function parseUnknownAction(value: string | undefined): UnknownAction {
  const normalized = value?.trim().toLowerCase();
  return UNKNOWN_ACTION_VALUES.find((action) => action === normalized) ?? DEFAULT_UNKNOWN_ACTION;
}

/**
 * Конфигурация OIDC client-credentials (OIDC-провайдер,
 * статический API-ключ не принимается).
 */
export interface OidcAuthConfig {
  /** Прямой URL token-эндпоинта (`SYNTH_OIDC_TOKEN_URL`). */
  tokenUrl?: string;
  /** URL discovery `/.well-known/openid-configuration`; из него берётся `token_endpoint`. */
  discoveryUrl?: string;
  clientId?: string;
  clientSecret?: string;
  /** Необязательный scope (например, `openid`). */
  scope?: string;
}

/** Подключение тенанта к API v2 Synth. */
export interface SynthConnectionConfig {
  /** Базовый URL API v2 (например, `http://127.0.0.1:5000/api/v2`). */
  baseUrl: string;
  /** Scoped service-key `synth_svc_…` (ADR-052) — приоритетная аутентификация. */
  serviceKey?: string;
  /** Служебный Bearer-ключ (`SYNTH_API_KEY`) — legacy-fallback. */
  apiKey?: string;
  /** OIDC client-credentials (managed-режим). */
  oidc: OidcAuthConfig;
}

/**
 * Схема канальной секции записи тенанта.
 *
 * Канал объявляет собственные ключи записи (`keys`) и разбирает их сам
 * (`parse`): ядро знает только общие ключи и отвергает всё, что не объявлено
 * ни ядром, ни каналом (fail-fast — опечатка не должна тихо увести тенант на
 * чужой инстанс Synth).
 */
export interface ChannelTenantSchema<TChannel> {
  /** Ключи канала в записи тенанта. */
  readonly keys: readonly string[];
  /** Разбирает канальные поля записи тенанта. */
  parse(
    raw: Record<string, unknown>,
    context: string,
    defaults: GatewayDefaults<TChannel>,
  ): TChannel;
}

/**
 * Глобальные дефолты (env/CLI/`secrets/`), подставляемые тенантам без своих
 * полей.
 */
export interface GatewayDefaults<TChannel> {
  /** Подключение к Synth API. */
  synth: SynthConnectionConfig;
  /** Список доступа `ключ → роль`. */
  allowlist: Record<string, string>;
  /** Политика неизвестного отправителя. */
  unknownAction: UnknownAction;
  /** Поднимать ли watcher ответов агента (SSE). */
  watch: boolean;
  /** Конфигурация канала по умолчанию. */
  channel: TChannel;
}

/**
 * Конфигурация одного тенанта (канал → среда Synth).
 *
 * Поля, не заданные в `tenants.json` для тенанта, берутся из глобальных
 * дефолтов (env/CLI/`secrets/`).
 */
export interface TenantConfig<TChannel> {
  /** Ключ тенанта (`[a-z0-9][a-z0-9_-]*`); уникален в пределах процесса. */
  id: string;
  /** Конфигурация канала (канал-специфична). */
  channel: TChannel;
  /** Подключение к Synth API. */
  synth: SynthConnectionConfig;
  /** Список доступа: `ключ → роль` (`ADMIN`/`USER`/`LEAD`/`AUDITOR`). */
  allowlist: Record<string, string>;
  /** Политика отправителя, не сопоставленного с учётной записью Synth. */
  unknownAction: UnknownAction;
  /** Поднимать ли watcher ответов агента (SSE). */
  watch: boolean;
}

/** Ключ тенанта по умолчанию в legacy-режиме (без `tenants.json`). */
export const DEFAULT_TENANT_ID = 'default';

/** Допустимый id тенанта: `[a-z0-9][a-z0-9_-]*`. */
export const TENANT_ID_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;

/**
 * Каталог состояния тенанта. Legacy `default` пишет в корень `dataDir` (без
 * миграции существующего состояния); остальные тенанты изолированы подкаталогом
 * `dataDir/tenants/<id>`.
 */
export function tenantStoreDir(dataDir: string, tenantId: string, legacy: boolean): string {
  return legacy && tenantId === DEFAULT_TENANT_ID ? dataDir : join(dataDir, 'tenants', tenantId);
}

/** Общие ключи записи тенанта (ядро). Канальные ключи задаёт `schema.keys`. */
const CORE_TENANT_KEYS = new Set([
  'id',
  'synthUrl',
  'synth',
  'serviceKey',
  'apiKey',
  'oidcTokenUrl',
  'oidcDiscoveryUrl',
  'oidcClientId',
  'oidcClientSecret',
  'oidcScope',
  'allowlist',
  'unknownAction',
  'watch',
]);

/** Допустимые поля вложенного объекта `synth` в записи тенанта. */
const TENANT_SYNTH_ALLOWED_KEYS = new Set(['url']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Строка-значение поля: `undefined`/`null` — нет значения, пустая строка — нет значения. */
function optionalString(value: unknown, context: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw new Error(`${context}: ожидается строка`);
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/** Булево поле: `undefined` — нет значения, иначе строго булево. */
function optionalBoolean(value: unknown, context: string): boolean | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'boolean') throw new Error(`${context}: ожидается boolean`);
  return value;
}

/** Список доступа в объектной форме `{ "<ключ>": "ROLE" }`; роли → верхний регистр. */
function parseAllowlistObject(
  value: Record<string, unknown>,
  context: string,
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, role] of Object.entries(value)) {
    if (typeof role !== 'string' || !role.trim()) {
      throw new Error(`${context}: роль «${key}» должна быть непустой строкой`);
    }
    result[key] = role.trim().toUpperCase();
  }
  return result;
}

/**
 * Список доступа тенанта: строковая форма `key:ROLE,…` или объектная
 * `{ "<ключ>": "ROLE" }`. Любое иное значение — ошибка конфигурации.
 */
export function parseTenantAllowlist(value: unknown, context: string): Record<string, string> {
  if (typeof value === 'string') return parseAllowlist(value);
  if (isRecord(value)) return parseAllowlistObject(value, context);
  throw new Error(`${context}: allowlist должен быть строкой «key:ROLE,…» или объектом`);
}

/** Убирает завершающие слэши базового URL. */
function stripTrailingSlash(url: string): string {
  return url.replace(/\/+$/, '');
}

/**
 * Разбирает и валидирует одну запись тенанта из `tenants.json`.
 *
 * Строгая валидация (fail-fast): неизвестные поля — ошибка (опечатка поля
 * среды — `syntUrl` вместо `synthUrl` — иначе молча увела бы тенант на
 * чужой/dev Synth). Поля, не заданные явно, берутся из глобальных дефолтов.
 */
function parseTenantEntry<TChannel>(
  raw: unknown,
  index: number,
  schema: ChannelTenantSchema<TChannel>,
  defaults: GatewayDefaults<TChannel>,
): TenantConfig<TChannel> {
  const position = `tenants.json: тенант #${index + 1}`;
  if (!isRecord(raw)) throw new Error(`${position}: ожидается объект`);

  const allowedKeys = new Set<string>([...CORE_TENANT_KEYS, ...schema.keys]);
  for (const key of Object.keys(raw)) {
    if (!allowedKeys.has(key)) {
      const allowed = [...allowedKeys].sort().join(', ');
      throw new Error(`${position}: неизвестное поле «${key}» (допустимые поля: ${allowed})`);
    }
  }

  const id = optionalString(raw.id, `${position}: id`);
  if (!id) throw new Error(`${position}: отсутствует обязательное поле «id»`);
  const context = `tenants.json: тенант «${id}»`;
  if (!TENANT_ID_PATTERN.test(id)) {
    throw new Error(`${context}: недопустимый id (ожидается [a-z0-9][a-z0-9_-]*)`);
  }

  let synthUrlFromObject: string | undefined;
  if (raw.synth !== undefined && raw.synth !== null) {
    if (!isRecord(raw.synth))
      throw new Error(`${context}: поле «synth» должно быть объектом { url }`);
    for (const key of Object.keys(raw.synth)) {
      if (!TENANT_SYNTH_ALLOWED_KEYS.has(key)) {
        throw new Error(`${context}: поле «synth»: неизвестное поле «${key}»`);
      }
    }
    synthUrlFromObject = optionalString(raw.synth.url, `${context}: synth.url`);
  }

  const baseUrl = stripTrailingSlash(
    optionalString(raw.synthUrl, `${context}: synthUrl`) ??
      synthUrlFromObject ??
      defaults.synth.baseUrl,
  );

  const oidc: OidcAuthConfig = {
    tokenUrl:
      optionalString(raw.oidcTokenUrl, `${context}: oidcTokenUrl`) ?? defaults.synth.oidc.tokenUrl,
    discoveryUrl:
      optionalString(raw.oidcDiscoveryUrl, `${context}: oidcDiscoveryUrl`) ??
      defaults.synth.oidc.discoveryUrl,
    clientId:
      optionalString(raw.oidcClientId, `${context}: oidcClientId`) ?? defaults.synth.oidc.clientId,
    clientSecret:
      optionalString(raw.oidcClientSecret, `${context}: oidcClientSecret`) ??
      defaults.synth.oidc.clientSecret,
    scope: optionalString(raw.oidcScope, `${context}: oidcScope`) ?? defaults.synth.oidc.scope,
  };

  const unknownAction =
    raw.unknownAction !== undefined && raw.unknownAction !== null
      ? parseUnknownAction(optionalString(raw.unknownAction, `${context}: unknownAction`))
      : defaults.unknownAction;

  return {
    id,
    channel: schema.parse(raw, context, defaults),
    synth: {
      baseUrl,
      serviceKey:
        optionalString(raw.serviceKey, `${context}: serviceKey`) ?? defaults.synth.serviceKey,
      apiKey: optionalString(raw.apiKey, `${context}: apiKey`) ?? defaults.synth.apiKey,
      oidc,
    },
    allowlist:
      raw.allowlist !== undefined && raw.allowlist !== null
        ? parseTenantAllowlist(raw.allowlist, context)
        : defaults.allowlist,
    unknownAction,
    watch: optionalBoolean(raw.watch, `${context}: watch`) ?? defaults.watch,
  };
}

/**
 * Разбирает и валидирует содержимое `tenants.json` (`{ "tenants": [ … ] }`).
 *
 * Ошибки: не объект, лишние поля верхнего уровня, пустой/отсутствующий массив,
 * неизвестное поле записи (ядра или канала), дублирующийся `id`.
 */
export function parseTenantsFile<TChannel>(
  raw: unknown,
  schema: ChannelTenantSchema<TChannel>,
  defaults: GatewayDefaults<TChannel>,
): TenantConfig<TChannel>[] {
  if (!isRecord(raw)) throw new Error('tenants.json: ожидается объект { "tenants": [ … ] }');
  for (const key of Object.keys(raw)) {
    if (key !== 'tenants') throw new Error(`tenants.json: неизвестное поле «${key}»`);
  }
  const list = raw.tenants;
  if (!Array.isArray(list) || list.length === 0) {
    throw new Error('tenants.json: поле «tenants» должно быть непустым массивом');
  }
  const tenants = list.map((entry, index) => parseTenantEntry(entry, index, schema, defaults));
  const seen = new Set<string>();
  for (const tenant of tenants) {
    if (seen.has(tenant.id)) {
      throw new Error(`tenants.json: повторяющийся id тенанта «${tenant.id}»`);
    }
    seen.add(tenant.id);
  }
  return tenants;
}
