# @itphx/synth-gateway-core

> 🌐 [English](./README.en.md) · **Русский**

**Ядро шлюзов Synth** — общий фундамент внешних шлюзов (**Gateway**, ADR-087):
сервисов-мостов между внешним миром (мессенджер, почта, …) и платформой
внешних событий Synth (ADR-089: `POST /api/v2/events` + SSE `GET /api/v2/events`).

Пакет **не** является шлюзом: он не знает ни про один мессенджер. Он задаёт
**контракт канала** и реализует всё, что не зависит от транспорта: политику
приёма, доставку ответов, конфиг тенантов, состояние, аутентификацию в API
Synth, MCP-транспорт, инсталлятор ресурсов, health и логирование.

Основание — [ADR-103](../../synth/docs/arch_decisions/adr-103-gateway-core-channel-contract.md)
(ядро ↔ канал), класс шлюза — [ADR-087](../../synth/docs/arch_decisions/adr-087-gateways.md).
Спецификация публичного API — **[docs/contract.md](./docs/contract.md)**.

## Зачем отдельный пакет

Telegram-шлюз был единственной реализацией класса Gateway, и его код разделился
на две части: половина канал-независима, половина — канал-специфична. Второй
канал (email) показал: копирование эталона даёт ~4000 LOC дублирования на канал
и, что хуже, **расхождение правил** — дедуп, фоллбэк `stream.done`/`message.added`,
fail-closed allowlist, приоритет конфига, формат ошибок MCP. Каждое расхождение
в этих правилах — расхождение идемпотентности и безопасности, а не только кода.

Ядро вынесено в отдельный npm-пакет: контракт версионируется по semver, шлюз
фиксирует диапазон версий, обновление общего пакета — независимое решение шлюза.

## Границы «ядро ↔ канал»

| Сторона | Владеет |
|---|---|
| **Ядро** | политика приёма (allowlist fail-closed, дедуп, неизвестный отправитель, claim-flow); доставка ответа (SSE, дедуп, отложенный фоллбэк `message.added`, индикатор набора); отметка «прочитано»; конфиг тенантов; состояние; аутентификация в API Synth; MCP-транспорт; инсталлятор ресурсов; health; логирование |
| **Канал** | wire-протокол; нормализация входящего сообщения (`InboundMessage`); адресат ответа (`target`); доставка (`send` + опциональные `edit`/`delete`/`actions`/`markRead`); тулы MCP |

Канал **не знает** про API Synth (кроме `ctx.publish`); ядро **не знает** про
wire-протокол. Ни то, ни другое **не реализует LLM** — понимание и генерация
делает движок Synth, шлюз детерминированно транспортирует события.

## Что даёт ядро каналу

- **Политика приёма** — `allowlist` (fail-closed) → дедуп (`dedupKey`,
  персистентно) → публикация `POST /api/v2/events` → маршрут «сессия → адресат».
- **Политика неизвестного отправителя** — `register` / `hint` (код линковки
  claim-flow) / `reject`. Резолвера «известен ли отправитель» у рантайма нет:
  отправитель считается неизвестным (fail-closed), поэтому `reject` отклонит
  всё — рабочие политики `register` и `hint`.
- **Доставка ответов агента** — подписка на SSE `GET /events`, частичные
  доставки (`streaming`), дедуп исходящих (`stream:<id>`, `message:<sessionId>:<index>`),
  отложенный фоллбэк `message.added` с grace-паузой.
- **Операции канала** — `send` (обязателен) и опциональные `edit`/`delete`/
  `actions`/`markRead`: правка и удаление отправленного, действия чата
  (индикатор набора — ядро зовёт `actions({ type: 'typing' })` один раз на
  стрим) и отметка входящего «прочитано» после успешной публикации.
  Поддержку канал объявляет в `capabilities` (`editing`/`deleting`/`actions`).
- **Аутентификация в API Synth** — service-key (ADR-052) → OIDC → api-key → без auth.
- **Мультитенантность** — `tenants.json`, изоляция состояния по тенантам.
- **MCP** — Streamable HTTP (`/mcp/<tenantId>`, bearer) и stdio-CLI; тулы задаёт канал.
- **Health** — `GET /health` **без аутентификации** (пробы деплоя).
- **Инсталлятор ресурсов** — идемпотентная установка `provides` из `synth.pack`.

## Установка

```bash
pnpm add @itphx/synth-gateway-core
```

Пакет публикуется в npmjs.org; версия — semver, **breaking change → major**.
Шлюз фиксирует диапазон версий (`^0.1.0`) и обновляет его независимо.

Требования: Node.js ≥ 22, ESM (`"type": "module"`).

## Минимальный шлюз (~40 строк)

Канал реализует контракт (`ChannelAdapter`); всё остальное — ядро.

```ts
#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import {
  parseTenantsFile,
  runGateway,
  type ChannelAdapter,
  type ChannelContext,
  type DeliveryRequest,
  type DeliveryResult,
  type GatewayDefaults,
  type NoticeRequest,
} from '@itphx/synth-gateway-core';

/** Своя секция канала в `tenants.json`. */
interface MyChannelConfig {
  endpoint: string;
}

/** Сырое сообщение внешнего транспорта (формат задаёт канал). */
interface RawMessage {
  id: string;
  author: string;
  chatId: string;
  text: string;
}

/** Схема секции: ядро отвергает неизвестные поля записи (fail-fast). */
const schema = {
  keys: ['endpoint'],
  parse: (raw: Record<string, unknown>): MyChannelConfig => ({
    endpoint: typeof raw.endpoint === 'string' ? raw.endpoint : '',
  }),
};

const defaults: GatewayDefaults<MyChannelConfig> = {
  synth: { baseUrl: process.env.SYNTH_URL ?? 'http://127.0.0.1:5000/api/v2', oidc: {} },
  allowlist: {},
  unknownAction: 'register',
  watch: true,
  channel: { endpoint: '' },
};

/** Канал: wire-протокол, нормализация и доставка — его дело. */
class MyChannel implements ChannelAdapter {
  readonly source = 'my-channel';
  readonly capabilities = {
    streaming: false,
    editing: false,
    drafts: false,
    threads: false,
    attachments: false,
    deleting: false,
    actions: false,
  };

  constructor(private readonly config: MyChannelConfig) {}

  async start(ctx: ChannelContext): Promise<void> {
    for await (const raw of this.readLoop()) {
      // Публикация: allowlist/дедуп/маршрут — забота ядра.
      await ctx.publish({
        dedupKey: `my:${raw.id}`,
        identity: { principalId: `my:${raw.author}`, accessKeys: [raw.author] },
        text: raw.text,
        target: { chatId: raw.chatId },
      });
    }
  }

  async stop(): Promise<void> {
    /* закрыть соединение с внешним миром */
  }

  async send(req: DeliveryRequest): Promise<DeliveryResult> {
    return { messageId: await this.post(req.route.target, req.content) };
  }

  async notify(req: NoticeRequest): Promise<void> {
    await this.post(req.target, req.text); // код линковки — отправителю
  }

  // ↓↓↓ wire-протокол канала (его реализация, не ядро) ↓↓↓
  private async *readLoop(): AsyncGenerator<RawMessage> {
    // подключиться к this.config.endpoint и читать сообщения
  }

  private async post(_target: unknown, _text: string): Promise<string> {
    return 'msg-1';
  }
}

const tenants = parseTenantsFile(
  JSON.parse(await readFile('tenants.json', 'utf8')),
  schema,
  defaults,
);

await runGateway(
  {
    version: '1.0.0',
    dataDir: './data',
    host: '127.0.0.1',
    port: 7100,
    dryRun: false,
    watch: true,
    tenants,
  },
  {
    version: '1.0.0',
    schema,
    defaults,
    createChannel: (tenant) => new MyChannel(tenant.channel),
  },
);
```

Что здесь важно:

- **`start(ctx)`** — единственная точка входа во внешний мир: цикл чтения внутри
  канала, наружу — только `ctx.publish(normalizedMessage)`.
- **`send(req)`** — доставка ответа агента; ядро уже решил, кому и когда.
- **`notify?(req)`** — необязательно: код линковки для несопознанного отправителя.
- **`edit?`/`delete?`/`actions?`/`markRead?`** — необязательно: канал объявляет
  поддержку в `capabilities` (`editing`/`deleting`/`actions`), а отсутствие
  метода означает «не умеет». Ядро зовёт `actions({ type: 'typing' })` один раз
  на стрим (индикатор набора) и `markRead({ route })` — после успешной публикации
  входящего сообщения.
- **Ядро не бросает исключений в канал**: отказ политики приёма приходит в
  `ctx.publish` как `{ sessionId: null }`, а не как исключение.

## Жизненный цикл рантайма

```text
runGateway(config, options)
  └─ 1. health-сервер (ДО каналов — пробы деплоя не ждут внешний мир)
  └─ 2. на тенант: StateStore → AuthTokenProvider → SynthApi → GatewayHealth
                    → Ingress → канал (options.createChannel) → watcher → health-проба
  └─ 3. демон: каналы принимают, watcher'ы раздают ответы
  └─ 4. SIGINT/SIGTERM → watcher.stop() → channel.stop() → серверы закрыты
```

- **dry-run** — каналы не подключаются наружу, watcher'ы не запускаются, health
  отвечает; удобно для проверки конфигурации и деплоя.
- **Ошибка `channel.start`** не валит процесс: лог + `health` (`degraded`),
  остальные тенанты продолжают работать.
- **`GET /health`** — без токена: `{ status, version, source, synth, channel,
  watcher, auth, token, tenants }`.

## MCP

Ядро поднимает **Streamable HTTP**-сервер (`/mcp/<tenantId>`, bearer-токен,
`GET /health` без auth), если заданы и набор тулов (`options.createMcpTools`),
и токен (`options.mcpToken`). Набор тулов задаёт канал (`McpToolset`); stdio-режим
запускается отдельно (`mcpCli`).

## Команды

| Команда | Действие |
|---|---|
| `pnpm build` | сборка (`tsc` → `dist/`) |
| `pnpm typecheck` | проверка типов |
| `pnpm lint` | ESLint |
| `pnpm test` | Vitest |
| `pnpm clean` | очистка `dist/` |

## Релиз

Версия — единый источник истины **git-тег** `vX.Y.Z`. Перед тегом:

```bash
./scripts/version-bump.sh 0.2.0
git commit -am 'chore: версия 0.2.0'
git tag v0.2.0 && git push --follow-tags
```

CI (`.gitverse/workflows/release.yaml`, триггер — тег `v*` или ручной
`workflow_dispatch`) прогоняет сборку/typecheck/lint/тесты и публикует пакет в
**npmjs.org** (`NPM_TOKEN`). Обычные push/PR ничего не публикуют.

## Документация

- **[docs/contract.md](./docs/contract.md)** — спецификация публичного API
  (модули, контракт канала, инварианты, карта миграции).
- [ADR-103](../../synth/docs/arch_decisions/adr-103-gateway-core-channel-contract.md) —
  ядро и контракт канала; [ADR-087](../../synth/docs/arch_decisions/adr-087-gateways.md) —
  класс Gateway.
- [AGENTS.md](./AGENTS.md) — соглашения репозитория.

## Лицензия

MIT — см. [LICENSE](LICENSE).
