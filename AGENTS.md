# synth-gateway-core — соглашения репозитория

> Короткий рабочий контракт для агентов. Назначение и поток данных — [README.md](./README.md),
> спецификация публичного API — [docs/contract.md](./docs/contract.md). Язык — русский.
> **Коммит — только по явной просьбе пользователя; новые зависимости — с разрешения.**

## Что это

Один npm-пакет (**не** pnpm-workspace) — **ядро шлюзов** Synth: общая часть
внешних сервисов-мостов (Gateway, ADR-087). Пакет **не** реализует ни одного
канала: он задаёт контракт канала (`ChannelAdapter`) и реализует всё
канал-независимое — политику приёма, доставку ответов (SSE), конфиг тенантов,
состояние, аутентификацию в API Synth, MCP-транспорт, инсталлятор ресурсов,
health, логирование.

Основания: [ADR-103](../../synth/docs/arch_decisions/adr-103-gateway-core-channel-contract.md)
(ядро ↔ канал), [ADR-087](../../synth/docs/arch_decisions/adr-087-gateways.md)
(класс Gateway), [ADR-089](../../synth/docs/arch_decisions/adr-089-external-events-automation.md)
(внешние события, Binding, claim-flow), [ADR-052](../../synth/docs/arch_decisions/adr-052-public-api-platform.md)
(service-key, scopes).

## Инварианты (не нарушать)

1. **Fail-closed allowlist.** Отправитель вне списка доступа → событие не
   публикуется вовсе (`Ingress`: `rejected: 'not_allowed'`).
2. **Идемпотентность.** Вход дедуплицируется по `dedupKey` (персистентно);
   исходящие — по `stream:<streamId>` / `message:<sessionId>:<index>`
   (персистентно, ключ ставится **до** фактической отправки).
3. **Секреты — вне git и не в логах.** В логах только факт «задан/не задан»
   (`describeSecret`). Логи шлюза с префиксом `[gateway]`, в тенантном режиме —
   `[gateway][<tenantId>]`.
4. **`GET /health` — без auth.** Пробы деплоя не должны требовать секрет.
5. **Атомарная запись состояния** — `*.tmp.<uuid>` → `rename()` (ADR-005).
6. **Ядро не знает про wire-протокол; канал не знает про API Synth** (кроме
   `ctx.publish`). Нарушение этого правила означает, что в ядро попал
   канал-специфичный код.
7. **LLM внутрь шлюза не тянется** — понимание/генерация — движок Synth.
8. **Канал не валит ядро.** Ошибка `channel.start` — лог + `health`, процесс
   живёт; отказ политики приёма приходит в `ctx.publish` как
   `{ sessionId: null }`, а не как исключение.
9. **Health-сервер поднимается ДО каналов** — пробы деплоя не зависят от
   доступности внешнего мира.
10. **Политика приёма не дублируется в канале.** Allowlist, дедуп, маршрут,
    политика неизвестного отправителя, claim-flow — в ядре (`ingress.ts`).
11. **Коммит — только по явной просьбе**; новые зависимости — с разрешения.
12. **Комментарии и doc-комментарии — на русском** (кроме `README.en.md`).
    Идентификаторы в коде — английские.
13. **Операции канала опциональны и не ломают ядро.** `edit`/`delete`/`actions`/
    `markRead` — только у канала, который объявил их в `capabilities`
    (`editing`/`deleting`/`actions`); ошибка операции — лог, обработка
    продолжается (`published`).
14. **Отметка «прочитано» — только после успешной публикации** (`Ingress`:
    опция `markRead`, рантайм связывает её с `channel.markRead`). При
    `not_allowed`/`duplicate`/`unknown_sender`/`failed` отметки нет; дедуп-ключ
    не меняется.

## Границы

- **Ядро не реализует:** wire-протоколы каналов, нормализацию входящего
  сообщения, адресат ответа в терминах канала, доставку в канал, тулы MCP
  конкретного канала, LLM.
- **Каналу недоступно:** внутренности ядра (дедуп, allowlist, маршрутизация,
  health-реестр) — только `ctx.publish`, `ctx.state`, `ctx.synth`, `ctx.log`,
  `ctx.health`, `ctx.tenant`. Операции `edit`/`delete`/`actions`/`markRead`
  канал **реализует сам** (ядро их только зовёт).
- **Пакет — библиотека**, а не сервис: у него нет `bin`, нет CLI-флага
  `--dry-run`/env-разбора общего уровня (это — забота канала), нет CLI-парсера
  тенантов (тенанты собирает канал через `parseTenantsFile`).
- **Резолвер «известен ли отправитель» рантайм не подключает.** `Ingress`
  (`isSenderKnown`) по умолчанию считает отправителя неизвестным (fail-closed),
  а в `GatewayOptions` нет хука для резолвера. Следствие: `unknownAction:
  'reject'` отклонит всё; рабочая политика — `register` (по умолчанию) и
  `hint` (код линковки приходит из ответа `POST /events`).

## Структура

```text
src/
  types.ts      # контракт канала и доставки (InboundMessage, DeliveryRequest, EditRequest, …)
  channel.ts    # ChannelAdapter, ChannelContext, PublishResult
  config.ts     # env-хелперы, allowlist, разбор tenants.json, дефолты тенанта
  store.ts      # FileStore (атомарная запись) + StateStore + KeySet + RecordStore
  api.ts        # SynthApi: события, привязки, сессии, пользователи
  auth.ts       # AuthTokenProvider (service-key → OIDC → api-key → none)
  health.ts     # GatewayHealth, реестр тенантов, SynthHealthProbe
  ingress.ts    # политика приёма: allowlist → дедуп → publish → маршрут
  watcher.ts    # SSE + доставка ответа в канал (дедуп, grace-фоллбэк)
  logger.ts     # логгер с префиксом [gateway][<tenant>]
  markdown.ts   # Markdown → HTML, чанкинг, экранирование
  runtime.ts    # runGateway: health-сервер → тенанты → каналы → watcher → остановка
  index.ts      # публичные экспорты пакета
  mcp/
    toolset.ts  # контракт тулов канала (McpToolset)
    server.ts   # createMcpServer: транспорт + тулы канала
    http.ts     # Streamable HTTP + bearer + маршрутизация /mcp/<tenantId>
    cli.ts      # CLI: stdio (по умолчанию) и --http
  installer.ts  # установка ресурсов `provides` (MCP-реестр, скилл)
docs/contract.md  # спецификация публичного API (документ истины)
scripts/version-bump.sh  # синхронизация версии пакета с тегом
```

`tsconfig.json` — базовый (editor/`pnpm typecheck`, включает тесты);
`tsconfig.build.json` (`extends`, эмит без `*.test.ts`) — для `pnpm build`.
Тесты — рядом с исходниками (`*.test.ts`).

## Правила имен и экспортов

- **`AuthMode` живёт в `health.ts`** (канон: режим попадает в снимок
  `GET /health`); `auth.ts` его реэкспортирует, а `index.ts` экспортирует
  **только из `health.ts`** — плоский реэкспорт обоих дал бы двусмысленность.
- **Точки входа** (`mcp/cli.ts`, `installer.ts`) экспортируются из `index.ts`
  **под именами** (`mcpCli`, `installer`): у них одноимённые `main`/`parseArgs`.
- Публичный API версионируется по semver: **breaking change → major**
  (`docs/contract.md`).

## Куда смотреть (триггеры)

| Тема | Файл |
|---|---|
| Назначение, поток данных, пример шлюза | `README.md`, `docs/contract.md` §1 |
| Контракт канала (типы, `ChannelAdapter`) | `src/types.ts`, `src/channel.ts`, `docs/contract.md` §3 |
| Операции канала (`edit`/`delete`/`actions`/`markRead`) | `src/channel.ts`, `docs/contract.md` §3.2–§3.3 |
| Рантайм-оркестрация и остановка | `src/runtime.ts` |
| Health-состояние и реестр тенантов | `src/health.ts` |
| Политика приёма (allowlist, дедуп, claim-flow) | `src/ingress.ts`, `docs/contract.md` §4.1 |
| Отметка «прочитано» после публикации | `src/ingress.ts` (опция `markRead`), `src/runtime.ts`, `docs/contract.md` §4.1 |
| Доставка ответов (SSE, дедуп, grace-фоллбэк) | `src/watcher.ts`, `docs/contract.md` §4.2 |
| Индикатор набора (`actions`, `typing`) | `src/watcher.ts`, `docs/contract.md` §4.2 |
| Состояние (атомарная запись, бакеты) | `src/store.ts`, `docs/contract.md` §4.3 |
| Конфиг тенантов, `tenants.json`, env-хелперы | `src/config.ts`, `docs/contract.md` §4.4 |
| Аутентификация в API Synth | `src/auth.ts`, `docs/contract.md` §4.5 |
| MCP (контракт тулов, транспорт, CLI) | `src/mcp/*`, `docs/contract.md` §4.6 |
| Инсталлятор ресурсов `provides` | `src/installer.ts`, `docs/contract.md` §4.7 |
| Инварианты и карта миграции | `docs/contract.md` §5, §6 |
| Логирование и префиксы | `src/logger.ts` |
| Релиз / публикация | `.gitverse/workflows/release.yaml`, `scripts/version-bump.sh` |

## Релиз и публикация

Версия — единый источник истины **git-тег** `vX.Y.Z`. Перед тегом
`scripts/version-bump.sh X.Y.Z` синхронизирует `package.json`; далее коммит и
тег. CI-пайплайн `.gitverse/workflows/release.yaml` (триггер — тег `v*` либо
ручной `workflow_dispatch` с `dry_run`) прогоняет сборку/typecheck/lint/тесты и
публикует пакет в **npmjs.org** (`NPM_TOKEN`; префикс `GITVERSE_` в GitVerse
запрещён). Обычные push/PR ничего не публикуют: только CI-проверки
(`.gitverse/workflows/ci.yaml`).

Сложный bash выносится в `scripts/` — `${...}` в inline-bash GitVerse парсит как
Go-шаблон и ломает скрипт.
