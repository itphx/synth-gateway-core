/**
 * MCP-транспорт шлюза по **Streamable HTTP** (AD-046/AD-071, ADR-103 §4.6).
 *
 * Зачем: в K8s stdio-MCP не работает (движок не спавнит процесс шлюза) —
 * Synth подключает MCP-сервер по HTTP (`mcp.servers.<name>.type: http`).
 *
 * **Stateless.** HTTP-транспорт работает без MCP-сессий: на каждый запрос
 * создаётся свежий `McpServer` + `StreamableHTTPServerTransport`
 * (`sessionIdGenerator: undefined`), session id не выдаётся, заголовок
 * `mcp-session-id` не используется и не валидируется, ресурсы закрываются по
 * завершении ответа. Тулы шлюза stateless, поэтому рестарт пода не ломает уже
 * подключённые клиенты: старый `mcp-session-id` просто игнорируется, а не даёт
 * 404.
 *
 * Мультитенантность: путь `/mcp/<tenantId>` — набор инструментов тенанта
 * берётся из карты «тенант → набор тулов», которую передаёт шлюз (ядро не знает
 * про `tenants.json`). Неизвестный тенант → 404. Всё на одном порту.
 *
 * Auth: bearer-токен клиентов MCP (`GATEWAY_MCP_TOKEN` / `secrets/mcp_token`);
 * нет/неверный токен → 401. Секрет — параметр чарта (Secret), в git не хранится
 * и в логи не попадает.
 *
 * `GET /health` — без аутентификации (пробы деплоя).
 */

import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

import { createMcpServer } from './server.js';
import type { McpToolset } from './toolset.js';

/** Порт HTTP-MCP по умолчанию (следующий после health-сервера шлюза). */
export const DEFAULT_MCP_HTTP_PORT = 7101;

/** Префикс пути MCP-эндпоинта: `/mcp/<tenantId>`. */
export const MCP_PATH_PREFIX = '/mcp/';

/** Имя MCP-сервера по умолчанию (неймспейс тулов в Synth). */
export const DEFAULT_MCP_SERVER_NAME = 'synth-gateway';

/** Опции HTTP-MCP-сервера. */
export interface McpHttpOptions {
  /** Тенанты шлюза: id → набор инструментов. */
  tenants: ReadonlyMap<string, McpToolset>;
  /** Bearer-токен клиентов MCP (обязателен; пустой → ошибка старта). */
  token: string;
  /** Адрес прослушивания (по умолчанию `0.0.0.0`). */
  host?: string;
  /** Порт (по умолчанию {@link DEFAULT_MCP_HTTP_PORT}). */
  port?: number;
  /** Версия пакета (в ответе `/health`). */
  version?: string;
  /** Имя MCP-сервера (неймспейс тулов в Synth). */
  name?: string;
  /** Логгер (по умолчанию — тихий; без секретов). */
  log?: (message: string) => void;
}

/** Хендл запущенного HTTP-MCP-сервера. */
export interface McpHttpServerHandle {
  server: Server;
  /** Фактический порт (для `port: 0` — назначенный ОС). */
  port: number;
  /** Остановка: закрыть сервер. */
  close: () => Promise<void>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** JSON-ответ с единым форматом ошибки `{ error: { code, message } }`. */
function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

/**
 * Сравнение bearer-токена в постоянном времени.
 *
 * Сравниваются SHA-256-дайджесты: `timingSafeEqual` требует одинаковой длины,
 * а сравнение «сырых» строк с ранним выходом по длине выдавало бы длину
 * секрета. Дайджесты фиксированной длины — утечки длины нет.
 */
export function isAuthorized(header: string | undefined, token: string): boolean {
  if (!header) return false;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (!match?.[1]) return false;
  const provided = createHash('sha256').update(match[1], 'utf8').digest();
  const expected = createHash('sha256').update(token, 'utf8').digest();
  return timingSafeEqual(provided, expected);
}

/**
 * Извлекает id тенанта из пути `/mcp/<id>`; иначе `undefined`.
 *
 * Вложенный путь (`/mcp/dev/messages`) и неизвестный тенант → `undefined`.
 */
export function parseTenantPath(path: string, knownIds: ReadonlySet<string>): string | undefined {
  if (!path.startsWith(MCP_PATH_PREFIX)) return undefined;
  const rest = path.slice(MCP_PATH_PREFIX.length);
  if (!rest || rest.includes('/')) return undefined;
  let id: string;
  try {
    id = decodeURIComponent(rest);
  } catch {
    return undefined;
  }
  return knownIds.has(id) ? id : undefined;
}

/** Обработчик запросов HTTP-MCP + освобождение ресурсов. */
export interface McpHttpHandler {
  /** Слушатель `node:http` (seam для тестов без bind порта). */
  handler: (req: IncomingMessage, res: ServerResponse) => void;
  /** Освобождает ресурсы (в ядре — заглушка: состояние живёт в шлюзе). */
  close: () => void;
}

/**
 * Создаёт обработчик HTTP-запросов HTTP-MCP: маршрутизация по тенанту, auth,
 * health.
 */
export function createMcpHttpHandler(options: McpHttpOptions): McpHttpHandler {
  const { token } = options;
  const log = options.log ?? (() => {});
  const version = options.version ?? '0.0.0';
  const name = options.name ?? DEFAULT_MCP_SERVER_NAME;
  const tenantIds = new Set(options.tenants.keys());

  /**
   * Stateless-обработка: свежие `McpServer` + транспорт на каждый запрос (SDK
   * запрещает переиспользование stateless-транспорта). Заголовок
   * `mcp-session-id` игнорируется — сессий нет, рестарт пода не ломает клиентов.
   * Ресурсы закрываются по завершении ответа (best-effort, без выброса).
   */
  const handleMcp = async (
    req: IncomingMessage,
    res: ServerResponse,
    tenantId: string,
  ): Promise<void> => {
    const toolset = options.tenants.get(tenantId);
    if (!toolset) throw new Error(`неизвестный тенант «${tenantId}»`);
    const server = createMcpServer({ toolset, name, version, log });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => {
      void transport.close().catch(() => {});
      void server.close().catch(() => {});
    });
    await server.connect(transport);
    await transport.handleRequest(req, res);
  };

  const handler = (req: IncomingMessage, res: ServerResponse): void => {
    const path = (req.url ?? '/').split('?')[0] ?? '/';
    if (path === '/health') {
      sendJson(res, 200, {
        status: 'ok',
        version,
        transport: 'http',
        tenants: [...tenantIds],
      });
      return;
    }

    if (!isAuthorized(req.headers.authorization, token)) {
      log(`[gateway][mcp] отказ 401: ${req.method ?? 'GET'} ${path}`);
      sendJson(res, 401, {
        error: { code: 'UNAUTHORIZED', message: 'Требуется Authorization: Bearer <MCP-токен>' },
      });
      return;
    }

    const tenantId = parseTenantPath(path, tenantIds);
    if (!tenantId) {
      sendJson(res, 404, {
        error: {
          code: 'NOT_FOUND',
          message: `Неизвестный тенант: ожидается /mcp/<tenantId>, известные — ${[...tenantIds].join(', ')}`,
        },
      });
      return;
    }

    void handleMcp(req, res, tenantId).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      log(`[gateway][mcp] тенант ${tenantId}: ошибка обработки запроса: ${message}`);
      if (res.headersSent) {
        res.end();
        return;
      }
      sendJson(res, 500, { error: { code: 'INTERNAL_ERROR', message } });
    });
  };

  return {
    handler,
    close: () => {
      /* состояние тулов и клиентов живёт в шлюзе — ядро ничего не держит */
    },
  };
}

/**
 * Запускает HTTP-MCP-сервер (Streamable HTTP) с маршрутизацией `/mcp/<tenantId>`.
 * Пустой токен — ошибка конфигурации (fail-fast).
 */
export async function startMcpHttpServer(options: McpHttpOptions): Promise<McpHttpServerHandle> {
  const token = options.token?.trim();
  if (!token) {
    throw new Error(
      'HTTP-режим MCP требует bearer-токен: задайте GATEWAY_MCP_TOKEN (env) или secrets/mcp_token',
    );
  }
  const port = options.port ?? DEFAULT_MCP_HTTP_PORT;
  const host = options.host ?? '0.0.0.0';

  const mcpHandler = createMcpHttpHandler({
    ...options,
    token,
    host,
    port,
  });

  const server = createServer((req, res) => mcpHandler.handler(req, res));

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve();
    });
  });

  const address = server.address();
  const boundPort = isRecord(address) && typeof address.port === 'number' ? address.port : port;

  return {
    server,
    port: boundPort,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      mcpHandler.close();
    },
  };
}
