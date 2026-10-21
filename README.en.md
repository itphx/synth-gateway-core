# @itphx/synth-gateway-core

> 🌐 **English** · [Russian](./README.md)

**The core of the Synth gateways** — the shared foundation of the external
gateways (**Gateway**, ADR-087): bridge services between the outside world
(messenger, mail, …) and the Synth external-event platform (ADR-089:
`POST /api/v2/events` + SSE `GET /api/v2/events`).

The package is **not** a gateway: it knows no messenger at all. It defines the
**channel contract** and implements everything that does not depend on the
transport: the ingestion policy, answer delivery, tenant configuration, state,
authentication against the Synth API, the MCP transport, the resource installer,
health and logging.

Rationale — [ADR-103](../../synth/docs/arch_decisions/adr-103-gateway-core-channel-contract.md)
(core ↔ channel); the gateway class — [ADR-087](../../synth/docs/arch_decisions/adr-087-gateways.md).
The public API specification — **[docs/contract.md](./docs/contract.md)**.

## Why a separate package

The Telegram gateway was the only implementation of the Gateway class, and its
code split in two: a channel-independent half and a channel-specific one. The
second channel (email) showed that copying the reference implementation gives
~4000 LOC of duplication per channel and — worse — **divergence of the rules**:
dedup, the `stream.done`/`message.added` fallback, the fail-closed allowlist,
config priority, the MCP error format. Every divergence in those rules is a
divergence in idempotency and security, not just in code.

The core lives in a separate npm package: the contract is versioned with semver,
a gateway pins a version range, and upgrading the shared package is an
independent decision of the gateway.

## The core ↔ channel boundary

| Side | Owns |
|---|---|
| **Core** | ingestion policy (fail-closed allowlist, dedup, unknown sender, claim-flow); answer delivery (SSE, dedup, deferred `message.added` fallback, typing indicator); "read" marking; tenant configuration; state; authentication against the Synth API; MCP transport; resource installer; health; logging |
| **Channel** | wire protocol; normalization of the incoming message (`InboundMessage`); the reply target (`target`); delivery (`send` plus the optional `edit`/`delete`/`actions`/`markRead`); MCP tools |

The channel **does not know** about the Synth API (except `ctx.publish`); the core
**does not know** about the wire protocol. Neither of them **implements an LLM** —
understanding and generation are done by the Synth engine, the gateway only
deterministically transports events.

## What the core gives to a channel

- **Ingestion policy** — `allowlist` (fail-closed) → dedup (`dedupKey`, persistent)
  → publication to `POST /api/v2/events` → the "session → target" route.
- **Unknown-sender policy** — `register` / `hint` (claim-flow linking code) / `reject`.
  The runtime has no "is the sender known" resolver: the sender is considered
  unknown (fail-closed), so `reject` declines everything — the working policies
  are `register` and `hint`.
- **Agent-answer delivery** — SSE `GET /events` subscription, partial deliveries
  (`streaming`), outgoing dedup (`stream:<id>`, `message:<sessionId>:<index>`),
  the deferred `message.added` fallback with a grace pause.
- **Channel operations** — `send` (mandatory) plus the optional `edit`/`delete`/
  `actions`/`markRead`: editing and deleting a delivered message, chat actions
  (the typing indicator — the core calls `actions({ type: 'typing' })` once per
  stream) and marking the incoming message as read after a successful
  publication. The channel declares its support in `capabilities`
  (`editing`/`deleting`/`actions`).
- **Synth API authentication** — service-key (ADR-052) → OIDC → api-key → none.
- **Multi-tenancy** — `tenants.json`, per-tenant state isolation.
- **MCP** — Streamable HTTP (`/mcp/<tenantId>`, bearer) and the stdio CLI; the
  tools are provided by the channel.
- **Health** — `GET /health` **without authentication** (deployment probes).
- **Resource installer** — idempotent installation of `provides` from `synth.pack`.

## Installation

```bash
pnpm add @itphx/synth-gateway-core
```

The package is published to npmjs.org; the version is semver, **a breaking change
→ major**. A gateway pins a version range (`^0.1.0`) and upgrades it independently.

Requirements: Node.js ≥ 22, ESM (`"type": "module"`).

## A minimal gateway (~40 lines)

The channel implements the contract (`ChannelAdapter`); everything else is the core.

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

/** The channel's own section of `tenants.json`. */
interface MyChannelConfig {
  endpoint: string;
}

/** A raw message of the external transport (the format is up to the channel). */
interface RawMessage {
  id: string;
  author: string;
  chatId: string;
  text: string;
}

/** Section schema: the core rejects unknown entry fields (fail-fast). */
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

/** The channel: wire protocol, normalization and delivery are its business. */
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
      // Publication: the allowlist/dedup/route is the core's business.
      await ctx.publish({
        dedupKey: `my:${raw.id}`,
        identity: { principalId: `my:${raw.author}`, accessKeys: [raw.author] },
        text: raw.text,
        target: { chatId: raw.chatId },
      });
    }
  }

  async stop(): Promise<void> {
    /* close the connection to the outside world */
  }

  async send(req: DeliveryRequest): Promise<DeliveryResult> {
    return { messageId: await this.post(req.route.target, req.content) };
  }

  async notify(req: NoticeRequest): Promise<void> {
    await this.post(req.target, req.text); // the linking code goes to the sender
  }

  // ↓↓↓ the channel's wire protocol (its own implementation, not the core) ↓↓↓
  private async *readLoop(): AsyncGenerator<RawMessage> {
    // connect to this.config.endpoint and read the messages
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

What matters here:

- **`start(ctx)`** is the only entry point to the outside world: the read loop
  lives inside the channel; the only way out is `ctx.publish(normalizedMessage)`.
- **`send(req)`** — delivery of the agent's answer; the core already decided
  whom to deliver to and when.
- **`notify?(req)`** — optional: the linking code for an unrecognized sender.
- **`edit?`/`delete?`/`actions?`/`markRead?`** — optional: the channel declares
  its support in `capabilities` (`editing`/`deleting`/`actions`), and a missing
  method means "not supported". The core calls `actions({ type: 'typing' })`
  once per stream (the typing indicator) and `markRead({ route })` — after a
  successful publication of the incoming message.
- **The core never throws into the channel**: a rejection of the ingestion policy
  arrives in `ctx.publish` as `{ sessionId: null }`, not as an exception.

## Runtime lifecycle

```text
runGateway(config, options)
  └─ 1. the health server (BEFORE the channels — deployment probes never wait
  │      for the outside world)
  └─ 2. per tenant: StateStore → AuthTokenProvider → SynthApi → GatewayHealth
  │                  → Ingress → channel (options.createChannel) → watcher → health probe
  └─ 3. daemon: the channels receive, the watchers deliver the answers
  └─ 4. SIGINT/SIGTERM → watcher.stop() → channel.stop() → the servers are closed
```

- **dry-run** — the channels do not connect outward, the watchers are not
  started, health still answers; handy to validate the configuration and deploy.
- **A `channel.start` failure** does not kill the process: a log line plus
  `health` (`degraded`); the other tenants keep working.
- **`GET /health`** — no token: `{ status, version, source, synth, channel,
  watcher, auth, token, tenants }`.

## MCP

The core starts a **Streamable HTTP** server (`/mcp/<tenantId>`, bearer token,
`GET /health` without auth) when both the tool set (`options.createMcpTools`)
and the token (`options.mcpToken`) are given. The channel provides the tools
(`McpToolset`); the stdio mode is launched separately (`mcpCli`).

## Commands

| Command | Action |
|---|---|
| `pnpm build` | build (`tsc` → `dist/`) |
| `pnpm typecheck` | type check |
| `pnpm lint` | ESLint |
| `pnpm test` | Vitest |
| `pnpm clean` | clean `dist/` |

## Release

The version has a single source of truth — the **git tag** `vX.Y.Z`. Before the tag:

```bash
./scripts/version-bump.sh 0.2.0
git commit -am 'chore: версия 0.2.0'
git tag v0.2.0 && git push --follow-tags
```

CI (`.gitverse/workflows/release.yaml`, triggered by a `v*` tag or a manual
`workflow_dispatch`) runs build/typecheck/lint/tests and publishes the package to
**npmjs.org** (`NPM_TOKEN`). Ordinary pushes/PRs publish nothing.

## Documentation

- **[docs/contract.md](./docs/contract.md)** — the public API specification
  (modules, channel contract, invariants, migration map).
- [ADR-103](../../synth/docs/arch_decisions/adr-103-gateway-core-channel-contract.md) —
  the core and the channel contract; [ADR-087](../../synth/docs/arch_decisions/adr-087-gateways.md) —
  the Gateway class.
- [AGENTS.md](./AGENTS.md) — repository conventions.

## License

MIT — see [LICENSE](LICENSE).
