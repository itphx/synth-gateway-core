import { describe, expect, it } from 'vitest';

import { createLogger, createTenantLogger, describeSecret, tenantLogPrefix } from './logger.js';

describe('createLogger', () => {
  it('добавляет префикс к сообщению без префикса', () => {
    const lines: string[] = [];
    const log = createLogger('[gateway]', (message) => lines.push(message));
    log('старт');
    expect(lines).toEqual(['[gateway] старт']);
  });

  it('не дублирует уже присутствующий префикс', () => {
    const lines: string[] = [];
    const log = createLogger('[gateway]', (message) => lines.push(message));
    log('[gateway] уже с префиксом');
    expect(lines).toEqual(['[gateway] уже с префиксом']);
  });

  it('пустой префикс → базовый [gateway]', () => {
    const lines: string[] = [];
    const log = createLogger('  ', (message) => lines.push(message));
    log('текст');
    expect(lines).toEqual(['[gateway] текст']);
  });
});

describe('tenantLogPrefix / createTenantLogger', () => {
  it('мультитенантный префикс — [gateway][<tenantId>]', () => {
    expect(tenantLogPrefix('dev')).toBe('[gateway][dev]');
    const lines: string[] = [];
    const log = createTenantLogger('dev', (message) => lines.push(message));
    log('сообщение');
    expect(lines).toEqual(['[gateway][dev] сообщение']);
  });

  it('базовый префикс в сообщении заменяется тенантным', () => {
    const lines: string[] = [];
    const log = createTenantLogger('dev', (message) => lines.push(message));
    log('[gateway] тенант «dev»');
    expect(lines).toEqual(['[gateway][dev] тенант «dev»']);
  });
});

describe('describeSecret', () => {
  it('логирует только факт «задан/не задан», без значения', () => {
    expect(describeSecret('serviceKey', 'synth_svc_secret')).toBe('serviceKey: задан');
    expect(describeSecret('serviceKey', undefined)).toBe('serviceKey: не задан');
    expect(describeSecret('serviceKey', '   ')).toBe('serviceKey: не задан');
    expect(describeSecret('serviceKey', 'synth_svc_secret')).not.toContain('synth_svc_secret');
  });
});
