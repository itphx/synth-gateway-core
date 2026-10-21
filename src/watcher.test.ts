import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { BearerProvider } from './auth.js';
import type { ChannelAdapter } from './channel.js';
import type { StateStore } from './store.js';
import type { ActionRequest, ChannelCapabilities, DeliveryRequest, DeliveryResult } from './types.js';
import { ADDED_FALLBACK_GRACE_MS, parseSseData, ResponseWatcher } from './watcher.js';

/**
 * Состояние в памяти: ускорение тестов и отсутствие файлового ввода-вывода
 * в горячем цикле доставки. Публичный API `StateStore` тут не меняется —
 * используется только `read`/`write`, которые и нужны `KeySet`/`RecordStore`.
 */
class MemoryStateStore {
  private readonly buckets = new Map<string, unknown>();

  async read<T>(bucket: string): Promise<T | null> {
    const value = this.buckets.get(bucket);
    return value === undefined ? null : (value as T);
  }

  async write<T>(bucket: string, value: T): Promise<void> {
    this.buckets.set(bucket, value);
  }

  async remove(bucket: string): Promise<boolean> {
    return this.buckets.delete(bucket);
  }

  bucketPath(bucket: string): string {
    return bucket;
  }

  async init(): Promise<void> {
    /* состояние в памяти — инициализация не нужна */
  }
}

/** Канал-заглушка: собирает доставки и возвращает id сообщения. */
class TestChannel implements ChannelAdapter {
  readonly source = 'test';
  readonly capabilities: ChannelCapabilities;
  readonly sends: DeliveryRequest[] = [];
  /** Действия чата (`typing` и т.п.). */
  readonly actionCalls: ActionRequest[] = [];

  constructor(capabilities: Partial<ChannelCapabilities> = {}) {
    this.capabilities = {
      streaming: false,
      editing: false,
      drafts: false,
      threads: false,
      attachments: false,
      deleting: false,
      actions: false,
      ...capabilities,
    };
  }

  async start(): Promise<void> {
    /* приём в тестах не эмулируется */
  }

  async stop(): Promise<void> {
    /* приём в тестах не эмулируется */
  }

  async send(req: DeliveryRequest): Promise<DeliveryResult> {
    this.sends.push(req);
    return { messageId: `m${this.sends.length}` };
  }

  async actions(req: ActionRequest): Promise<void> {
    this.actionCalls.push(req);
  }
}

/** SSE-поток под управлением теста. */
interface SseHarness {
  response: Response;
  push(event: unknown): void;
  close(): void;
}

function createSse(): SseHarness {
  const encoder = new TextEncoder();
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
  });
  return {
    response: new Response(stream, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    }),
    push(event: unknown): void {
      controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
    },
    close(): void {
      controller.close();
    },
  };
}

/** Прогоняет отложенные задачи (микро-очередь + fake-таймеры). */
async function flush(): Promise<void> {
  for (let i = 0; i < 10; i += 1) {
    await vi.advanceTimersByTimeAsync(0);
  }
}

const ROUTE = {
  sessionId: 'sess_1',
  target: { chatId: '100' },
  inboundMessageId: '55',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

describe('parseSseData', () => {
  it('разбирает кадры, игнорирует keepalive-комментарии и возвращает хвост буфера', () => {
    expect(parseSseData('data: {"a":1}\n\n')).toEqual({ payloads: ['{"a":1}'], rest: '' });
    expect(parseSseData(': keepalive\n\ndata: {"b":2}\n\n')).toEqual({
      payloads: ['{"b":2}'],
      rest: '',
    });
    expect(parseSseData('data: {"a":1}\n\ndata: tail')).toEqual({
      payloads: ['{"a":1}'],
      rest: 'data: tail',
    });
    expect(parseSseData('')).toEqual({ payloads: [], rest: '' });
  });
});

describe('ResponseWatcher', () => {
  let state: StateStore;

  beforeEach(async () => {
    vi.useFakeTimers();
    const memory = new MemoryStateStore();
    state = memory as unknown as StateStore;
    await state.write('routes', { sess_1: ROUTE });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function createWatcher(options: {
    channel: ChannelAdapter;
    fetchImpl: typeof fetch;
    bearer?: BearerProvider;
  }): ResponseWatcher {
    return new ResponseWatcher({
      baseUrl: 'http://127.0.0.1:5000/api/v2',
      apiKey: 'secret-key',
      channel: options.channel,
      state,
      fetchImpl: options.fetchImpl,
      ...(options.bearer ? { bearer: options.bearer } : {}),
    });
  }

  it('stream.done → доставка kind=final с полным текстом', async () => {
    const sse = createSse();
    const channel = new TestChannel();
    const watcher = createWatcher({
      channel,
      fetchImpl: (async () => sse.response) as unknown as typeof fetch,
    });
    const running = watcher.run();
    await flush();

    sse.push({
      type: 'stream.done',
      sessionId: 'sess_1',
      data: { stream_id: 'st1', content: 'Полный ответ' },
    });
    await flush();

    expect(channel.sends).toHaveLength(1);
    expect(channel.sends[0]?.kind).toBe('final');
    expect(channel.sends[0]?.content).toBe('Полный ответ');
    expect(channel.sends[0]?.streamId).toBe('st1');
    expect(channel.sends[0]?.route).toEqual(ROUTE);

    await watcher.stop();
    await running;
  });

  it('message.added (assistant) → доставка только после grace-паузы', async () => {
    const sse = createSse();
    const channel = new TestChannel();
    const watcher = createWatcher({
      channel,
      fetchImpl: (async () => sse.response) as unknown as typeof fetch,
    });
    const running = watcher.run();
    await flush();

    sse.push({
      type: 'message.added',
      sessionId: 'sess_1',
      data: { role: 'assistant', content: 'Огрызок', message_index: 3 },
    });
    await flush();

    // Сразу ничего не доставляется — ждём, не придёт ли полный стрим.
    expect(channel.sends).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(ADDED_FALLBACK_GRACE_MS);
    await flush();

    expect(channel.sends).toHaveLength(1);
    expect(channel.sends[0]?.kind).toBe('final');
    expect(channel.sends[0]?.content).toBe('Огрызок');

    await watcher.stop();
    await running;
  });

  it('message.added + stream.done в grace-паузе → отложенная доставка отменена, отправка одна', async () => {
    const sse = createSse();
    const channel = new TestChannel();
    const watcher = createWatcher({
      channel,
      fetchImpl: (async () => sse.response) as unknown as typeof fetch,
    });
    const running = watcher.run();
    await flush();

    sse.push({
      type: 'message.added',
      sessionId: 'sess_1',
      data: { role: 'assistant', content: 'Огрызок', message_index: 3 },
    });
    await flush();
    sse.push({
      type: 'stream.done',
      sessionId: 'sess_1',
      data: { stream_id: 'st1', content: 'Полный ответ', message_index: 3 },
    });
    await flush();

    expect(channel.sends).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(ADDED_FALLBACK_GRACE_MS);
    await flush();

    expect(channel.sends).toHaveLength(1);
    expect(channel.sends[0]?.kind).toBe('final');
    expect(channel.sends[0]?.content).toBe('Полный ответ');

    await watcher.stop();
    await running;
  });

  it('message.added без message_index + stream.done → отложенная доставка отменена, отправка одна', async () => {
    const sse = createSse();
    const channel = new TestChannel();
    const watcher = createWatcher({
      channel,
      fetchImpl: (async () => sse.response) as unknown as typeof fetch,
    });
    const running = watcher.run();
    await flush();

    // Без `message_index` и `metadata.stream_id`: дедуп по ключу ответа не
    // спасает — отмену отложенной доставки делает сам `stream.done`.
    sse.push({
      type: 'message.added',
      sessionId: 'sess_1',
      data: { role: 'assistant', content: 'Огрызок' },
    });
    await flush();
    sse.push({
      type: 'stream.done',
      sessionId: 'sess_1',
      data: { stream_id: 'st1', content: 'Полный ответ' },
    });
    await flush();

    await vi.advanceTimersByTimeAsync(ADDED_FALLBACK_GRACE_MS);
    await flush();

    expect(channel.sends).toHaveLength(1);
    expect(channel.sends[0]?.kind).toBe('final');
    expect(channel.sends[0]?.content).toBe('Полный ответ');

    await watcher.stop();
    await running;
  });

  it('message.added (user) не доставляется', async () => {
    const sse = createSse();
    const channel = new TestChannel();
    const watcher = createWatcher({
      channel,
      fetchImpl: (async () => sse.response) as unknown as typeof fetch,
    });
    const running = watcher.run();
    await flush();

    sse.push({
      type: 'message.added',
      sessionId: 'sess_1',
      data: { role: 'user', content: 'Входящее' },
    });
    await flush();
    await vi.advanceTimersByTimeAsync(ADDED_FALLBACK_GRACE_MS);
    await flush();

    expect(channel.sends).toHaveLength(0);

    await watcher.stop();
    await running;
  });

  it('дедуп: два одинаковых stream.done → одна доставка', async () => {
    const sse = createSse();
    const channel = new TestChannel();
    const watcher = createWatcher({
      channel,
      fetchImpl: (async () => sse.response) as unknown as typeof fetch,
    });
    const running = watcher.run();
    await flush();

    const done = {
      type: 'stream.done',
      sessionId: 'sess_1',
      data: { stream_id: 'st1', content: 'Полный ответ' },
    };
    sse.push(done);
    await flush();
    sse.push(done);
    await flush();

    expect(channel.sends).toHaveLength(1);

    await watcher.stop();
    await running;
  });

  it('capabilities.streaming=false → частичных доставок нет, финальная одна', async () => {
    const sse = createSse();
    const channel = new TestChannel({ streaming: false });
    const watcher = createWatcher({
      channel,
      fetchImpl: (async () => sse.response) as unknown as typeof fetch,
    });
    const running = watcher.run();
    await flush();

    sse.push({
      type: 'stream.chunk',
      sessionId: 'sess_1',
      data: { stream_id: 'st1', content: 'При' },
    });
    sse.push({
      type: 'stream.chunk',
      sessionId: 'sess_1',
      data: { stream_id: 'st1', content: 'вет' },
    });
    await flush();

    expect(channel.sends).toHaveLength(0);

    sse.push({
      type: 'stream.done',
      sessionId: 'sess_1',
      data: { stream_id: 'st1' },
    });
    await flush();

    expect(channel.sends).toHaveLength(1);
    expect(channel.sends[0]?.kind).toBe('final');
    expect(channel.sends[0]?.content).toBe('Привет');

    await watcher.stop();
    await running;
  });

  it('capabilities.streaming=true → вторая частичная доставка несёт replaceMessageId', async () => {
    const sse = createSse();
    const channel = new TestChannel({ streaming: true });
    const watcher = createWatcher({
      channel,
      fetchImpl: (async () => sse.response) as unknown as typeof fetch,
    });
    const running = watcher.run();
    await flush();

    sse.push({
      type: 'stream.chunk',
      sessionId: 'sess_1',
      data: { stream_id: 'st1', content: 'Привет' },
    });
    await flush();
    sse.push({
      type: 'stream.chunk',
      sessionId: 'sess_1',
      data: { stream_id: 'st1', content: ' мир' },
    });
    await flush();

    expect(channel.sends).toHaveLength(2);
    expect(channel.sends[0]?.kind).toBe('partial');
    expect(channel.sends[0]?.content).toBe('Привет');
    expect(channel.sends[0]?.replaceMessageId).toBeUndefined();
    expect(channel.sends[1]?.kind).toBe('partial');
    expect(channel.sends[1]?.content).toBe('Привет мир');
    expect(channel.sends[1]?.replaceMessageId).toBe('m1');

    await watcher.stop();
    await running;
  });

  it('ошибка канала не приводит к повторной доставке (ключ дедупа ставится до отправки)', async () => {
    const sse = createSse();
    const channel = new TestChannel();
    let attempts = 0;
    channel.send = async (req: DeliveryRequest): Promise<DeliveryResult> => {
      attempts += 1;
      channel.sends.push(req);
      throw new Error('канал недоступен');
    };
    const watcher = createWatcher({
      channel,
      fetchImpl: (async () => sse.response) as unknown as typeof fetch,
    });
    const running = watcher.run();
    await flush();

    const done = {
      type: 'stream.done',
      sessionId: 'sess_1',
      data: { stream_id: 'st1', content: 'Полный ответ' },
    };
    sse.push(done);
    await flush();
    sse.push(done);
    await flush();

    expect(attempts).toBe(1);

    await watcher.stop();
    await running;
  });

  it('событие сессии без маршрута игнорируется', async () => {
    const sse = createSse();
    const channel = new TestChannel();
    const watcher = createWatcher({
      channel,
      fetchImpl: (async () => sse.response) as unknown as typeof fetch,
    });
    const running = watcher.run();
    await flush();

    sse.push({
      type: 'stream.done',
      sessionId: 'sess_other',
      data: { stream_id: 'st9', content: 'Чужой ответ' },
    });
    await flush();

    expect(channel.sends).toHaveLength(0);

    await watcher.stop();
    await running;
  });

  it('401 → один refresh bearer и переподключение', async () => {
    const sse = createSse();
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockResolvedValue(sse.response);
    const bearer: BearerProvider = {
      getBearer: vi.fn(async () => 'token-1'),
      refreshBearer: vi.fn(async () => 'token-2'),
    };
    const channel = new TestChannel();
    const watcher = createWatcher({
      channel,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      bearer,
    });
    const running = watcher.run();
    await flush();

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(bearer.refreshBearer).toHaveBeenCalledTimes(1);

    sse.push({
      type: 'stream.done',
      sessionId: 'sess_1',
      data: { stream_id: 'st1', content: 'Полный ответ' },
    });
    await flush();

    expect(channel.sends).toHaveLength(1);
    expect(channel.sends[0]?.content).toBe('Полный ответ');

    await watcher.stop();
    await running;
  });

  it('capabilities.actions=true → индикатор набора один раз на стрим', async () => {
    const sse = createSse();
    const channel = new TestChannel({ actions: true });
    const watcher = createWatcher({
      channel,
      fetchImpl: (async () => sse.response) as unknown as typeof fetch,
    });
    const running = watcher.run();
    await flush();

    sse.push({
      type: 'stream.chunk',
      sessionId: 'sess_1',
      data: { stream_id: 'st1', content: 'При' },
    });
    await flush();
    sse.push({
      type: 'stream.chunk',
      sessionId: 'sess_1',
      data: { stream_id: 'st1', content: 'вет' },
    });
    await flush();

    expect(channel.actionCalls).toHaveLength(1);
    expect(channel.actionCalls[0]?.type).toBe('typing');
    expect(channel.actionCalls[0]?.route).toEqual(ROUTE);

    await watcher.stop();
    await running;
  });

  it('capabilities.actions=true → новый стрим → новый индикатор набора', async () => {
    const sse = createSse();
    const channel = new TestChannel({ actions: true });
    const watcher = createWatcher({
      channel,
      fetchImpl: (async () => sse.response) as unknown as typeof fetch,
    });
    const running = watcher.run();
    await flush();

    sse.push({
      type: 'stream.chunk',
      sessionId: 'sess_1',
      data: { stream_id: 'st1', content: 'Первый' },
    });
    await flush();
    sse.push({
      type: 'stream.chunk',
      sessionId: 'sess_1',
      data: { stream_id: 'st2', content: 'Второй' },
    });
    await flush();

    expect(channel.actionCalls).toHaveLength(2);
    expect(channel.actionCalls.map((call) => call.type)).toEqual(['typing', 'typing']);

    await watcher.stop();
    await running;
  });

  it('capabilities.actions=false → действий чата нет', async () => {
    const sse = createSse();
    const channel = new TestChannel({ actions: false });
    const watcher = createWatcher({
      channel,
      fetchImpl: (async () => sse.response) as unknown as typeof fetch,
    });
    const running = watcher.run();
    await flush();

    sse.push({
      type: 'stream.chunk',
      sessionId: 'sess_1',
      data: { stream_id: 'st1', content: 'Привет' },
    });
    await flush();

    expect(channel.actionCalls).toHaveLength(0);

    await watcher.stop();
    await running;
  });

  it('канал без метода actions → действий чата нет', async () => {
    const sse = createSse();
    // Канал объявляет `actions`, но метода не реализует — вызова быть не должно.
    const channel: ChannelAdapter = {
      source: 'test',
      capabilities: {
        streaming: false,
        editing: false,
        drafts: false,
        threads: false,
        attachments: false,
        deleting: false,
        actions: true,
      },
      start: async () => {},
      stop: async () => {},
      send: async () => ({}),
    };
    const watcher = createWatcher({
      channel,
      fetchImpl: (async () => sse.response) as unknown as typeof fetch,
    });
    const running = watcher.run();
    await flush();

    sse.push({
      type: 'stream.chunk',
      sessionId: 'sess_1',
      data: { stream_id: 'st1', content: 'Привет' },
    });
    await flush();

    expect(channel.actions).toBeUndefined();

    await watcher.stop();
    await running;
  });

  it('ошибка действия канала не роняет watcher: доставка продолжается', async () => {
    const sse = createSse();
    const channel = new TestChannel({ actions: true, streaming: true });
    channel.actions = async (): Promise<void> => {
      throw new Error('действие недоступно');
    };
    const watcher = createWatcher({
      channel,
      fetchImpl: (async () => sse.response) as unknown as typeof fetch,
    });
    const running = watcher.run();
    await flush();

    sse.push({
      type: 'stream.chunk',
      sessionId: 'sess_1',
      data: { stream_id: 'st1', content: 'Привет' },
    });
    await flush();

    expect(channel.sends).toHaveLength(1);
    expect(channel.sends[0]?.kind).toBe('partial');

    await watcher.stop();
    await running;
  });
});
