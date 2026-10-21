import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

import type { ChannelAdapter, ChannelContext } from './channel.js';
import type { ChannelTenantSchema, GatewayDefaults, TenantConfig } from './config.js';
import { createGatewayRuntime, runGateway, type ChannelDeps, type GatewayConfig, type GatewayOptions } from './runtime.js';
import type { InboundMessage, MarkReadRequest, NoticeRequest } from './types.js';

/** Базовый URL «Synth» в тестах — ни один реальный адрес не опрашивается. */
const SYNTH_URL = 'http://synth.test/api/v2';

/** Конфигурация канала в тестах (произвольная — ядру всё равно). */
interface TestChannel {
  token: string;
}

/** Схема канальной секции тенанта (ключи записи `tenants.json`). */
const schema: ChannelTenantSchema<TestChannel> = {
  keys: ['token'],
  parse: (raw) => ({ token: typeof raw.token === 'string' ? raw.token : '' }),
};

/** Глобальные дефолты тенанта. */
const defaults: GatewayDefaults<TestChannel> = {
  synth: { baseUrl: SYNTH_URL, oidc: {} },
  allowlist: {},
  unknownAction: 'register',
  watch: true,
  channel: { token: '' },
};

/** Тенант по умолчанию. */
function tenant(overrides: Partial<TenantConfig<TestChannel>> = {}): TenantConfig<TestChannel> {
  return {
    id: 'dev',
    channel: { token: 'bot-token' },
    synth: { baseUrl: SYNTH_URL, serviceKey: 'synth_svc_test', oidc: {} },
    allowlist: { 'chat:1': 'USER' },
    unknownAction: 'register',
    watch: true,
    ...overrides,
  };
}

/** Входящее сообщение канала. */
function message(overrides: Partial<InboundMessage> = {}): InboundMessage {
  return {
    dedupKey: 'test:1',
    identity: { principalId: 'test:u1', chatKey: 'chat:1', accessKeys: ['chat:1'] },
    text: 'Привет',
    target: { chatId: '1' },
    ...overrides,
  };
}

/** Ответ приёма `POST /events`. */
function ingestResponse(): unknown {
  return {
    event: {
      id: 'evt_1',
      source: 'test',
      type: 'message',
      payload: {},
      identity: {},
      dedupKey: 'test:1',
      ts: '2026-01-01T00:00:00.000Z',
    },
    decision: { kind: 'bound' },
    sessionId: 'sess_1',
  };
}

/** Запрос к «Synth», зафиксированный заглушкой fetch. */
interface FetchCall {
  url: string;
  method: string;
  body?: string;
}

/** Заглушка `fetch`: отвечает за Synth, остальное — настоящему fetch. */
interface FetchStub {
  calls: FetchCall[];
  /** SSE-поток закрыт (watcher остановлен). */
  sseCancelled: () => boolean;
}

/** Настройки заглушки приёма событий. */
interface FetchStubOptions {
  /** Статус ответа `POST /events` (по умолчанию 201). */
  ingestStatus?: number;
  /** Тело ответа `POST /events`. */
  ingestBody?: unknown;
}

/** Ошибка отмены запроса (как у настоящего `fetch` при abort). */
function abortError(): Error {
  const error = new Error('The operation was aborted');
  error.name = 'AbortError';
  return error;
}

function createFetchStub(options: FetchStubOptions = {}): FetchStub {
  const original = globalThis.fetch;
  const calls: FetchCall[] = [];
  let cancelled = false;

  const stub = (async (
    input: Parameters<typeof fetch>[0],
    init?: RequestInit,
  ): Promise<Response> => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const method = (init?.method ?? 'GET').toUpperCase();
    calls.push({
      url,
      method,
      ...(typeof init?.body === 'string' ? { body: init.body } : {}),
    });

    // Всё, что не «Synth», — реальные запросы (health-сервер рантайма).
    if (!url.startsWith(SYNTH_URL)) return original(input, init);

    const signal = init?.signal;
    if (signal?.aborted) throw abortError();

    if (url.endsWith('/events') && method === 'GET') {
      // SSE-поток: как настоящий, реагирует на отмену запроса.
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(':keepalive\n\n'));
          signal?.addEventListener('abort', () => {
            cancelled = true;
            try {
              controller.error(abortError());
            } catch {
              /* поток уже закрыт */
            }
          });
        },
        cancel() {
          cancelled = true;
        },
      });
      return new Response(stream, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      });
    }

    if (url.endsWith('/events') && method === 'POST') {
      const status = options.ingestStatus ?? 201;
      return new Response(
        JSON.stringify(options.ingestBody ?? ingestResponse()),
        {
          status,
          headers: { 'content-type': 'application/json' },
        },
      );
    }

    return new Response(JSON.stringify({ status: 'ok' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;

  vi.stubGlobal('fetch', stub);
  return { calls, sseCancelled: () => cancelled };
}

/** Свободный порт (для health-сервера рантайма). */
async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  const port = address !== null && typeof address === 'object' ? address.port : 0;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

/** Ждёт, пока health-сервер начнёт отвечать. */
async function waitForHealth(port: number, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      if (response.ok) return;
    } catch {
      /* сервер ещё не поднят */
    }
    if (Date.now() > deadline) throw new Error('health-сервер не поднялся');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

describe('runGateway (рантайм ядра шлюза)', () => {
  let dir: string;
  let stub: FetchStub;
  let captured: { tenant: TenantConfig<TestChannel>; deps: ChannelDeps }[];
  let start: Mock<(ctx: ChannelContext) => Promise<void>>;
  let stop: Mock<() => Promise<void>>;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'gateway-core-runtime-'));
    stub = createFetchStub();
    captured = [];
    start = vi.fn(async (_ctx: ChannelContext) => {});
    stop = vi.fn(async () => {});
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    await rm(dir, { recursive: true, force: true });
  });

  /** Канал-заглушка: фиксирует вызовы, наружу не ходит. */
  function fakeChannel(): ChannelAdapter {
    return {
      source: 'test',
      capabilities: {
        streaming: false,
        editing: false,
        drafts: false,
        threads: false,
        attachments: false,
        deleting: false,
        actions: false,
      },
      start,
      stop,
      send: vi.fn(async () => ({})),
    };
  }

  /** Опции рантайма: канал-заглушка + дефолты. */
  function options(): GatewayOptions<TestChannel> {
    return {
      version: '9.9.9',
      schema,
      defaults,
      createChannel: (t, deps) => {
        captured.push({ tenant: t, deps });
        return fakeChannel();
      },
    };
  }

  /** Конфигурация рантайма. */
  function config(overrides: Partial<GatewayConfig<TestChannel>> = {}): GatewayConfig<TestChannel> {
    return {
      version: '9.9.9',
      dataDir: dir,
      host: '127.0.0.1',
      port: 0,
      dryRun: false,
      watch: true,
      tenants: [tenant()],
      ...overrides,
    };
  }

  it('health-сервер отвечает без токена: 200, статус, версия и тенанты', async () => {
    const runtime = await createGatewayRuntime(config(), options());
    try {
      const response = await fetch(`http://127.0.0.1:${runtime.healthPort}/health`);
      expect(response.status).toBe(200);
      const body = (await response.json()) as Record<string, unknown>;
      expect(body.status).toBeDefined();
      expect(body.version).toBe('9.9.9');
      expect(body.tenants).toBeDefined();
      expect(Object.keys(body.tenants as Record<string, unknown>)).toContain('dev');
    } finally {
      await runtime.stop();
    }
  });

  it('для тенанта создаются state/api/auth/канал, а publish доходит до POST /events', async () => {
    const runtime = await createGatewayRuntime(config(), options());
    try {
      expect(captured).toHaveLength(1);
      const deps = captured[0]?.deps;
      expect(deps).toBeDefined();
      expect(deps?.state).toBeDefined();
      expect(deps?.synth).toBeDefined();
      expect(deps?.auth).toBeDefined();
      expect(deps?.health).toBeDefined();
      expect(typeof deps?.publish).toBe('function');
      expect(start).toHaveBeenCalledTimes(1);

      const result = await deps?.publish(message());
      expect(result?.sessionId).toBe('sess_1');

      const post = stub.calls.find((call) => call.method === 'POST' && call.url.endsWith('/events'));
      expect(post).toBeDefined();
      const body = JSON.parse(post?.body ?? '{}') as Record<string, unknown>;
      expect(body.source).toBe('test');
      expect(body.type).toBe('message');
      expect((body.payload as Record<string, unknown>).text).toBe('Привет');
      expect((body.identity as Record<string, unknown>).roles).toEqual(['USER']);
    } finally {
      await runtime.stop();
    }
  });

  it('publish при отказе политики не бросает — возвращает { sessionId: null }', async () => {
    const runtime = await createGatewayRuntime(config(), options());
    try {
      const deps = captured[0]?.deps;
      const result = await deps?.publish(
        message({ identity: { principalId: 'test:u2', accessKeys: ['chat:unknown'] } }),
      );
      expect(result).toEqual({ sessionId: null });
      expect(stub.calls.filter((call) => call.method === 'POST')).toHaveLength(0);
    } finally {
      await runtime.stop();
    }
  });

  it('publish при ошибке публикации не бросает — возвращает { sessionId: null }', async () => {
    vi.unstubAllGlobals();
    stub = createFetchStub({
      ingestStatus: 403,
      ingestBody: { error: { code: 'FORBIDDEN', message: 'нельзя' } },
    });
    const runtime = await createGatewayRuntime(config(), options());
    try {
      const deps = captured[0]?.deps;
      const result = await deps?.publish(message());
      expect(result).toEqual({ sessionId: null });
    } finally {
      await runtime.stop();
    }
  });

  it('код линковки уходит в канал через notify (политика hint)', async () => {
    vi.unstubAllGlobals();
    stub = createFetchStub({
      ingestBody: {
        ...(ingestResponse() as Record<string, unknown>),
        identityHint: { code: 'claim-42', expiresAt: '2026-01-01T00:10:00.000Z' },
      },
    });
    const notify = vi.fn(async (_req: NoticeRequest) => {});
    const runtime = await createGatewayRuntime(
      config({ tenants: [tenant({ unknownAction: 'hint' })] }),
      {
        ...options(),
        createChannel: (t, deps) => {
          captured.push({ tenant: t, deps });
          return { ...fakeChannel(), notify };
        },
      },
    );
    try {
      const deps = captured[0]?.deps;
      const result = await deps?.publish(message());
      expect(result?.identityHint?.code).toBe('claim-42');
      expect(notify).toHaveBeenCalledTimes(1);
      const request = notify.mock.calls[0]?.[0];
      expect(request?.claimCode).toBe('claim-42');
      expect(request?.target).toEqual({ chatId: '1' });
    } finally {
      await runtime.stop();
    }
  });

  it('после успешной публикации канал получает markRead с маршрутом из состояния', async () => {
    const markRead = vi.fn(async (_req: MarkReadRequest) => {});
    const runtime = await createGatewayRuntime(config(), {
      ...options(),
      createChannel: (t, deps) => {
        captured.push({ tenant: t, deps });
        return { ...fakeChannel(), markRead };
      },
    });
    try {
      const deps = captured[0]?.deps;
      const result = await deps?.publish(message({ inboundMessageId: '42' }));
      expect(result?.sessionId).toBe('sess_1');
      expect(markRead).toHaveBeenCalledTimes(1);
      const request = markRead.mock.calls[0]?.[0];
      expect(request?.inboundMessageId).toBe('42');
      expect(request?.route).toMatchObject({
        sessionId: 'sess_1',
        target: { chatId: '1' },
        inboundMessageId: '42',
      });
    } finally {
      await runtime.stop();
    }
  });

  it('ошибка channel.start не валит процесс: канал помечается в health', async () => {
    const runtime = await createGatewayRuntime(config(), {
      ...options(),
      createChannel: (t, deps) => {
        captured.push({ tenant: t, deps });
        return {
          ...fakeChannel(),
          start: vi.fn(async () => {
            throw new Error('нет связи с внешним миром');
          }),
        };
      },
    });
    try {
      const response = await fetch(`http://127.0.0.1:${runtime.healthPort}/health`);
      expect(response.status).toBe(200);
      const body = (await response.json()) as { status: string; tenants: Record<string, { channel: string }> };
      expect(body.status).toBe('degraded');
      expect(body.tenants.dev?.channel).toBe('unknown');
    } finally {
      await runtime.stop();
    }
  });

  it('dry-run: внешних вызовов нет, канал не подключается наружу', async () => {
    const runtime = await createGatewayRuntime(config({ dryRun: true }), options());
    try {
      expect(start).not.toHaveBeenCalled();
      expect(stub.calls.filter((call) => call.url.startsWith(SYNTH_URL))).toHaveLength(0);
      const response = await fetch(`http://127.0.0.1:${runtime.healthPort}/health`);
      expect(response.status).toBe(200);
    } finally {
      await runtime.stop();
    }
  });

  it('stop(): канал остановлен, watcher погашен, health-сервер закрыт', async () => {
    const runtime = await createGatewayRuntime(config(), options());
    await waitForHealth(runtime.healthPort);
    // watcher подключился к SSE — значит цикл доставки запущен.
    await vi.waitFor(() => {
      expect(stub.calls.some((call) => call.method === 'GET' && call.url.endsWith('/events'))).toBe(
        true,
      );
    });

    await runtime.stop();

    expect(stop).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => {
      expect(stub.sseCancelled()).toBe(true);
    });
    await expect(fetch(`http://127.0.0.1:${runtime.healthPort}/health`)).rejects.toThrow();
  });

  it('runGateway: сигнал остановки гасит watcher и канал', async () => {
    const onSpy = vi.spyOn(process, 'on');
    const port = await freePort();
    const run = runGateway(config({ port }), { ...options(), signals: ['SIGUSR2'] });
    await waitForHealth(port);

    // Обработчик сигнала — тот же, что повесил бы Node на SIGUSR2; вызываем
    // его напрямую, чтобы тест не зависел от доставки реального сигнала.
    await vi.waitFor(() => {
      expect(onSpy.mock.calls.some((call) => call[0] === 'SIGUSR2')).toBe(true);
    });
    const handler = onSpy.mock.calls.find((call) => call[0] === 'SIGUSR2')?.[1] as
      | (() => void)
      | undefined;
    expect(handler).toBeDefined();
    handler?.();

    await run;

    expect(stop).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => {
      expect(stub.sseCancelled()).toBe(true);
    });
  });

  it('runGateway по умолчанию слушает SIGINT и SIGTERM', async () => {
    const onSpy = vi.spyOn(process, 'on');
    const port = await freePort();
    const run = runGateway(config({ port }), options());
    await waitForHealth(port);

    await vi.waitFor(() => {
      expect(onSpy.mock.calls.some((call) => call[0] === 'SIGTERM')).toBe(true);
    });
    const signals = onSpy.mock.calls.map((call) => call[0]);
    expect(signals).toContain('SIGINT');
    expect(signals).toContain('SIGTERM');

    // Остановка: вызываем обработчик SIGINT напрямую (без реального сигнала).
    const handler = onSpy.mock.calls.find((call) => call[0] === 'SIGINT')?.[1] as
      | (() => void)
      | undefined;
    expect(handler).toBeDefined();
    handler?.();
    await run;
  });
});
