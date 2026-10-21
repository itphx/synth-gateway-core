import { describe, expect, it, vi } from 'vitest';

import { AuthTokenProvider, isOidcConfigured, isOidcPartial } from './auth.js';
import type { OidcAuthConfig } from './config.js';
import { GatewayHealth } from './health.js';

const jsonResponse = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

function oidc(overrides: Partial<OidcAuthConfig> = {}): OidcAuthConfig {
  return {
    tokenUrl: 'https://idp.test/token',
    clientId: 'gateway',
    clientSecret: 's3cr3t',
    ...overrides,
  };
}

describe('isOidcConfigured / isOidcPartial', () => {
  it('настроен только при endpoint + client_id + client_secret', () => {
    expect(isOidcConfigured(oidc())).toBe(true);
    expect(
      isOidcConfigured(oidc({ discoveryUrl: 'https://idp.test/.well-known', tokenUrl: undefined })),
    ).toBe(true);
    expect(isOidcConfigured(oidc({ clientSecret: undefined }))).toBe(false);
    expect(isOidcConfigured(oidc({ clientId: undefined }))).toBe(false);
    expect(isOidcConfigured({ clientId: 'a', clientSecret: 'b' })).toBe(false);
    expect(isOidcConfigured(undefined)).toBe(false);
    expect(isOidcConfigured({})).toBe(false);
  });

  it('partial — задано что-то, но не всё', () => {
    expect(isOidcPartial({ clientId: 'a' })).toBe(true);
    expect(isOidcPartial({ tokenUrl: 'https://idp.test/token' })).toBe(true);
    expect(isOidcPartial(oidc())).toBe(false);
    expect(isOidcPartial({})).toBe(false);
    expect(isOidcPartial(undefined)).toBe(false);
  });
});

describe('AuthTokenProvider: приоритет режимов', () => {
  it('service-key > oidc > api-key > none', () => {
    expect(new AuthTokenProvider({ serviceKey: 'svc', apiKey: 'key', oidc: oidc() }).mode).toBe(
      'service-key',
    );
    expect(new AuthTokenProvider({ apiKey: 'key', oidc: oidc() }).mode).toBe('oidc');
    expect(new AuthTokenProvider({ apiKey: 'key' }).mode).toBe('api-key');
    expect(new AuthTokenProvider({}).mode).toBe('none');
  });

  it('service-key главнее OIDC: сеть не вызывается', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { access_token: 't', expires_in: 300 }));
    const provider = new AuthTokenProvider({ serviceKey: 'svc', oidc: oidc(), fetchImpl });
    expect(provider.mode).toBe('service-key');
    expect(await provider.getBearer()).toBe('svc');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('OIDC приоритетнее статического ключа', async () => {
    const provider = new AuthTokenProvider({
      apiKey: 'api-key-1',
      oidc: oidc(),
      fetchImpl: vi.fn(async () => jsonResponse(200, { access_token: 't', expires_in: 300 })),
    });
    expect(provider.mode).toBe('oidc');
    expect(await provider.getBearer()).toBe('t');
  });

  it('api-key — статический bearer, без сетевых вызовов', async () => {
    const fetchImpl = vi.fn();
    const provider = new AuthTokenProvider({ apiKey: 'api-key-1', fetchImpl });
    expect(provider.mode).toBe('api-key');
    expect(await provider.getBearer()).toBe('api-key-1');
    expect(await provider.refreshBearer()).toBe('api-key-1');
    expect(await provider.check()).toBe('ok');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('ни ключа, ни OIDC → режим none, токена нет', async () => {
    const provider = new AuthTokenProvider({});
    expect(provider.mode).toBe('none');
    expect(await provider.getBearer()).toBeUndefined();
    expect(await provider.refreshBearer()).toBeUndefined();
    expect(await provider.check()).toBe('error');
  });

  it('пустой/whitespace ключ = отсутствие значения', () => {
    expect(new AuthTokenProvider({ apiKey: '   ' }).mode).toBe('none');
    expect(new AuthTokenProvider({ serviceKey: '   ' }).mode).toBe('none');
    expect(new AuthTokenProvider({ serviceKey: '' }).mode).toBe('none');
  });
});

describe('AuthTokenProvider: OIDC client-credentials', () => {
  it('получает токен через POST form-urlencoded', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(200, { access_token: 'tok-1', expires_in: 300 }),
    );
    const provider = new AuthTokenProvider({ oidc: oidc({ scope: 'openid' }), fetchImpl });

    expect(provider.mode).toBe('oidc');
    expect(await provider.getBearer()).toBe('tok-1');

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://idp.test/token');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['content-type']).toContain(
      'application/x-www-form-urlencoded',
    );
    const body = String(init.body);
    expect(body).toContain('grant_type=client_credentials');
    expect(body).toContain('client_id=gateway');
    expect(body).toContain('scope=openid');
  });

  it('кэширует токен: повторный вызов не ходит в сеть', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(200, { access_token: 'tok-1', expires_in: 300 }),
    );
    const provider = new AuthTokenProvider({ oidc: oidc(), fetchImpl });

    expect(await provider.getBearer()).toBe('tok-1');
    expect(await provider.getBearer()).toBe('tok-1');
    expect(await provider.getBearer()).toBe('tok-1');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('single-flight: два параллельных getBearer() → один запрос', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fetchImpl = vi.fn(async () => {
      await gate;
      return jsonResponse(200, { access_token: 'shared', expires_in: 300 });
    });
    const provider = new AuthTokenProvider({ oidc: oidc(), fetchImpl });

    const first = provider.getBearer();
    const second = provider.getBearer();
    release();
    expect(await Promise.all([first, second])).toEqual(['shared', 'shared']);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('обновляет токен заранее, за margin до expires_in', async () => {
    let now = 1_000_000;
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, { access_token: 'a', expires_in: 100 }))
      .mockResolvedValueOnce(jsonResponse(200, { access_token: 'b', expires_in: 100 }));
    const provider = new AuthTokenProvider({
      oidc: oidc(),
      fetchImpl,
      now: () => now,
      refreshMarginSec: 30,
    });

    expect(await provider.getBearer()).toBe('a');
    now += 50_000; // ещё валиден (до 70 с)
    expect(await provider.getBearer()).toBe('a');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    now += 40_000; // 90 с — внутри margin → обновление
    expect(await provider.getBearer()).toBe('b');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('без expires_in → дефолт 300 с (refresh-margin считается от него)', async () => {
    let now = 1_000_000;
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, { access_token: 'a' }))
      .mockResolvedValueOnce(jsonResponse(200, { access_token: 'b' }));
    const provider = new AuthTokenProvider({
      oidc: oidc(),
      fetchImpl,
      now: () => now,
      refreshMarginSec: 30,
    });

    expect(await provider.getBearer()).toBe('a');
    now += 269_000; // 269 с < 300 − 30 → кэш
    expect(await provider.getBearer()).toBe('a');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    now += 2_000; // 271 с — внутри margin → обновление
    expect(await provider.getBearer()).toBe('b');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('refreshBearer() принудительно обновляет токен', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, { access_token: 'old', expires_in: 300 }))
      .mockResolvedValueOnce(jsonResponse(200, { access_token: 'new', expires_in: 300 }));
    const provider = new AuthTokenProvider({ oidc: oidc(), fetchImpl });

    expect(await provider.getBearer()).toBe('old');
    expect(await provider.refreshBearer()).toBe('new');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('тело ошибки OIDC-сервера не попадает в лог и в сообщение об ошибке', async () => {
    const logs: string[] = [];
    const fetchImpl = vi.fn(async () =>
      jsonResponse(401, { error: 'invalid_client', secret: 'super-secret-value' }),
    );
    const provider = new AuthTokenProvider({ oidc: oidc(), fetchImpl, log: (m) => logs.push(m) });

    await expect(provider.getBearer()).rejects.toThrow(/gateway\.oidc_token_failed/);
    await expect(provider.getBearer()).rejects.toThrow(/HTTP 401/);
    await expect(provider.getBearer()).rejects.not.toThrow(/super-secret-value/);
    expect(logs.join('\n')).not.toContain('super-secret-value');
    expect(logs.join('\n')).not.toContain('invalid_client');
    expect(provider.tokenStatus).toBe('error');
    expect(await provider.check()).toBe('error');
  });

  it('ответ без access_token → ошибка', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { expires_in: 300 }));
    const provider = new AuthTokenProvider({ oidc: oidc(), fetchImpl });
    await expect(provider.getBearer()).rejects.toThrow(/gateway\.oidc_token_failed/);
  });

  it('discovery-URL резолвит token_endpoint и кэширует discovery', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, { token_endpoint: 'https://idp.test/real-token' }))
      .mockResolvedValueOnce(jsonResponse(200, { access_token: 'tok', expires_in: 300 }))
      .mockResolvedValueOnce(jsonResponse(200, { access_token: 'tok2', expires_in: 300 }));
    const provider = new AuthTokenProvider({
      oidc: oidc({
        tokenUrl: undefined,
        discoveryUrl: 'https://idp.test/.well-known/openid-configuration',
      }),
      fetchImpl,
    });

    expect(await provider.getBearer()).toBe('tok');
    expect(fetchImpl.mock.calls[1]?.[0]).toBe('https://idp.test/real-token');
    await provider.refreshBearer();
    const discoveryCalls = fetchImpl.mock.calls.filter((call) =>
      String(call[0]).includes('openid-configuration'),
    );
    expect(discoveryCalls).toHaveLength(1);
  });

  it('check() прогревает токен (best-effort) и обновляет health', async () => {
    const health = new GatewayHealth();
    const fetchImpl = vi.fn(async () => jsonResponse(200, { access_token: 't', expires_in: 300 }));
    const provider = new AuthTokenProvider({ oidc: oidc(), health, fetchImpl });

    expect(await provider.check()).toBe('ok');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(health.snapshot().token).toBe('ok');
  });

  it('обновляет health-состояние токена', async () => {
    const health = new GatewayHealth();
    const provider = new AuthTokenProvider({
      oidc: oidc(),
      health,
      fetchImpl: vi.fn(async () => jsonResponse(200, { access_token: 't', expires_in: 300 })),
    });

    await provider.getBearer();
    expect(health.snapshot().token).toBe('ok');
  });
});

describe('AuthTokenProvider: секреты не попадают в логи', () => {
  it('service-key и client-secret не печатаются', async () => {
    const logs: string[] = [];
    const provider = new AuthTokenProvider({
      serviceKey: 'synth_svc_supersecret',
      log: (message) => logs.push(message),
    });

    expect(await provider.getBearer()).toBe('synth_svc_supersecret');
    expect(await provider.check()).toBe('ok');
    expect(logs.join('\n')).not.toContain('supersecret');
  });
});
