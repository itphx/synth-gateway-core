import { describe, expect, it } from 'vitest';

import {
  DEFAULT_TENANT_ID,
  envOr,
  parseAllowlist,
  parseBool,
  parsePositiveInt,
  parseTenantsFile,
  parseUnknownAction,
  TENANT_ID_PATTERN,
  tenantStoreDir,
  type ChannelTenantSchema,
  type GatewayDefaults,
} from './config.js';

/** Тестовый канал: свои ключи в записи тенанта (`token`, `proxyUrl`). */
interface TestChannel {
  token?: string;
  proxyUrl?: string;
}

const testSchema: ChannelTenantSchema<TestChannel> = {
  keys: ['token', 'proxyUrl'],
  parse(raw, context, defaults) {
    const token = typeof raw.token === 'string' ? raw.token.trim() : undefined;
    const proxyUrl = typeof raw.proxyUrl === 'string' ? raw.proxyUrl.trim() : undefined;
    if (!token && !proxyUrl) return defaults.channel;
    return {
      ...defaults.channel,
      ...(token ? { token } : {}),
      ...(proxyUrl ? { proxyUrl } : {}),
    };
  },
};

/** Глобальные дефолты для прямого разбора `tenants.json`. */
function defaults(
  overrides: Partial<GatewayDefaults<TestChannel>> = {},
): GatewayDefaults<TestChannel> {
  return {
    synth: { baseUrl: 'http://127.0.0.1:5000/api/v2', oidc: {} },
    allowlist: {},
    unknownAction: 'register',
    watch: true,
    channel: {},
    ...overrides,
  };
}

describe('envOr', () => {
  it('отсутствующее/пустое/whitespace значение → fallback, иначе trim', () => {
    expect(envOr({}, 'X')).toBeUndefined();
    expect(envOr({}, 'X', 'fb')).toBe('fb');
    expect(envOr({ X: '' }, 'X', 'fb')).toBe('fb');
    expect(envOr({ X: '   ' }, 'X', 'fb')).toBe('fb');
    expect(envOr({ X: '  v  ' }, 'X', 'fb')).toBe('v');
  });
});

describe('parseBool', () => {
  it('распознаёт true/false-значения и игнорирует прочее', () => {
    expect(parseBool('1')).toBe(true);
    expect(parseBool('TRUE')).toBe(true);
    expect(parseBool('on')).toBe(true);
    expect(parseBool('0')).toBe(false);
    expect(parseBool('no')).toBe(false);
    expect(parseBool('')).toBeUndefined();
    expect(parseBool('maybe')).toBeUndefined();
  });
});

describe('parsePositiveInt', () => {
  it('берёт только строго положительные целые', () => {
    expect(parsePositiveInt('30')).toBe(30);
    expect(parsePositiveInt(' 42 ')).toBe(42);
    expect(parsePositiveInt('0')).toBeUndefined();
    expect(parsePositiveInt('-1')).toBeUndefined();
    expect(parsePositiveInt('bogus')).toBeUndefined();
    expect(parsePositiveInt(undefined)).toBeUndefined();
  });
});

describe('parseAllowlist', () => {
  it('разбирает key:ROLE, нормализует роль', () => {
    expect(parseAllowlist('123456789:ADMIN, -1001234567890:lead')).toEqual({
      '123456789': 'ADMIN',
      '-1001234567890': 'LEAD',
    });
  });

  it('разделитель — последний ":" (адреса почты содержат ":")', () => {
    expect(parseAllowlist('user@example.com:USER')).toEqual({ 'user@example.com': 'USER' });
    expect(parseAllowlist('a:b:c:LEAD')).toEqual({ 'a:b:c': 'LEAD' });
  });

  it('несколько записей', () => {
    expect(parseAllowlist('one:USER,two:lead,three:AUDITOR')).toEqual({
      one: 'USER',
      two: 'LEAD',
      three: 'AUDITOR',
    });
  });

  it('битые пары пропускаются', () => {
    expect(parseAllowlist('bad, :ROLE, 123:')).toEqual({});
    expect(parseAllowlist('bad,123:USER')).toEqual({ '123': 'USER' });
  });

  it('пустая строка → пустой объект', () => {
    expect(parseAllowlist('')).toEqual({});
    expect(parseAllowlist('   ')).toEqual({});
  });
});

describe('parseUnknownAction', () => {
  it('нормализует значение, неизвестное → register', () => {
    expect(parseUnknownAction('hint')).toBe('hint');
    expect(parseUnknownAction(' REJECT ')).toBe('reject');
    expect(parseUnknownAction('bogus')).toBe('register');
    expect(parseUnknownAction(undefined)).toBe('register');
  });
});

describe('TENANT_ID_PATTERN', () => {
  it('допускает [a-z0-9][a-z0-9_-]*', () => {
    expect(TENANT_ID_PATTERN.test('dev')).toBe(true);
    expect(TENANT_ID_PATTERN.test('dev-1_2')).toBe(true);
    expect(TENANT_ID_PATTERN.test('Dev')).toBe(false);
    expect(TENANT_ID_PATTERN.test('-lead')).toBe(false);
    expect(TENANT_ID_PATTERN.test('dev bot')).toBe(false);
  });
});

describe('tenantStoreDir', () => {
  it('legacy default → корень dataDir; остальные → dataDir/tenants/<id>', () => {
    expect(tenantStoreDir('/data', DEFAULT_TENANT_ID, true)).toBe('/data');
    expect(tenantStoreDir('/data', DEFAULT_TENANT_ID, false)).toBe('/data/tenants/default');
    expect(tenantStoreDir('/data', 'dev', true)).toBe('/data/tenants/dev');
    expect(tenantStoreDir('/data', 'dev', false)).toBe('/data/tenants/dev');
  });
});

describe('parseTenantsFile', () => {
  it('разбирает валидный файл: общие и канальные ключи, дефолты', () => {
    const tenants = parseTenantsFile(
      {
        tenants: [
          {
            id: 'dev',
            synthUrl: 'http://127.0.0.1:5000/api/v2/',
            serviceKey: 'synth_svc_dev',
            allowlist: '123456789:ADMIN, -1001234567890:lead',
            unknownAction: 'hint',
            watch: false,
            token: ' dev-token ',
          },
          {
            id: 'test',
            synth: { url: 'https://synth.test/api/v2' },
            apiKey: 'legacy-key',
            allowlist: { '1': 'lead', '2': 'USER' },
            proxyUrl: 'http://proxy:3129',
          },
        ],
      },
      testSchema,
      defaults({ watch: true }),
    );

    expect(tenants.map((tenant) => tenant.id)).toEqual(['dev', 'test']);

    const [dev, test] = tenants;
    expect(dev?.synth.baseUrl).toBe('http://127.0.0.1:5000/api/v2');
    expect(dev?.synth.serviceKey).toBe('synth_svc_dev');
    expect(dev?.allowlist).toEqual({ '123456789': 'ADMIN', '-1001234567890': 'LEAD' });
    expect(dev?.unknownAction).toBe('hint');
    expect(dev?.watch).toBe(false);
    expect(dev?.channel.token).toBe('dev-token');

    expect(test?.synth.baseUrl).toBe('https://synth.test/api/v2');
    expect(test?.synth.apiKey).toBe('legacy-key');
    expect(test?.allowlist).toEqual({ '1': 'LEAD', '2': 'USER' });
    expect(test?.channel.proxyUrl).toBe('http://proxy:3129');
    // Дефолты (глобальные) для незаданных полей.
    expect(test?.unknownAction).toBe('register');
    expect(test?.watch).toBe(true);
  });

  it('канальные ключи из schema.keys принимаются', () => {
    const tenants = parseTenantsFile(
      { tenants: [{ id: 'dev', token: 't' }] },
      testSchema,
      defaults(),
    );
    expect(tenants[0]?.channel.token).toBe('t');
  });

  it('незаданные поля наследуют глобальные дефолты', () => {
    const tenants = parseTenantsFile(
      { tenants: [{ id: 'dev' }] },
      testSchema,
      defaults({
        synth: {
          baseUrl: 'http://global/api/v2',
          serviceKey: 'synth_svc_global',
          apiKey: 'global-key',
          oidc: { clientId: 'global-client' },
        },
        allowlist: { global: 'ADMIN' },
        unknownAction: 'hint',
        watch: false,
      }),
    );
    const tenant = tenants[0];
    expect(tenant?.synth.baseUrl).toBe('http://global/api/v2');
    expect(tenant?.synth.serviceKey).toBe('synth_svc_global');
    expect(tenant?.synth.apiKey).toBe('global-key');
    expect(tenant?.synth.oidc.clientId).toBe('global-client');
    expect(tenant?.allowlist).toEqual({ global: 'ADMIN' });
    expect(tenant?.unknownAction).toBe('hint');
    expect(tenant?.watch).toBe(false);
  });

  it('чужие ключи отклоняются (fail-fast) со списком допустимых', () => {
    expect(() =>
      parseTenantsFile({ tenants: [{ id: 'dev', botToken: 't' }] }, testSchema, defaults()),
    ).toThrow(/неизвестное поле «botToken»/);
    expect(() =>
      parseTenantsFile({ tenants: [{ id: 'dev', syntUrl: 'http://x' }] }, testSchema, defaults()),
    ).toThrow(/неизвестное поле «syntUrl»/);
    expect(() =>
      parseTenantsFile({ tenants: [{ id: 'dev', botToken: 't' }] }, testSchema, defaults()),
    ).toThrow(/допустимые поля/);
  });

  it('ошибка: дублирующийся id', () => {
    expect(() =>
      parseTenantsFile(
        {
          tenants: [
            { id: 'dev', token: 't' },
            { id: 'dev', token: 't2' },
          ],
        },
        testSchema,
        defaults(),
      ),
    ).toThrow(/повторяющийся id/);
  });

  it('ошибка: недопустимый/отсутствующий id', () => {
    expect(() =>
      parseTenantsFile({ tenants: [{ id: 'Dev Bot', token: 't' }] }, testSchema, defaults()),
    ).toThrow(/недопустимый id/);
    expect(() => parseTenantsFile({ tenants: [{ token: 't' }] }, testSchema, defaults())).toThrow(
      /отсутствует обязательное поле «id»/,
    );
  });

  it('ошибка: непустой массив tenants обязателен', () => {
    expect(() => parseTenantsFile({ tenants: [] }, testSchema, defaults())).toThrow(
      /непустым массивом/,
    );
    expect(() => parseTenantsFile({}, testSchema, defaults())).toThrow(/непустым массивом/);
    expect(() => parseTenantsFile([], testSchema, defaults())).toThrow(/ожидается объект/);
    expect(() => parseTenantsFile({ tenants: [], extra: 1 }, testSchema, defaults())).toThrow(
      /неизвестное поле «extra»/,
    );
  });

  it('ошибка: неизвестное поле вложенного объекта synth', () => {
    expect(() =>
      parseTenantsFile(
        { tenants: [{ id: 'dev', synth: { urll: 'http://x' } }] },
        testSchema,
        defaults(),
      ),
    ).toThrow(/неизвестное поле «urll»/);
  });

  it('ошибка: запись тенанта — не объект', () => {
    expect(() => parseTenantsFile({ tenants: ['dev'] }, testSchema, defaults())).toThrow(
      /ожидается объект/,
    );
  });
});
