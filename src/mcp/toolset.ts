import type { z } from 'zod';

/**
 * Результат вызова MCP-инструмента. Формат — как у SDK: текстовое содержимое
 * плюс опциональный машинно-читаемый `structuredContent` и признак ошибки.
 */
export interface McpToolResult {
  content: { type: 'text'; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
  [key: string]: unknown;
}

/**
 * Контекст вызова инструмента: метаданные MCP-запроса. Шлюзы используют
 * `_meta.sessionId` — id сессии Synth, в контексте которой вызван инструмент
 * (нужен, чтобы отправить сообщение «в текущий чат» без явного адресата).
 */
export interface McpToolExtra {
  _meta?: Record<string, unknown>;
}

/**
 * Инструмент канала, регистрируемый в MCP-сервере шлюза. Имя тула
 * неймспейсится Synth как `<имя MCP-сервера>_<имя тула>`.
 */
export interface McpTool {
  /** Имя тула (без неймспейса сервера). */
  name: string;
  /** Краткое название для интерфейса. */
  title: string;
  /** Описание для модели — что делает тул и как им пользоваться. */
  description: string;
  /** Схема аргументов (raw shape из `zod`). */
  inputSchema: Record<string, z.ZodTypeAny>;
  /** Обработчик вызова. */
  handler: (args: unknown, extra?: McpToolExtra) => Promise<McpToolResult>;
}

/**
 * Набор инструментов канала для конкретного тенанта. Ядро регистрирует их в
 * MCP-сервере; сам канал определяет, что именно тулы умеют.
 */
export interface McpToolset {
  /** Список инструментов тенанта. */
  list(): McpTool[];
  /** Вызов инструмента по имени (для проверок и тестов). */
  call(name: string, args: unknown, extra?: McpToolExtra): Promise<McpToolResult>;
}
