import { describe, expect, it } from 'vitest';

import {
  aggregateHealth,
  GatewayHealth,
  GatewayHealthRegistry,
  type HealthSnapshot,
} from './health.js';

describe('GatewayHealth', () => {
  it('стартовые значения и обновление полей', () => {
    const health = new GatewayHealth();
    expect(health.snapshot()).toEqual({
      synth: 'down',
      channel: 'unknown',
      watcher: 'down',
      auth: 'none',
      token: 'error',
    });

    health.setSynth('up');
    health.setChannel('ok');
    health.setWatcher('up');
    health.setAuth('service-key');
    health.setToken('ok');
    expect(health.snapshot()).toEqual({
      synth: 'up',
      channel: 'ok',
      watcher: 'up',
      auth: 'service-key',
      token: 'ok',
    });
  });
});

describe('aggregateHealth', () => {
  function snapshot(overrides: Partial<HealthSnapshot> = {}): HealthSnapshot {
    return {
      synth: 'up',
      channel: 'ok',
      watcher: 'up',
      auth: 'service-key',
      token: 'ok',
      ...overrides,
    };
  }

  it('все тенанты up → агрегат ok', () => {
    expect(aggregateHealth([snapshot(), snapshot()]).status).toBe('ok');
  });

  it('один тенант down → агрегат down', () => {
    const health = aggregateHealth([snapshot(), snapshot({ synth: 'down' })]);
    expect(health.status).toBe('down');
    expect(health.synth).toBe('down');
  });

  it('один тенант degraded (channel unknown/token error) → degraded', () => {
    expect(aggregateHealth([snapshot(), snapshot({ channel: 'unknown' })]).status).toBe('degraded');
    expect(aggregateHealth([snapshot(), snapshot({ token: 'error' })]).status).toBe('degraded');
  });

  it('разные режимы auth → агрегат none; смесь ok/dry-run → channel ok', () => {
    const health = aggregateHealth([
      snapshot({ auth: 'service-key' }),
      snapshot({ auth: 'oidc', channel: 'dry-run' }),
    ]);
    expect(health.auth).toBe('none');
    expect(health.channel).toBe('ok');
  });
});

describe('GatewayHealthRegistry', () => {
  it('register возвращает тот же экземпляр, get — зарегистрированный', () => {
    const registry = new GatewayHealthRegistry();
    const health = registry.register('dev');
    expect(registry.register('dev')).toBe(health);
    expect(registry.get('dev')).toBe(health);
    expect(registry.get('missing')).toBeUndefined();
    expect(registry.ids()).toEqual(['dev']);
  });

  it('snapshot: агрегат процесса + разбивка по тенантам', () => {
    const registry = new GatewayHealthRegistry();
    for (const id of ['dev', 'test']) {
      const health = registry.register(id);
      health.setSynth('up');
      health.setChannel('ok');
      health.setWatcher('up');
      health.setAuth('service-key');
      health.setToken('ok');
    }

    const snapshot = registry.snapshot();
    expect(snapshot.aggregate.status).toBe('ok');
    expect(Object.keys(snapshot.tenants)).toEqual(['dev', 'test']);
    expect(snapshot.tenants.dev?.synth).toBe('up');

    registry.get('test')?.setSynth('down');
    expect(registry.snapshot().aggregate.status).toBe('down');
  });
});
