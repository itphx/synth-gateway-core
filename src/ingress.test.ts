import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { EventInput, IngestResult, SynthApi } from './api.js';
import { Ingress } from './ingress.js';
import { StateStore } from './store.js';
import type { InboundMessage, SessionRoute } from './types.js';

/** Ответ приёма `POST /events` по умолчанию. */
function ingestResult(overrides: Partial<IngestResult> = {}): IngestResult {
  return {
    event: {
      id: 'evt_1',
      source: 'telegram',
      type: 'message',
      payload: {},
      identity: {},
      dedupKey: 'tg:1:100',
      ts: '2026-01-01T00:00:00.000Z',
    },
    decision: { kind: 'opened' },
    sessionId: 'sess_1',
    ...overrides,
  };
}

/** Заглушка клиента API: проверяем только `postEvent`. */
function fakeApi(postEvent: ReturnType<typeof vi.fn>): SynthApi {
  return { postEvent } as unknown as SynthApi;
}

/** Нормализованное входящее сообщение (значения по умолчанию). */
function message(overrides: Partial<InboundMessage> = {}): InboundMessage {
  return {
    dedupKey: 'tg:1:100',
    identity: {
      principalId: 'telegram:100',
      chatKey: 'chat:telegram:100',
      accessKeys: ['chat:telegram:100'],
    },
    text: 'Привет',
    target: { chatId: '100' },
    inboundMessageId: '55',
    ...overrides,
  };
}

describe('Ingress', () => {
  let dir: string;
  let state: StateStore;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'gateway-core-ingress-'));
    state = new StateStore(dir);
    await state.init();
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  function ingress(
    postEvent: ReturnType<typeof vi.fn>,
    overrides: Partial<ConstructorParameters<typeof Ingress>[0]> = {},
  ): Ingress {
    return new Ingress({
      api: fakeApi(postEvent),
      state,
      allowlist: { 'chat:telegram:100': 'admin' },
      unknownAction: 'register',
      source: 'telegram',
      ...overrides,
    });
  }

  it('allowlist: найденный ключ даёт роль в identity.roles и событие публикуется', async () => {
    const postEvent = vi.fn(async (_input: EventInput) => ingestResult());

    const outcome = await ingress(postEvent).handle(message());

    expect(outcome).toEqual({ status: 'published', sessionId: 'sess_1' });
    expect(postEvent).toHaveBeenCalledTimes(1);
    const input = postEvent.mock.calls[0]?.[0];
    expect(input?.source).toBe('telegram');
    expect(input?.type).toBe('message');
    expect(input?.dedupKey).toBe('tg:1:100');
    expect(input?.payload).toEqual({ text: 'Привет' });
    expect(input?.identity).toMatchObject({
      principalId: 'telegram:100',
      chatKey: 'chat:telegram:100',
      roles: ['ADMIN'],
    });
  });

  it('allowlist: первый найденный ключ из accessKeys определяет роль', async () => {
    const postEvent = vi.fn(async (_input: EventInput) => ingestResult());

    await ingress(postEvent, {
      allowlist: { 'chat:telegram:200': 'user', 'chat:telegram:100': 'lead' },
    }).handle(
      message({
        identity: {
          principalId: 'telegram:100',
          chatKey: 'chat:telegram:100',
          accessKeys: ['chat:telegram:999', 'chat:telegram:200', 'chat:telegram:100'],
        },
      }),
    );

    const input = postEvent.mock.calls[0]?.[0];
    expect(input?.identity?.roles).toEqual(['USER']);
  });

  it('allowlist: отправитель вне списка доступа → not_allowed, публикации нет', async () => {
    const postEvent = vi.fn(async (_input: EventInput) => ingestResult());

    const outcome = await ingress(postEvent).handle(
      message({
        identity: {
          principalId: 'telegram:999',
          chatKey: 'chat:telegram:999',
          accessKeys: ['chat:telegram:999'],
        },
      }),
    );

    expect(outcome).toEqual({ status: 'rejected', reason: 'not_allowed' });
    expect(postEvent).not.toHaveBeenCalled();
  });

  it('дедуп: повторный dedupKey → duplicate, публикация была один раз', async () => {
    const postEvent = vi.fn(async (_input: EventInput) => ingestResult());
    const core = ingress(postEvent);

    const first = await core.handle(message());
    const second = await core.handle(message());

    expect(first.status).toBe('published');
    expect(second).toEqual({ status: 'rejected', reason: 'duplicate' });
    expect(postEvent).toHaveBeenCalledTimes(1);
  });

  it('ошибка публикации → failed, дедуп-ключ не фиксируется (повтор возможен)', async () => {
    const error = new Error('synth недоступен');
    const postEvent = vi.fn(async (_input: EventInput) => {
      throw error;
    });
    const core = ingress(postEvent);

    const outcome = await core.handle(message());

    expect(outcome).toEqual({ status: 'failed', error });
    expect(postEvent).toHaveBeenCalledTimes(1);

    // Повтор допустим: ключ дедупа не зафиксирован.
    const retry = await core.handle(message());
    expect(retry.status).toBe('failed');
    expect(postEvent).toHaveBeenCalledTimes(2);
  });

  it('unknownAction=reject: неизвестный отправитель → unknown_sender, публикации нет', async () => {
    const postEvent = vi.fn(async (_input: EventInput) => ingestResult());
    const isSenderKnown = vi.fn(async () => false);

    const outcome = await ingress(postEvent, { unknownAction: 'reject', isSenderKnown }).handle(
      message(),
    );

    expect(outcome).toEqual({ status: 'rejected', reason: 'unknown_sender' });
    expect(postEvent).not.toHaveBeenCalled();
  });

  it('unknownAction=reject: известный отправитель публикуется', async () => {
    const postEvent = vi.fn(async (_input: EventInput) => ingestResult());
    const isSenderKnown = vi.fn(async () => true);

    const outcome = await ingress(postEvent, { unknownAction: 'reject', isSenderKnown }).handle(
      message(),
    );

    expect(outcome.status).toBe('published');
    expect(postEvent).toHaveBeenCalledTimes(1);
  });

  it('unknownAction=hint: код линковки передаётся каналу после публикации', async () => {
    const postEvent = vi.fn(async (_input: EventInput) =>
      ingestResult({ identityHint: { code: 'code-42', expiresAt: '2026-01-01T00:10:00.000Z' } }),
    );
    const onIdentityHint = vi.fn();
    const inbound = message();

    const outcome = await ingress(postEvent, { unknownAction: 'hint', onIdentityHint }).handle(
      inbound,
    );

    expect(postEvent).toHaveBeenCalledTimes(1);
    expect(onIdentityHint).toHaveBeenCalledTimes(1);
    expect(onIdentityHint).toHaveBeenCalledWith('code-42', inbound);
    expect(outcome).toEqual({
      status: 'published',
      sessionId: 'sess_1',
      identityHint: { code: 'code-42', expiresAt: '2026-01-01T00:10:00.000Z' },
    });
  });

  it('маршрут записывается при sessionId из ответа', async () => {
    const postEvent = vi.fn(async (_input: EventInput) => ingestResult());

    await ingress(postEvent).handle(message());

    const routes = await state.read<Record<string, SessionRoute>>('routes');
    expect(routes?.sess_1).toEqual({
      sessionId: 'sess_1',
      target: { chatId: '100' },
      inboundMessageId: '55',
      updatedAt: expect.any(String),
    });
  });

  it('sessionId === null → маршрут не создаётся', async () => {
    const postEvent = vi.fn(async (_input: EventInput) => ingestResult({ sessionId: null }));

    const outcome = await ingress(postEvent).handle(message());

    expect(outcome).toEqual({ status: 'published', sessionId: null });
    const routes = await state.read<Record<string, SessionRoute>>('routes');
    expect(routes ?? {}).toEqual({});
  });

  it('после успешной публикации markRead вызывается один раз', async () => {
    const postEvent = vi.fn(async (_input: EventInput) => ingestResult());
    const markRead = vi.fn();
    const inbound = message();

    const outcome = await ingress(postEvent, { markRead }).handle(inbound);

    expect(outcome).toEqual({ status: 'published', sessionId: 'sess_1' });
    expect(markRead).toHaveBeenCalledTimes(1);
    expect(markRead).toHaveBeenCalledWith(inbound);
  });

  it('отказ политики приёма → markRead не вызывается', async () => {
    const postEvent = vi.fn(async (_input: EventInput) => ingestResult());
    const markRead = vi.fn();

    // `not_allowed` — отправитель вне списка доступа.
    const notAllowed = await ingress(postEvent, { markRead }).handle(
      message({
        identity: {
          principalId: 'telegram:999',
          chatKey: 'chat:telegram:999',
          accessKeys: ['chat:telegram:999'],
        },
      }),
    );
    expect(notAllowed).toEqual({ status: 'rejected', reason: 'not_allowed' });

    // `duplicate` — повтор того же `dedupKey`.
    const core = ingress(postEvent, { markRead });
    await core.handle(message());
    const duplicate = await core.handle(message());
    expect(duplicate).toEqual({ status: 'rejected', reason: 'duplicate' });

    // `unknown_sender` — политика `reject` (другой `dedupKey`, чтобы не
    // сработал дедуп от предыдущей публикации).
    const unknown = await ingress(postEvent, {
      markRead,
      unknownAction: 'reject',
      isSenderKnown: async () => false,
    }).handle(message({ dedupKey: 'tg:1:101' }));
    expect(unknown).toEqual({ status: 'rejected', reason: 'unknown_sender' });

    expect(markRead).toHaveBeenCalledTimes(1);
  });

  it('ошибка публикации → markRead не вызывается', async () => {
    const error = new Error('synth недоступен');
    const postEvent = vi.fn(async (_input: EventInput) => {
      throw error;
    });
    const markRead = vi.fn();

    const outcome = await ingress(postEvent, { markRead }).handle(message());

    expect(outcome).toEqual({ status: 'failed', error });
    expect(markRead).not.toHaveBeenCalled();
  });

  it('ошибка markRead не ломает обработку: результат остаётся published', async () => {
    const postEvent = vi.fn(async (_input: EventInput) => ingestResult());
    const markRead = vi.fn(() => {
      throw new Error('канал недоступен');
    });

    const outcome = await ingress(postEvent, { markRead }).handle(message());

    expect(outcome).toEqual({ status: 'published', sessionId: 'sess_1' });
    expect(markRead).toHaveBeenCalledTimes(1);
  });
});
