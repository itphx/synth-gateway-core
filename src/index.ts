/**
 * Публичные экспорты ядра шлюзов Synth (`@itphx/synth-gateway-core`).
 *
 * Основание — [ADR-103](../../synth/docs/arch_decisions/adr-103-gateway-core-channel-contract.md)
 * (ядро ↔ канал), класс шлюза — [ADR-087](../../synth/docs/arch_decisions/adr-087-gateways.md).
 * Спецификация публичного API — [docs/contract.md](./docs/contract.md).
 *
 * ## Что экспортируется
 *
 * - **контракт канала** — `types.ts` (типы сообщения/доставки) и `channel.ts`
 *   (`ChannelAdapter`, `ChannelContext`);
 * - **ядро** — конфиг тенантов (`config.ts`), состояние (`store.ts`), клиент
 *   API v2 (`api.ts`), аутентификация (`auth.ts`), health (`health.ts`), приём
 *   (`ingress.ts`), доставка (`watcher.ts`), логирование (`logger.ts`),
 *   форматирование (`markdown.ts`);
 * - **MCP** — контракт тулов (`mcp/toolset.ts`), транспорт (`mcp/http.ts`),
 *   сервер (`mcp/server.ts`);
 * - **рантайм** — `runtime.ts` (`runGateway` — точка входа шлюза);
 * - **точки входа** — `mcp/cli.ts` и `installer.ts` экспортируются **под
 *   именами** (`mcpCli`, `installer`): у них одноимённые `main`/`parseArgs`,
 *   плоский реэкспорт дал бы двусмысленность.
 *
 * ## Правило имен
 *
 * `AuthMode` объявлен в `health.ts` (канон: режим попадает в снимок
 * `GET /health`) и реэкспортируется из `auth.ts`; здесь он экспортируется
 * **только** из `health.ts`, а `auth.ts` перечислен явно.
 */

// Контракт канала и доставки (граница «ядро ↔ канал»).
export * from './types.js';
export * from './channel.js';

// Конфигурация тенантов, env-хелперы, разбор `tenants.json`.
export * from './config.js';

// Состояние (атомарная запись, ADR-005).
export * from './store.js';

// Клиент API v2 Synth (события, привязки, сессии, пользователи).
export * from './api.js';

// Health-состояние и его агрегаты.
export * from './health.js';

// Аутентификация: `AuthMode` объявлен в `health.ts` (канон) и реэкспортируется
// из `auth.ts` — здесь перечисляем явно, чтобы не было двусмысленного экспорта.
export {
  AuthTokenProvider,
  DEFAULT_OIDC_TIMEOUT_MS,
  DEFAULT_REFRESH_MARGIN_SEC,
  isOidcConfigured,
  isOidcPartial,
} from './auth.js';
export type { AuthTokenProviderOptions, BearerProvider } from './auth.js';

// Приём (политика допуска/дедупа/маршрутизации) и доставка ответов (SSE).
export * from './ingress.js';
export * from './watcher.js';

// Логирование и форматирование текста.
export * from './logger.js';
export * from './markdown.js';

// MCP: контракт тулов, транспорт (Streamable HTTP) и сервер.
export * from './mcp/toolset.js';
export * from './mcp/http.js';
export * from './mcp/server.js';

// Рантайм-оркестрация (health-сервер, тенанты, каналы, watcher'ы, остановка).
export * from './runtime.js';

// Точки входа: CLI MCP и инсталлятор ресурсов — под именами (конфликт `main`).
export * as mcpCli from './mcp/cli.js';
export * as installer from './installer.js';
