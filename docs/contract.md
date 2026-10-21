# Контракт `@itphx/synth-gateway-core`

> Спецификация публичного API пакета. Решение — [ADR-103](../../synth/docs/arch_decisions/adr-103-gateway-core-channel-contract.md)
> (монорепозиторий Synth), класс шлюза — [ADR-087](../../synth/docs/arch_decisions/adr-087-gateways.md).
> Язык — русский. Контракт версируется по semver: **breaking change → major**.

## 1. Назначение

Пакет — общий фундамент внешних шлюзов Synth (ADR-087): сервисов-мостов между
внешним миром (мессенджер, почта, …) и платформой внешних событий Synth
(ADR-089: `POST /api/v2/events` + SSE `GET /api/v2/events`).

Шлюз = **канал** (реализация внешнего транспорта) + **ядро** (этот пакет).
Разделение строгое:

| Сторона | Владеет |
|---|---|
| **Ядро** | политика приёма (allowlist, дедуп, неизвестный отправитель, claim-flow); доставка ответа (SSE, дедуп, фоллбэк `message.added`); конфиг тенантов; состояние; аутентификация в API Synth; MCP-транспорт; инсталлятор ресурсов; health; логирование |
| **Канал** | wire-протокол; нормализация входящего сообщения; адресат ответа; доставка; тулы MCP |

Канал **не знает** про API Synth (кроме `ctx.publish`); ядро **не знает** про
wire-протокол. Ни то, ни другое не реализует LLM.

## 2. Модули

```text
src/
  types.ts      # контракт канала и доставки (типы)
  channel.ts    # ChannelAdapter, ChannelContext, сборка канала
  ingress.ts    # политика приёма: allowlist → дедуп → publish → маршрут
  watcher.ts    # SSE + доставка ответа в канал
  auth.ts       # AuthTokenProvider (service-key / OIDC / api-key)
  api.ts        # SynthApi: события, привязки, сессии, пользователи
  store.ts      # FileStore (атомарно) + StateStore + KeySet + RecordStore
  config.ts     # env-хелперы, тенанты, allowlist
  health.ts     # GatewayHealth + реестр
  logger.ts     # логгер с префиксом [gateway][<tenant>]
  markdown.ts   # Markdown → HTML, чанкинг, экранирование
  mcp/
    http.ts     # Streamable HTTP + bearer + маршрутизация /mcp/<tenantId>
    server.ts   # createMcpServer: транспорт + тулы канала
    cli.ts      # CLI: stdio (по умолчанию) и --http
  installer.ts  # установка ресурсов `provides` (MCP-реестр, скилл)
  runtime.ts    # runGateway: конфиг → тенанты → каналы → health → watcher
  index.ts      # публичные экспорты
```

## 3. Контракт канала

### 3.1 Типы (`src/types.ts`)

```ts
/** JSON-значение — сериализуемый формат цели канала. */
export type JsonValue =
  | string | number | boolean | null
  | JsonValue[]
  | { [key: string]: JsonValue };

/** Возможности канала. */
export interface ChannelCapabilities {
  /** Канал умеет частичные обновления (live-стриминг ответа). */
  streaming: boolean;
  /** Канал умеет редактировать ранее отправленное сообщение. */
  editing: boolean;
  /** Канал умеет черновики: ответ требует подтверждения перед отправкой. */
  drafts: boolean;
  /** Канал умеет треды (у сообщения есть `threadKey`). */
  threads: boolean;
  /** Канал принимает вложения (информационно: контент ядром не передаётся). */
  attachments: boolean;
  /** Канал умеет удалять ранее отправленные сообщения. */
  deleting: boolean;
  /** Канал умеет действия в чате, не связанные с сообщением (индикатор набора и т.п.). */
  actions: boolean;
}

/** Идентичность входящего отправителя в терминах канала. */
export interface InboundIdentity {
  /** Полный `principalId` (`<provider>:<externalId>`) — маппится на профиль Synth. */
  principalId: string;
  /** Ключ «чата»/переписки — ключ Binding. */
  chatKey?: string;
  /** Ключ треда — ключ Binding (приоритетнее `chatKey`). */
  threadKey?: string;
  /** Ключи списка доступа (адрес в канале). Первый найденный в allowlist — истина. */
  accessKeys: string[];
}

/** Нормализованное входящее сообщение канала. */
export interface InboundMessage {
  /** Стабильный ключ дедупликации — `<source>:<...>`, переживает реконнект. */
  dedupKey: string;
  identity: InboundIdentity;
  /** Текст сообщения → `payload.text`. */
  text: string;
  /** Канал-специфичные метаданные → `payload` (тема, заголовки, вложения). */
  meta?: Record<string, unknown>;
  /** Адресат ответа в канале (формат определяет канал) — попадает в маршрут. */
  target: JsonValue;
  /** Идентификатор входящего сообщения (reply-цель) — попадает в маршрут. */
  inboundMessageId?: string;
}

/** Маршрут «сессия → адресат в канале». */
export interface SessionRoute {
  sessionId: string;
  /** Цель в канале (формат определяет канал). */
  target: JsonValue;
  /** Идентификатор входящего сообщения (reply-цель). */
  inboundMessageId?: string;
  updatedAt: string;
}

/** Вид доставки. */
export type DeliveryKind = 'partial' | 'final' | 'error' | 'cancelled';

/** Запрос доставки ответа в канал. */
export interface DeliveryRequest {
  route: SessionRoute;
  /** Текст ответа (частичный — при `kind: 'partial'`). */
  content: string;
  kind: DeliveryKind;
  /** Идентификатор стрима (для дедупа). */
  streamId?: string;
  /** Индекс сообщения в сессии (для дедупа). */
  messageIndex?: number;
  /** Итерация Tool Use — смена означает завершение промежуточного шага. */
  iteration?: number;
  /** Служебная приписка (например «↻ повтор 2/3…»). */
  note?: string;
  /** id ранее отправленного сообщения — канал может отредактировать его. */
  replaceMessageId?: string;
  /** Кнопки/действия, прикрепляемые к сообщению (если канал умеет). */
  buttons?: ChannelButton[];
}

/** Результат доставки. */
export interface DeliveryResult {
  /** id отправленного сообщения в канале — для последующих правок. */
  messageId?: string;
  /** Фактически доставленный текст (канал мог обрезать). */
  content?: string;
}

/** Кнопка/действие, прикрепляемое к сообщению (инлайн-кнопки, клавиатура). */
export interface ChannelButton {
  /** Идентификатор действия (callback-данные). */
  id: string;
  /** Подпись кнопки. */
  label: string;
  /** URL вместо callback (кнопка-ссылка). */
  url?: string;
}

/** Запрос правки ранее отправленного сообщения. */
export interface EditRequest {
  route: SessionRoute;
  /** Идентификатор сообщения в канале (из `DeliveryResult.messageId`). */
  messageId: string;
  /** Новый текст. */
  content: string;
  /** Кнопки (если канал умеет). */
  buttons?: ChannelButton[];
}

/** Запрос удаления ранее отправленного сообщения. */
export interface DeleteRequest {
  route: SessionRoute;
  messageId: string;
}

/** Запрос действия в чате, не связанного с сообщением. */
export interface ActionRequest {
  route: SessionRoute;
  /** Тип действия (`typing` — индикатор набора). */
  type: string;
  /** Полезная нагрузка действия (для канала). */
  payload?: Record<string, unknown>;
}

/** Запрос отметки «прочитано». */
export interface MarkReadRequest {
  route: SessionRoute;
  /** Идентификатор входящего сообщения (канал помечает конкретное сообщение). */
  inboundMessageId?: string;
}

/** Служебное уведомление каналу (код линковки, отказ). */
export interface NoticeRequest {
  /** Адресат уведомления в канале. */
  target: JsonValue;
  text: string;
  /** Код линковки (claim-flow ADR-089). */
  claimCode?: string;
}
```

### 3.2 Интерфейс (`src/channel.ts`)

```ts
/** Результат публикации входящего сообщения. */
export interface PublishResult {
  /** Сессия, выбранная ядром (null — маршрут не создаётся). */
  sessionId: string | null;
  /** Код линковки для несопознанного отправителя (ADR-089). */
  identityHint?: { code: string; expiresAt: string };
}

/** Контекст, который ядро передаёт каналу при старте. */
export interface ChannelContext {
  /** Публикация в Synth. Ядро уже проверило allowlist и дедуп. */
  publish(message: InboundMessage): Promise<PublishResult>;
  /** Персистентное состояние канала (изолировано по тенанту). */
  state: StateStore;
  /** Клиент API v2 Synth (привязки, сессии, пользователи). */
  synth: SynthApi;
  /** Логгер тенанта: префикс `[gateway][<tenantId>]`. */
  log: (message: string) => void;
  /** Health тенанта. */
  health: GatewayHealth;
  /** Конфигурация тенанта. */
  tenant: TenantConfig;
}

/**
 * Контракт канала — внешнего транспорта одного тенанта.
 *
 * Операции `edit`/`delete`/`actions`/`markRead` **опциональны**: канал без
 * правок (почта) не обязан их реализовывать. Поддержку канал объявляет через
 * `capabilities` (`editing`/`deleting`/`actions`), отсутствие метода означает
 * «не умеет» — ядро такую операцию просто не вызывает.
 */
export interface ChannelAdapter {
  /** Источник событий (`source` в `POST /api/v2/events`). */
  readonly source: string;
  /** Возможности канала. */
  readonly capabilities: ChannelCapabilities;

  /** Подключиться и начать приём. Резолвится сразу: цикл — внутри. */
  start(ctx: ChannelContext): Promise<void>;
  /** Остановить приём и освободить ресурсы. Идемпотентно. */
  stop(): Promise<void>;

  /** Отправить сообщение в канал. */
  send(req: DeliveryRequest): Promise<DeliveryResult>;

  /** Служебное уведомление (код линковки). Опционально. */
  notify?(req: NoticeRequest): Promise<void>;

  /** Отредактировать ранее отправленное сообщение (`capabilities.editing`). */
  edit?(req: EditRequest): Promise<DeliveryResult>;
  /** Удалить ранее отправленное сообщение (`capabilities.deleting`). */
  delete?(req: DeleteRequest): Promise<void>;
  /** Действие в чате, не связанное с сообщением (`capabilities.actions`; `typing`). */
  actions?(req: ActionRequest): Promise<void>;
  /** Отметить входящее сообщение прочитанным (аналог IMAP `\Seen`). */
  markRead?(req: MarkReadRequest): Promise<void>;
}
```

### 3.3 Соответствие операций ADR-087 §4

ADR-087 §4 фиксирует интерфейс операций канала `send`/`edit`/`delete`/`actions`/
`subscribe`. В ядре они раскладываются так:

| Операция ADR-087 | Контракт ядра | Кто вызывает | Примечание |
|---|---|---|---|
| `send` | `send(DeliveryRequest)` | watcher (`src/watcher.ts`) | доставка ответа агента; кнопки — в `DeliveryRequest.buttons` |
| `edit` | `edit(EditRequest)` | канал (MCP-тулы) | опционально; `capabilities.editing` |
| `delete` | `delete(DeleteRequest)` | канал (MCP-тулы) | опционально; `capabilities.deleting` |
| `actions` | `actions(ActionRequest)` | ядро (индикатор набора `typing`) + канал (MCP-тулы) | опционально; `capabilities.actions` |
| `subscribe` | `start(ChannelContext)` | рантайм (`src/runtime.ts`) | подписка канала на внешний мир (polling/long-poll/webhook); цикл — внутри канала |
| — | `markRead(MarkReadRequest)` | ядро (после успешной публикации) | отметка «прочитано» — аналог IMAP `\Seen` |

Кнопки (`ChannelButton`) ядром **не** наполняются: они приходят из MCP-тулов
канала и уходят в канал через `send`/`edit`.

## 4. Ядро

### 4.1 Приём (`src/ingress.ts`)

Порядок обработки входящего сообщения (fail-closed на каждом шаге):

1. **allowlist** — первый ключ из `identity.accessKeys`, найденный в allowlist,
   даёт роль. Не найден → `rejected: 'not_allowed'`, событие **не публикуется**.
   Роль попадает в `identity.roles` и в ядре **только сужает** права профиля
   (ADR-089).
2. **дедуп** — `dedupKey` в персистентном множестве → `rejected: 'duplicate'`.
   Множество ограничено по размеру (LRU-подобное обрезание хвоста).
3. **публикация** — `POST /api/v2/events` с `source`, `type: 'message'`,
   `payload` (`text` + `meta`), `identity` (с ролью), `dedupKey`.
4. **маршрут** — при `sessionId` из ответа ядро пишет `SessionRoute`
   (`sessionId → target`, `inboundMessageId`) в состояние.
5. **неизвестный отправитель** — политика `unknownAction`:
   - `register` (по умолчанию) — публикуем как есть;
   - `hint` — публикуем и отдаём каналу `notify({ claimCode })` — код линковки
     из `identityHint` ответа ingest;
   - `reject` — не публикуем (`rejected: 'unknown_sender'`).
6. **отметка «прочитано»** — только после успешной публикации ядро вызывает
   `IngressOptions.markRead(message)`. Рантайм связывает его с каналом:
   `channel.markRead?.({ route, inboundMessageId })`, где маршрут берётся из
   состояния (`routes`), которое ведёт `Ingress`. Ошибка отметки **не** ломает
   обработку (лог + продолжение, результат остаётся `published`).

Ошибка публикации → `failed`; **сообщение не считается обработанным**, дедуп-ключ
не фиксируется — повтор возможен.

Отметка «прочитано» вызывается **только** при успешной публикации: при
`not_allowed`/`duplicate`/`unknown_sender`/`failed` её нет (дедуп-ключ при этом
не меняется).

### 4.2 Доставка (`src/watcher.ts`)

Подписка на SSE `GET {baseUrl}/events` (события всех сессий, к которым у ключа
есть доступ). Обработка:

| Событие | Действие |
|---|---|
| `stream.chunk` | накопление текста; при `capabilities.streaming` — доставка `kind: 'partial'` (первый вызов создаёт сообщение, последующие — с `replaceMessageId`); индикатор набора — `channel.actions({ route, type: 'typing' })` **один раз на стрим** (только при `capabilities.actions` и наличии метода; ошибка — лог) |
| `stream.done` | отмена отложенного `message.added`; доставка `kind: 'final'` (полный текст: `data.content` ?? накопленный) |
| `stream.cancelled` | отмена отложенного `message.added`; доставка `kind: 'cancelled'` |
| `stream.error` | отмена отложенного `message.added`; доставка `kind: 'error'` |
| `message.added` (роль `assistant`) | **отложенный** фоллбек через grace-паузу (по умолчанию 3000 мс): если за паузу пришёл `stream.done`/`stream.cancelled` — отменяется |

Индикатор набора (`typing`) ядро отправляет один раз на стрим: частота
обновления — забота канала. Кнопки (`DeliveryRequest.buttons`) ядро **не**
заполняет — они приходят из MCP-тулов канала.

Дедуп исходящих (персистентный): `stream:<streamId>`, `message:<sessionId>:<index>`,
`message-content:<sessionId>:<streamId|длина>`, `error:<streamId>`. Ключ
проставляется **до** фактической отправки — повторная доставка невозможна.

Переподключение SSE: backoff `backoffMs → maxBackoffMs` (по умолчанию 1000 → 30000).
Ответ `401` — один refresh bearer и повторное подключение (без траты retry-бюджета).

Маршрут ищется по `sessionId`; события сессий без маршрута игнорируются.

### 4.3 Состояние (`src/store.ts`)

- `FileStore` — атомарная запись `*.tmp.<uuid>` → `rename()` (ADR-005), проверка
  containment пути.
- `StateStore` — именованные JSON-бакеты (`state/<bucket>.json`).
- `KeySet` — множество ключей с лимитом (дедуп).
- `RecordStore<T>` — карта «ключ → значение» (маршруты, курсоры).

Изоляция по тенанту: `data/tenants/<tenantId>/…`; legacy-режим (без файла
тенантов) — корень `dataDir`.

### 4.4 Конфиг (`src/config.ts`)

Приоритет: **CLI-флаг > env > `secrets/` > дефолт**. Пустая/whitespace-строка env
= отсутствие значения (`envOr`).

Разбор allowlist: `key:ROLE,key2:ROLE`; разделитель — **последний** `:` (адреса
почты содержат `:`); роль нормализуется в верхний регистр; битые пары
пропускаются.

Разбор `tenants.json`: объект с единственным ключом `tenants` (массив, непустой,
уникальные `id` по шаблону `^[a-z0-9][a-z0-9_-]*$`). Неизвестный ключ записи →
**ошибка** (fail-fast). Канал задаёт свои ключи через `ChannelTenantSchema.keys`,
ядро — общие (`synthUrl`, `serviceKey`, `apiKey`, `oidc*`, `allowlist`,
`unknownAction`, `watch`, `id`).

### 4.5 Аутентификация (`src/auth.ts`)

Приоритет режима: `service-key` → `oidc` → `api-key` → `none`. OIDC —
client-credentials с кэшем токена, single-flight refresh и margin
(по умолчанию 30 с). Тело ошибки OIDC-сервера **не логируется**.

### 4.6 MCP (`src/mcp/*`)

- **HTTP** (Streamable HTTP, stateless): путь `/mcp/<tenantId>`, `tenantId` из
  allowlist тенантов; неизвестный → `404`. Bearer-токен сравнивается в постоянном
  времени; нет/неверный → `401`. `GET /health` — **без аутентификации**.
- **stdio**: `node dist/mcp/cli.js`; тулы тенанта — по умолчанию.
- Тулы канала задаёт шлюз через `McpToolset` (`list()` / `call(name, args)`).

### 4.7 Инсталлятор (`src/installer.ts`)

Идемпотентная установка ресурсов из `provides` манифеста `synth.pack`:
`mcp` (запись реестра MCP) и `skills` (скилл и supporting-файлы).
Режимы: **managed** (API v2: `POST` → `409` → `PUT`) и **standalone**
(правка `config.yaml` / копирование в `{dataDir}/skills/`). Режим выбирается
**до** изменений; ошибка → понятное сообщение и ненулевой exit-code.

### 4.8 Рантайм (`src/runtime.ts`)

`runGateway(config, options)`:

1. health-сервер поднимается **до** каналов (пробы деплоя не зависят от доступности внешнего мира);
2. для каждого тенанта — канал (`options.createChannel`), `StateStore`, `SynthApi`,
   `AuthTokenProvider`, `Ingress`, `ResponseWatcher`;
3. демон: каналы принимают, watcher'ы раздают ответы;
4. `SIGINT`/`SIGTERM` — корректная остановка.

Рантайм связывает `IngressOptions.markRead` с каналом: после успешной публикации
ядро зовёт `channel.markRead?.({ route, inboundMessageId })`, где маршрут берётся
из состояния (`routes`), которое ведёт `Ingress`. Ошибка отметки не влияет на
результат публикации (лог + продолжение).

## 5. Инварианты

1. **Fail-closed allowlist.** Отправитель вне allowlist → событие не публикуется.
2. **Идемпотентность.** Вход дедуплицируется по `dedupKey` (персистентно); исходящие
   — по `streamId`/`messageIndex` (персистентно).
3. **Секреты — вне git и не в логах.** В логах только факт «задан/не задан».
   Логи с префиксом `[gateway]`, в тенантном режиме — `[gateway][<tenantId>]`.
4. **`GET /health` — без auth.**
5. **Атомарная запись состояния** (ADR-005).
6. **Ядро не знает про wire-протокол; канал не знает про API Synth** (кроме `ctx.publish`).
7. **LLM внутрь шлюза не тянется** — понимание/генерация — движок Synth.
8. **Коммит — только по явной просьбе**; новые зависимости — с разрешения.
9. **Операции канала опциональны и не ломают ядро.** `edit`/`delete`/`actions`/
   `markRead` реализует только канал, который их объявил в `capabilities`;
   ошибка такой операции — лог, обработка продолжается (`published`).
10. **Отметка «прочитано» — только после успешной публикации.** При
   `not_allowed`/`duplicate`/`unknown_sender`/`failed` её нет; дедуп-ключ при
   этом не меняется.

## 6. Карта миграции из `synth-gateway-telegram`

| Модуль Telegram | Куда в ядре | Что меняется |
|---|---|---|
| `src/gateway/auth.ts` | `src/auth.ts` | без изменений |
| `src/gateway/ingest.ts` | `src/api.ts` | `SynthEventsClient` → `SynthApi` (добавлены users/sessions/health-probe) |
| `src/gateway/store.ts` | `src/store.ts` | `FileStore` → без изменений; `GatewayStore` → `StateStore` + `KeySet` + `RecordStore` |
| `src/gateway/config.ts` | `src/config.ts` | каркас тенантов и env-хелперы → без изменений; секция `telegram` → `channel` (схема канала) |
| `src/gateway/runtime.ts` | `src/runtime.ts` | сборка тенанта → общая; создание канала → `options.createChannel` |
| `src/gateway/health.ts`, `health-probe.ts` | `src/health.ts` | `setBot` → `setChannel` |
| `src/gateway/watcher.ts` | `src/watcher.ts` | SSE, дедуп, grace-фоллбек → без изменений; доставка → `channel.send`; вызов индикатора набора → `channel.actions` (Telegram-специфика `sendChatAction` — в канале); live-сообщение/rich-draft → в канал |
| `src/gateway/normalize.ts`, `poller.ts`, `inbound.ts`, `bot-api/*` | **в канал** | без изменений (Telegram-специфично) |
| `src/gateway/inbound.ts` (`InboundRegistry`) | **маршрут в ядре** (`src/ingress.ts` + `RecordStore<SessionRoute>`, бакет `routes`) | `dedupKey → messageId` / `stream_id → messageId` → `sessionId → { target, inboundMessageId }`; персистентно и общее для всех каналов |
| `src/gateway/markdown.ts` | `src/markdown.ts` | `markdownToTelegramHtml` → `markdownToHtml`; `chunkHtmlText` → в канал |
| `src/gateway/commands.ts`, `command-handler.ts`, `unknown-action.ts` | **в канал** / `src/ingress.ts` | политика неизвестного → ядро; команды → канал |
| `src/mcp/http.ts`, `server.ts`, `index.ts` | `src/mcp/*` | транспорт → ядро; тулы → канал |
| `src/mcp/user-lookup.ts` | `src/api.ts` + канал | резолв пользователя → API-клиент ядра |
| `src/installer/install.ts` | `src/installer.ts` | без изменений |
