#!/usr/bin/env node
/**
 * CLI MCP-сервера шлюза (ADR-103, §4.6 контракта пакета).
 *
 * Режимы:
 *
 * - **stdio** (по умолчанию) — локальная разработка и подключение к движку
 *   (opencode): тулы тенанта по умолчанию (`defaultToolset`);
 * - **--http** — Streamable HTTP для K8s, где stdio недоступен: путь
 *   `/mcp/<tenantId>`, набор тулов берётся у шлюза (`tenants()`), доступ —
 *   по bearer-токену `GATEWAY_MCP_TOKEN` / `secrets/mcp_token`.
 *
 * Ядро не знает ни про `tenants.json`, ни про канал: наборы тулов приходят
 * колбэками от шлюза.
 *
 * В stdio-режиме stdout занят протоколом MCP — диагностика идёт в stderr.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { DEFAULT_MCP_HTTP_PORT, startMcpHttpServer } from './http.js';
import { createMcpServer } from './server.js';
import type { McpToolset } from './toolset.js';

/** Имя env-переменной с bearer-токеном HTTP-MCP. */
export const MCP_TOKEN_ENV = 'GATEWAY_MCP_TOKEN';

/** Имя файла с bearer-токеном HTTP-MCP в каталоге секретов. */
export const MCP_TOKEN_FILE = 'mcp_token';

/** Каталог секретов по умолчанию. */
export const DEFAULT_SECRETS_DIR = 'secrets';

/** Опции CLI MCP-сервера (задаёт шлюз). */
export interface McpCliOptions {
  /** Набор инструментов по тенантам (для HTTP-режима). */
  tenants: () => ReadonlyMap<string, McpToolset>;
  /** Набор инструментов тенанта по умолчанию (для stdio). */
  defaultToolset: () => McpToolset;
  /** Версия пакета. */
  version: string;
  /** Каталог с секретами (по умолчанию `secrets`). */
  secretsDir?: string;
  /** Имя MCP-сервера (неймспейс тулов в Synth). */
  name?: string;
  /** Логгер (по умолчанию — stderr; в stdio-режиме stdout недоступен). */
  log?: (message: string) => void;
}

/** Разобранные аргументы CLI. */
export interface McpCliArgs {
  /** Режим HTTP-транспорта (`--http`); по умолчанию — stdio. */
  http: boolean;
  host: string;
  port: number;
  help: boolean;
}

/**
 * Разбирает аргументы CLI (`--flag value` и `--flag=value`).
 *
 * Поддерживаются: `--http`, `--host`, `--port`, `--help`/`-h`.
 */
export function parseArgs(argv: string[]): McpCliArgs {
  let http = false;
  let host = '0.0.0.0';
  let port = DEFAULT_MCP_HTTP_PORT;
  let help = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] ?? '';
    const [flag, inline] = arg.includes('=') ? arg.split('=', 2) : [arg, undefined];
    const nextValue = (): string | undefined => inline ?? argv[(i += 1)];

    switch (flag) {
      case '--help':
      case '-h':
        help = true;
        break;
      case '--http':
        http = true;
        break;
      case '--host': {
        const value = nextValue();
        if (value) host = value;
        break;
      }
      case '--port': {
        const value = nextValue();
        const parsed = value ? Number.parseInt(value, 10) : undefined;
        if (parsed !== undefined && !Number.isNaN(parsed)) port = parsed;
        break;
      }
      default:
        break;
    }
  }

  return { http, host, port, help };
}

/**
 * Читает bearer-токен HTTP-MCP: env `GATEWAY_MCP_TOKEN` → файл
 * `secrets/mcp_token`. Пустая/whitespace-строка = отсутствие значения.
 */
export function readMcpToken(
  env: NodeJS.ProcessEnv = process.env,
  secretsDir: string = DEFAULT_SECRETS_DIR,
): string | undefined {
  const fromEnv = env[MCP_TOKEN_ENV];
  if (fromEnv !== undefined && fromEnv.trim()) return fromEnv.trim();
  try {
    const value = readFileSync(join(secretsDir, MCP_TOKEN_FILE), 'utf8').trim();
    return value.length > 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

/** Справка CLI. */
export function printHelp(log: (message: string) => void): void {
  log(
    [
      'synth-gateway-mcp — MCP-сервер шлюза Synth',
      '',
      'Использование (stdio — по умолчанию):',
      '  synth-gateway-mcp',
      '',
      'Использование (Streamable HTTP; для K8s, где stdio недоступен):',
      '  synth-gateway-mcp --http [--host 0.0.0.0] [--port 7101]',
      '',
      'Флаги:',
      '  --http        поднять Streamable HTTP-транспорт вместо stdio',
      '  --host HOST   адрес HTTP-сервера (по умолчанию 0.0.0.0)',
      '  --port N      порт HTTP-сервера (по умолчанию 7101)',
      '  --help, -h    эта справка',
      '',
      'HTTP-режим: GET /health — без auth; /mcp/<tenantId> — Authorization: Bearer <токен>.',
      `Токен: env ${MCP_TOKEN_ENV} или файл secrets/${MCP_TOKEN_FILE}.`,
    ].join('\n'),
  );
}

/**
 * Точка входа CLI: stdio (по умолчанию) или HTTP-режим.
 *
 * Ошибки (в т.ч. отсутствие bearer-токена в HTTP-режиме) — понятное сообщение
 * и ненулевой код возврата.
 */
export async function main(argv: string[], options: McpCliOptions): Promise<void> {
  // stdout в stdio-режиме занят протоколом MCP — диагностика идёт в stderr.
  const log = options.log ?? ((message: string) => console.error(message));
  const args = parseArgs(argv);
  if (args.help) {
    printHelp(log);
    return;
  }

  const name = options.name ?? 'synth-gateway';

  if (!args.http) {
    const server = createMcpServer({
      toolset: options.defaultToolset(),
      name,
      version: options.version,
      log,
    });
    log(`[gateway][mcp] ${name} ${options.version}: stdio-режим`);
    const transport = new StdioServerTransport();
    await server.connect(transport);
    return;
  }

  const token = readMcpToken(process.env, options.secretsDir ?? DEFAULT_SECRETS_DIR);
  if (!token) {
    throw new Error(
      `HTTP-режим MCP требует bearer-токен: задайте ${MCP_TOKEN_ENV} (env) или secrets/${MCP_TOKEN_FILE}`,
    );
  }

  const tenants = options.tenants();
  log(
    `[gateway][mcp] ${name} ${options.version}: HTTP-MCP на http://${args.host}:${args.port}/mcp/<tenantId>; тенантов: ${tenants.size}`,
  );

  const handle = await startMcpHttpServer({
    tenants,
    token,
    host: args.host,
    port: args.port,
    version: options.version,
    name,
    log,
  });

  const shutdown = (signal: string): void => {
    log(`[gateway][mcp] получен ${signal} — останавливаю HTTP-MCP`);
    void handle.close().then(() => process.exit(0));
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}
