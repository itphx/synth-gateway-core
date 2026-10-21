/**
 * MCP-сервер шлюза (ADR-103, §4.6 контракта пакета).
 *
 * Ядро **не знает** про конкретные инструменты канала: их задаёт шлюз через
 * {@link McpToolset} (`list()` / `call(name, args, extra)`), ядро только
 * регистрирует их в MCP-сервере и приводит результат к формату SDK
 * (AD-046/AD-071):
 *
 * - успех — JSON в `content` + машинно-читаемый `structuredContent`;
 * - ошибка — `isError: true`, в тексте машинный код ошибки (если он есть),
 *   чтобы агент мог ветвиться по коду, а не по тексту.
 *
 * Метаданные запроса (`extra._meta`) пробрасываются в канал: по ключу
 * {@link SESSION_ID_META_KEY} канал узнаёт id сессии Synth, в контексте которой
 * вызван инструмент (нужно для ответа «в текущий чат» без явного адресата).
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type { McpToolExtra, McpToolResult, McpToolset } from './toolset.js';

/**
 * Ключ `_meta` с id сессии Synth — контракт ядра Synth (ADR-089) с внешними
 * MCP-серверами: `client.callTool(..., { 'synth/session_id': sessionId })`.
 */
export const SESSION_ID_META_KEY = 'synth/session_id';

/** Опции MCP-сервера шлюза. */
export interface McpServerOptions {
  /** Набор инструментов тенанта (задаёт канал). */
  toolset: McpToolset;
  /** Имя MCP-сервера (неймспейс тулов в Synth: `<server>_<tool>`). */
  name: string;
  /** Версия пакета. */
  version: string;
  /** Логгер (по умолчанию — тихий; без секретов). */
  log?: (message: string) => void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Оборачивает произвольный результат инструмента в формат MCP: JSON в
 * `content` + `structuredContent` (для не-объектов — под ключом `result`).
 */
export function toolResult(data: unknown): McpToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
    structuredContent: isRecord(data) ? data : { result: data },
  };
}

/**
 * Ошибка инструмента: `isError: true`, в тексте — машинный код (если он есть)
 * и человекочитаемое сообщение. Агенту нужен и код (для ветвления), и текст.
 */
export function toolError(error: unknown): McpToolResult {
  const message = error instanceof Error ? error.message : String(error);
  const code = isRecord(error) && typeof error.code === 'string' ? error.code : undefined;
  const text = code && !message.startsWith(code) ? `${code}: ${message}` : message;
  return { content: [{ type: 'text', text }], isError: true };
}

/**
 * Извлекает id сессии Synth из `_meta` MCP-запроса (контракт
 * {@link SESSION_ID_META_KEY}). Это метаданные запроса, а не `extra.sessionId`
 * MCP-транспорта.
 */
export function sessionIdFromMeta(meta: unknown): string | undefined {
  if (!isRecord(meta)) return undefined;
  const value = meta[SESSION_ID_META_KEY];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

/**
 * Вызывает инструмент набора по имени.
 *
 * Имя проверяется по списку инструментов: неизвестное имя → понятная ошибка со
 * списком доступных (агент и оператор видят, что доступно на самом деле).
 */
export async function callTool(
  toolset: McpToolset,
  name: string,
  args: unknown,
  extra?: McpToolExtra,
): Promise<McpToolResult> {
  const tools = toolset.list();
  if (!tools.some((tool) => tool.name === name)) {
    const available = tools.map((tool) => tool.name).join(', ') || 'нет';
    throw new Error(`Неизвестный инструмент «${name}». Доступные: ${available}`);
  }
  return toolset.call(name, args, extra);
}

/** Приводит ответ инструмента к формату MCP (уже готовый — без изменений). */
function normalizeResult(value: unknown): McpToolResult {
  if (isRecord(value) && Array.isArray(value.content)) {
    return value as McpToolResult;
  }
  return toolResult(value);
}

/**
 * Создаёт MCP-сервер шлюза с инструментами канала.
 *
 * Имена тулов неймспейсятся Synth как `<имя MCP-сервера>_<имя тула>`; сами
 * имена и описания задаёт канал в {@link McpToolset}.
 */
export function createMcpServer(options: McpServerOptions): McpServer {
  const { toolset, name, version } = options;
  const log = options.log ?? (() => {});
  const server = new McpServer({ name, version });

  for (const tool of toolset.list()) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputSchema,
      },
      async (args, extra) => {
        try {
          return normalizeResult(await callTool(toolset, tool.name, args, extra));
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          log(`[gateway][mcp] ошибка инструмента «${tool.name}»: ${message}`);
          return toolError(error);
        }
      },
    );
  }

  return server;
}
