import { describe, expect, it, vi } from 'vitest';

import { SynthApi, SynthEventsError, type EventInput } from './api.js';
import { GatewayHealth } from './health.js';

const event: EventInput = {
  source: 'telegram',
  type: 'message',
  payload: { chatId: '123456789', messageId: 1 },
  identity: { chatKey: 'chat:telegram:123456789', roles: ['ADMIN'] },
  dedupKey: 'telegram:123:1',
};

const jsonResponse = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

function api(fetchImpl: typeof fetch, log = vi.fn(), health?: GatewayHealth): SynthApi {
  return new SynthApi({
    baseUrl: 'http://127.0.0.1:5000/api/v2',
    apiKey: 'secret-key',
    fetchImpl,
    maxRetries: 3,
    retryBaseDelayMs: 0,
    log,
    ...(health ? { health } : {}),
  });
}

describe('SynthApi.postEvent', () => {
  it('успешный POST: возвращает {event, decision, sessionId} и логирует решение', async () => {
    const responseBody = {
      event: {
        id: 'evt_1',
        source: 'telegram',
        type: 'message',
        payload: {},
        identity: {},
        dedupKey: 'k',
        ts: '2026-01-01T00:00:00.000Z',
      },
      decision: { kind: 'opened' },
      sessionId: 'sess_1',
    };
    const fetchImpl = vi.fn(async () => jsonResponse(201, responseBody));
    const log = vi.fn();

    const result = await api(fetchImpl as unknown as typeof fetch, log).postEvent(event);

    expect(result).toEqual(responseBody);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://127.0.0.1:5000/api/v2/events');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer secret-key');
    expect(log).toHaveBeenCalledWith(expect.stringContaining('opened'));
  });

  it('тело запроса — ровно по контракту API v2', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(201, { event: { id: 'e' }, decision: { kind: 'drop' }, sessionId: null }),
    );

    await api(fetchImpl as unknown as typeof fetch).postEvent({
      ...event,
      ts: '2026-01-01T00:00:00.000Z',
    });

    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({
      source: 'telegram',
      type: 'message',
      payload: { chatId: '123456789', messageId: 1 },
      identity: { chatKey: 'chat:telegram:123456789', roles: ['ADMIN'] },
      dedupKey: 'telegram:123:1',
      ts: '2026-01-01T00:00:00.000Z',
    });
  });

  it('5xx → повтор с экспоненциальным backoff, затем успех', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(500, { error: { code: 'INTERNAL_ERROR' } }))
      .mockResolvedValueOnce(jsonResponse(502, { error: { code: 'BAD_GATEWAY' } }))
      .mockResolvedValueOnce(
        jsonResponse(201, {
          event: { id: 'evt_2' },
          decision: { kind: 'bound', sessionId: 's1' },
          sessionId: 's1',
        }),
      );
    const client = new SynthApi({
      baseUrl: 'http://127.0.0.1:5000/api/v2',
      apiKey: 'secret-key',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      maxRetries: 3,
      retryBaseDelayMs: 25,
    });

    const started = Date.now();
    const result = await client.postEvent(event);
    const elapsed = Date.now() - started;

    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(result.decision.kind).toBe('bound');
    expect(result.sessionId).toBe('s1');
    // backoff: первая пауза — базовая (25 мс), вторая — удвоенная (50 мс).
    expect(elapsed).toBeGreaterThanOrEqual(70);
  });

  it('повторяет запрос при сетевой ошибке', async () => {
    const fetchImpl = vi
      .fn()
      .mockRejectedValueOnce(new Error('ECONNREFUSED'))
      .mockResolvedValueOnce(
        jsonResponse(201, {
          event: { id: 'evt_3' },
          decision: { kind: 'drop', reason: 'no_route' },
          sessionId: null,
        }),
      );

    const result = await api(fetchImpl as unknown as typeof fetch).postEvent(event);

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(result.sessionId).toBeNull();
  });

  it('4xx — окончательная ошибка с кодом из тела, без повторов', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(400, {
        error: { code: 'VALIDATION_ERROR', message: 'Некорректное тело события' },
      }),
    );

    const promise = api(fetchImpl as unknown as typeof fetch).postEvent(event);

    await expect(promise).rejects.toBeInstanceOf(SynthEventsError);
    await expect(promise).rejects.toMatchObject({ status: 400, code: 'VALIDATION_ERROR' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('исчерпание повторов на 5xx → ошибка', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(503, { error: { code: 'UNAVAILABLE' } }));

    await expect(api(fetchImpl as unknown as typeof fetch).postEvent(event)).rejects.toMatchObject({
      status: 503,
      code: 'UNAVAILABLE',
    });
    // 1 попытка + 3 повтора
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });

  it('health: успех → synth up, исчерпание повторов → synth down', async () => {
    const health = new GatewayHealth();
    const ok = vi.fn(async () =>
      jsonResponse(201, { event: { id: 'e' }, decision: { kind: 'drop' } }),
    );
    await api(ok as unknown as typeof fetch, vi.fn(), health).postEvent(event);
    expect(health.snapshot().synth).toBe('up');

    const healthDown = new GatewayHealth();
    const fail = vi.fn(async () => jsonResponse(503, { error: { code: 'UNAVAILABLE' } }));
    await expect(
      api(fail as unknown as typeof fetch, vi.fn(), healthDown).postEvent(event),
    ).rejects.toBeInstanceOf(SynthEventsError);
    expect(healthDown.snapshot().synth).toBe('down');
  });
});

describe('SynthApi: 401 → один auto-refresh без траты retry-бюджета', () => {
  it('401 → refreshBearer и повтор с новым токеном (2 запроса, не 3)', async () => {
    const bearer = {
      getBearer: vi.fn().mockResolvedValueOnce('stale').mockResolvedValue('fresh'),
      refreshBearer: vi.fn().mockResolvedValue('fresh'),
    };
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(401, { error: { code: 'UNAUTHORIZED' } }))
      .mockResolvedValueOnce(
        jsonResponse(201, { event: { id: 'e1' }, decision: { kind: 'drop' }, sessionId: null }),
      );
    const client = new SynthApi({
      baseUrl: 'http://127.0.0.1:5000/api/v2',
      bearer,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      retryBaseDelayMs: 0,
    });

    const result = await client.postEvent(event);

    expect(result.sessionId).toBeNull();
    expect(bearer.refreshBearer).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const [, secondInit] = fetchImpl.mock.calls[1] as unknown as [string, RequestInit];
    expect((secondInit.headers as Record<string, string>).authorization).toBe('Bearer fresh');
  });

  it('повторный 401 → окончательная ошибка (без бесконечного цикла)', async () => {
    const bearer = {
      getBearer: vi.fn().mockResolvedValue('tok'),
      refreshBearer: vi.fn().mockResolvedValue('tok'),
    };
    const fetchImpl = vi.fn(async () => jsonResponse(401, { error: { code: 'UNAUTHORIZED' } }));
    const client = new SynthApi({
      baseUrl: 'http://127.0.0.1:5000/api/v2',
      bearer,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      retryBaseDelayMs: 0,
    });

    await expect(client.postEvent(event)).rejects.toMatchObject({ status: 401 });
    expect(bearer.refreshBearer).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('bearer приоритетнее статического apiKey', async () => {
    const bearer = {
      getBearer: vi.fn().mockResolvedValue('bearer-token'),
      refreshBearer: vi.fn(),
    };
    const fetchImpl = vi.fn(async () =>
      jsonResponse(201, { event: { id: 'e' }, decision: { kind: 'drop' }, sessionId: null }),
    );
    const client = new SynthApi({
      baseUrl: 'http://127.0.0.1:5000/api/v2',
      apiKey: 'static-key',
      bearer,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      retryBaseDelayMs: 0,
    });

    await client.postEvent(event);
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer bearer-token');
  });
});

describe('SynthApi: привязки', () => {
  it('listBindings разворачивает {bindings}', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(200, { bindings: [{ id: 'b1', source: 'telegram', mode: 'bound' }] }),
    );
    const bindings = await api(fetchImpl as unknown as typeof fetch).listBindings();
    expect(bindings).toEqual([{ id: 'b1', source: 'telegram', mode: 'bound' }]);
  });

  it('listBindings фильтрует по source на стороне клиента', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(200, {
        bindings: [
          { id: 'b1', source: 'telegram', mode: 'bound' },
          { id: 'b2', source: 'cron', mode: 'queue' },
        ],
      }),
    );
    const bindings = await api(fetchImpl as unknown as typeof fetch).listBindings('telegram');
    expect(bindings.map((binding) => binding.id)).toEqual(['b1']);
    // В API фильтра нет — один и тот же запрос без query-параметров.
    const [url] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://127.0.0.1:5000/api/v2/events/bindings');
  });

  it('createBinding отправляет POST и возвращает биндинг', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(201, { id: 'b2', source: 'telegram', mode: 'bound', sessionId: 's1' }),
    );
    const binding = await api(fetchImpl as unknown as typeof fetch).createBinding({
      source: 'telegram',
      chatKey: 'chat:telegram:1',
      mode: 'bound',
      sessionId: 's1',
    });
    expect(binding.id).toBe('b2');
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://127.0.0.1:5000/api/v2/events/bindings');
    expect(init.method).toBe('POST');
  });

  it('deleteBinding не бросает на 204', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 204 }));
    await expect(
      api(fetchImpl as unknown as typeof fetch).deleteBinding('b3'),
    ).resolves.toBeUndefined();
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://127.0.0.1:5000/api/v2/events/bindings/b3');
    expect(init.method).toBe('DELETE');
  });
});

describe('SynthApi: сессии', () => {
  it('createSession отправляет POST /sessions и возвращает сессию', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(201, { id: 'sess_1', name: 'Telegram' }));
    const session = await api(fetchImpl as unknown as typeof fetch).createSession({
      name: 'Telegram',
    });
    expect(session.id).toBe('sess_1');
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://127.0.0.1:5000/api/v2/sessions');
    expect(init.method).toBe('POST');
  });

  it('getSession 404 → null без повторов', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(404, { error: { code: 'NOT_FOUND' } }));
    const session = await api(fetchImpl as unknown as typeof fetch).getSession('missing');
    expect(session).toBeNull();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('getSession 200 возвращает сессию', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { id: 'sess_2' }));
    expect(await api(fetchImpl as unknown as typeof fetch).getSession('sess_2')).toEqual({
      id: 'sess_2',
    });
  });

  it('getSession при 5xx повторяет и затем бросает', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(500, { error: { code: 'INTERNAL_ERROR' } }));
    await expect(
      api(fetchImpl as unknown as typeof fetch).getSession('sess_3'),
    ).rejects.toMatchObject({ status: 500 });
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });

  it('abortSession отправляет POST /sessions/:id/abort', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { status: 'aborted' }));
    await expect(
      api(fetchImpl as unknown as typeof fetch).abortSession('sess/1'),
    ).resolves.toBeUndefined();
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://127.0.0.1:5000/api/v2/sessions/sess%2F1/abort');
    expect(init.method).toBe('POST');
  });

  it('abortSession 404 → ошибка SynthEventsError', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(404, { error: { code: 'NOT_FOUND' } }));
    await expect(
      api(fetchImpl as unknown as typeof fetch).abortSession('missing'),
    ).rejects.toMatchObject({ status: 404, code: 'NOT_FOUND' });
  });
});

describe('SynthApi: пользователи', () => {
  it('listUsers разворачивает {users}', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(200, { users: [{ id: 'u1', username: 'alice' }] }),
    );
    const users = await api(fetchImpl as unknown as typeof fetch).listUsers();
    expect(users).toEqual([{ id: 'u1', username: 'alice' }]);
    const [url] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://127.0.0.1:5000/api/v2/users');
  });

  it('listUsers принимает и «голый» массив', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, [{ id: 'u1' }]));
    expect(await api(fetchImpl as unknown as typeof fetch).listUsers()).toEqual([{ id: 'u1' }]);
  });

  it('getUser отдаёт профиль с идентичностями; 404 → null', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(200, {
        user: { id: 'u1', username: 'alice', identities: [{ provider: 'tg', external_id: '42' }] },
      }),
    );
    const user = await api(fetchImpl as unknown as typeof fetch).getUser('u1');
    expect(user?.identities?.[0]?.external_id).toBe('42');

    const missing = vi.fn(async () => jsonResponse(404, { error: { code: 'NOT_FOUND' } }));
    expect(await api(missing as unknown as typeof fetch).getUser('missing')).toBeNull();
  });
});
