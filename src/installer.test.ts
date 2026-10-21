import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  installMcpStandalone,
  installSkillStandalone,
  isDirectory,
  main,
  mergeMcpServerIntoConfig,
  parseInstallerArgs,
  parseSkillFrontmatter,
  readAddonManifest,
  readSkillBundle,
  resolveMcpEndpointPath,
  runInstaller,
} from './installer.js';

const tmpDirs: string[] = [];

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tmpDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

/** Фикстур-репозиторий шлюза: synth.pack + скилл. */
function fixtureRoot(options: { skills?: boolean } = {}): string {
  const root = tmpDir('gateway-installer-');
  writeFileSync(
    join(root, 'synth.pack'),
    JSON.stringify({
      name: '@itphx/synth-gateway-telegram',
      version: '0.2.0',
      kind: 'gateway',
      provides: {
        mcp: {
          name: 'synth-gateway-telegram',
          transport: 'http',
          port: 7101,
          path: '/mcp/{tenant}',
          description: 'Telegram-шлюз: тулы tg_*',
        },
        skills: [{ name: 'gateway-telegram', path: 'skills/gateway-telegram' }],
      },
    }),
  );
  if (options.skills !== false) {
    const skillDir = join(root, 'skills', 'gateway-telegram');
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      join(skillDir, 'SKILL.md'),
      ['---', 'name: gateway-telegram', 'description: Мост в Telegram', '---', '', '# Тело', ''].join('\n'),
    );
    mkdirSync(join(skillDir, 'extra'), { recursive: true });
    writeFileSync(join(skillDir, 'extra', 'notes.md'), 'заметки');
  }
  return root;
}

interface MockRoute {
  status: number;
  body?: unknown;
}

/** Мок fetch: маршруты по `"METHOD path"`; неизвестный маршрут → ошибка. */
function mockFetch(routes: Record<string, MockRoute>): {
  fetchImpl: typeof fetch;
  calls: { method: string; path: string; body?: unknown }[];
} {
  const calls: { method: string; path: string; body?: unknown }[] = [];
  const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const path = new URL(url).pathname;
    const method = init?.method ?? 'GET';
    calls.push({
      method,
      path,
      ...(typeof init?.body === 'string' ? { body: JSON.parse(init.body) as unknown } : {}),
    });
    const route = routes[`${method} ${path}`];
    if (!route) throw new Error(`нет маршрута: ${method} ${path}`);
    return new Response(route.body !== undefined ? JSON.stringify(route.body) : '', {
      status: route.status,
      headers: { 'content-type': 'application/json' },
    });
  });
  return { fetchImpl: fetchImpl as unknown as typeof fetch, calls };
}

const MANAGED = {
  synthUrl: 'http://synth-backend:5000/api/v2',
  token: 'synth_svc_install',
  tenant: 'dev',
  mcpUrl: 'http://synth-gateway-telegram:7101',
};

describe('readAddonManifest', () => {
  it('читает synth.pack (provides.mcp + skills + kind)', () => {
    const manifest = readAddonManifest(fixtureRoot());
    expect(manifest.name).toBe('@itphx/synth-gateway-telegram');
    expect(manifest.version).toBe('0.2.0');
    expect(manifest.kind).toBe('gateway');
    expect(manifest.provides?.mcp).toMatchObject({
      name: 'synth-gateway-telegram',
      transport: 'http',
      port: 7101,
      path: '/mcp/{tenant}',
    });
    expect(manifest.provides?.skills).toEqual([
      { name: 'gateway-telegram', path: 'skills/gateway-telegram' },
    ]);
  });

  it('ошибки: нет файла / битый JSON / нет mcp.name', () => {
    const empty = tmpDir('gateway-installer-empty-');
    expect(() => readAddonManifest(empty)).toThrow(/не найден манифест/);

    const broken = tmpDir('gateway-installer-broken-');
    writeFileSync(join(broken, 'synth.pack'), '{ не json');
    expect(() => readAddonManifest(broken)).toThrow(/некорректный JSON/);

    const noName = tmpDir('gateway-installer-noname-');
    writeFileSync(join(noName, 'synth.pack'), JSON.stringify({ provides: { mcp: {} } }));
    expect(() => readAddonManifest(noName)).toThrow(/provides\.mcp\.name/);
  });
});

describe('resolveMcpEndpointPath', () => {
  it('подставляет тенанта, дефолт — /mcp/{tenant}', () => {
    expect(resolveMcpEndpointPath('/mcp/{tenant}', 'dev')).toBe('/mcp/dev');
    expect(resolveMcpEndpointPath(undefined, 'test')).toBe('/mcp/test');
    expect(resolveMcpEndpointPath('/mcp/{tenant}/sse', 'x')).toBe('/mcp/x/sse');
  });
});

describe('readSkillBundle / parseSkillFrontmatter', () => {
  it('разбирает frontmatter и тело', () => {
    expect(parseSkillFrontmatter('---\nname: a\ndescription: "b: c"\n---\nbody')).toEqual({
      meta: { name: 'a', description: 'b: c' },
      body: 'body',
    });
    expect(parseSkillFrontmatter('без frontmatter')).toEqual({
      meta: {},
      body: 'без frontmatter',
    });
  });

  it('собирает пакет скилла: имя/описание/тело/supporting-файлы', () => {
    const root = fixtureRoot();
    const bundle = readSkillBundle(join(root, 'skills', 'gateway-telegram'), 'fallback');
    expect(bundle.name).toBe('gateway-telegram');
    expect(bundle.description).toBe('Мост в Telegram');
    expect(bundle.body).toContain('# Тело');
    expect(Object.keys(bundle.files)).toEqual(['extra/notes.md']);
  });

  it('без description — понятная ошибка', () => {
    const dir = tmpDir('gateway-installer-skill-');
    writeFileSync(join(dir, 'SKILL.md'), '---\nname: x\n---\nbody');
    expect(() => readSkillBundle(dir, 'x')).toThrow(/description/);
  });
});

describe('mergeMcpServerIntoConfig (standalone)', () => {
  const server = {
    type: 'http' as const,
    url: 'http://synth-gateway-telegram:7101/mcp/dev',
    description: 'Telegram-шлюз: тулы tg_*',
    enabled: true,
  };

  it('добавляет блок mcp.servers в пустой config', () => {
    const { content, action } = mergeMcpServerIntoConfig('core:\n  port: 5000\n', 'synth-gateway-telegram', server);
    expect(action).toBe('created');
    expect(content).toContain('mcp:\n  servers:');
    expect(content).toContain('    synth-gateway-telegram:');
    expect(content).toContain('      type: http');
    expect(content).toContain('"http://synth-gateway-telegram:7101/mcp/dev"');
    // Существующий контент сохранён.
    expect(content).toContain('core:\n  port: 5000');
  });

  it('добавляет servers: в существующий mcp-блок без servers', () => {
    const { content, action } = mergeMcpServerIntoConfig(
      'mcp:\n  policy: auto\n',
      'synth-gateway-telegram',
      server,
    );
    expect(action).toBe('created');
    expect(content).toBe(
      [
        'mcp:',
        '  servers:',
        '    synth-gateway-telegram:',
        '      type: http',
        `      url: "${server.url}"`,
        `      description: "${server.description}"`,
        '      enabled: true',
        '  policy: auto',
        '',
      ].join('\n'),
    );
  });

  it('заменяет inline `servers: {}`', () => {
    const { content, action } = mergeMcpServerIntoConfig(
      'mcp:\n  servers: {}\n  policy: auto\n',
      'srv',
      server,
    );
    expect(action).toBe('created');
    expect(content).not.toContain('servers: {}');
    expect(content).toContain('  servers:\n    srv:');
  });

  it('вставляет запись в существующий блок servers и идемпотентен', () => {
    const base = 'mcp:\n  servers:\n    other:\n      type: sse\n      url: http://x\n  policy: auto\n';
    const first = mergeMcpServerIntoConfig(base, 'synth-gateway-telegram', server);
    expect(first.action).toBe('created');
    expect(first.content).toContain('    other:');
    expect(first.content).toContain('  policy: auto');

    const second = mergeMcpServerIntoConfig(first.content, 'synth-gateway-telegram', server);
    expect(second.action).toBe('unchanged');
    expect(second.content).toBe(first.content);
  });

  it('обновляет запись при смене URL', () => {
    const base = mergeMcpServerIntoConfig('mcp:\n', 'srv', server).content;
    const updated = mergeMcpServerIntoConfig(base, 'srv', {
      ...server,
      url: 'http://synth-gateway-telegram:7101/mcp/test',
    });
    expect(updated.action).toBe('updated');
    expect(updated.content).toContain('/mcp/test');
    expect(updated.content).not.toContain('/mcp/dev');
  });
});

describe('managed-установка MCP', () => {
  it('создаёт запись реестра (POST /mcp/registry)', async () => {
    const root = fixtureRoot();
    const { fetchImpl, calls } = mockFetch({
      'GET /api/v2/mcp/registry': { status: 200, body: { entries: [] } },
      'POST /api/v2/mcp/registry': { status: 201, body: { id: 'mcp-1' } },
    });
    const result = await runInstaller({
      ...MANAGED,
      rootDir: root,
      mcp: true,
      skills: false,
      fetchImpl,
      log: () => {},
    });
    expect(result.mcp).toEqual({
      action: 'created',
      url: 'http://synth-gateway-telegram:7101/mcp/dev',
    });
    const post = calls.find((call) => call.method === 'POST');
    expect(post?.body).toMatchObject({
      name: 'synth-gateway-telegram',
      config: { type: 'http', url: 'http://synth-gateway-telegram:7101/mcp/dev', enabled: true },
      enabled: true,
    });
  });

  it('при 409 обновляет через PUT /mcp/servers/:name', async () => {
    const root = fixtureRoot();
    const { fetchImpl, calls } = mockFetch({
      'GET /api/v2/mcp/registry': { status: 200, body: { entries: [] } },
      'POST /api/v2/mcp/registry': { status: 409, body: { error: { code: 'CONFLICT' } } },
      'PUT /api/v2/mcp/servers/synth-gateway-telegram': { status: 200, body: {} },
    });
    const result = await runInstaller({
      ...MANAGED,
      rootDir: root,
      mcp: true,
      skills: false,
      fetchImpl,
      log: () => {},
    });
    expect(result.mcp?.action).toBe('updated');
    expect(calls.some((call) => call.method === 'PUT')).toBe(true);
  });

  it('существующая запись → PUT /mcp/registry/:id (без POST)', async () => {
    const root = fixtureRoot();
    const { fetchImpl, calls } = mockFetch({
      'GET /api/v2/mcp/registry': {
        status: 200,
        body: { entries: [{ id: 'mcp-1', name: 'synth-gateway-telegram' }] },
      },
      'PUT /api/v2/mcp/registry/mcp-1': { status: 200, body: {} },
    });
    const result = await runInstaller({
      ...MANAGED,
      rootDir: root,
      mcp: true,
      skills: false,
      fetchImpl,
      log: () => {},
    });
    expect(result.mcp?.action).toBe('updated');
    expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual([
      'GET /api/v2/mcp/registry',
      'PUT /api/v2/mcp/registry/mcp-1',
    ]);
  });
});

describe('managed-установка MCP: headers и enabledByDefault', () => {
  const MCP_TOKEN = 'mcp-bearer-token-1';

  it('create: тело без origin (серверная деталь; схема — instance|user)', async () => {
    const root = fixtureRoot();
    const { fetchImpl, calls } = mockFetch({
      'GET /api/v2/mcp/registry': { status: 200, body: { entries: [] } },
      'POST /api/v2/mcp/registry': { status: 201, body: {} },
    });
    await runInstaller({
      ...MANAGED,
      rootDir: root,
      mcp: true,
      skills: false,
      fetchImpl,
      log: () => {},
    });
    const body = calls.find((call) => call.method === 'POST')?.body as Record<string, unknown>;
    expect(body).not.toHaveProperty('origin');
    expect(Object.keys(body).sort()).toEqual(['config', 'enabled', 'name']);
  });

  it('update (PUT /mcp/registry/:id и PUT /mcp/servers/:name): тело без origin', async () => {
    const root = fixtureRoot();

    const byId = mockFetch({
      'GET /api/v2/mcp/registry': {
        status: 200,
        body: { entries: [{ id: 'mcp-1', name: 'synth-gateway-telegram' }] },
      },
      'PUT /api/v2/mcp/registry/mcp-1': { status: 200, body: {} },
    });
    await runInstaller({
      ...MANAGED,
      rootDir: root,
      mcp: true,
      skills: false,
      fetchImpl: byId.fetchImpl,
      log: () => {},
    });
    const bodies = (calls: { body?: unknown }[]): Record<string, unknown>[] =>
      calls.map((call) => call.body).filter((body): body is Record<string, unknown> => Boolean(body));
    expect(bodies(byId.calls).length).toBeGreaterThan(0);
    for (const body of bodies(byId.calls)) expect(body).not.toHaveProperty('origin');

    const byName = mockFetch({
      'GET /api/v2/mcp/registry': { status: 200, body: { entries: [] } },
      'POST /api/v2/mcp/registry': { status: 409, body: { error: { code: 'CONFLICT' } } },
      'PUT /api/v2/mcp/servers/synth-gateway-telegram': { status: 200, body: {} },
    });
    await runInstaller({
      ...MANAGED,
      rootDir: root,
      mcp: true,
      skills: false,
      fetchImpl: byName.fetchImpl,
      log: () => {},
    });
    expect(bodies(byName.calls).length).toBeGreaterThan(0);
    for (const body of bodies(byName.calls)) expect(body).not.toHaveProperty('origin');
  });

  it('create: заголовок Authorization и enabledByDefault в config записи', async () => {
    const root = fixtureRoot();
    const { fetchImpl, calls } = mockFetch({
      'GET /api/v2/mcp/registry': { status: 200, body: { entries: [] } },
      'POST /api/v2/mcp/registry': { status: 201, body: {} },
    });
    const lines: string[] = [];
    await runInstaller({
      ...MANAGED,
      mcpToken: MCP_TOKEN,
      rootDir: root,
      mcp: true,
      skills: false,
      fetchImpl,
      log: (message) => lines.push(message),
    });
    const post = calls.find((call) => call.method === 'POST');
    expect(post?.body).toMatchObject({
      config: {
        type: 'http',
        headers: { Authorization: `Bearer ${MCP_TOKEN}` },
        enabledByDefault: true,
        enabled: true,
      },
    });
    // Токен не попадает в логи.
    expect(lines.join('\n')).not.toContain(MCP_TOKEN);
  });

  it('update по id реестра: заголовок сохраняется', async () => {
    const root = fixtureRoot();
    const { fetchImpl, calls } = mockFetch({
      'GET /api/v2/mcp/registry': {
        status: 200,
        body: { entries: [{ id: 'mcp-1', name: 'synth-gateway-telegram' }] },
      },
      'PUT /api/v2/mcp/registry/mcp-1': { status: 200, body: {} },
    });
    await runInstaller({
      ...MANAGED,
      mcpToken: MCP_TOKEN,
      rootDir: root,
      mcp: true,
      skills: false,
      fetchImpl,
      log: () => {},
    });
    expect(calls[1]?.body).toMatchObject({
      config: { headers: { Authorization: `Bearer ${MCP_TOKEN}` }, enabledByDefault: true },
    });
  });

  it('update через PUT /mcp/servers/:name: заголовок сохраняется', async () => {
    const root = fixtureRoot();
    const { fetchImpl, calls } = mockFetch({
      'GET /api/v2/mcp/registry': { status: 200, body: { entries: [] } },
      'POST /api/v2/mcp/registry': { status: 409, body: { error: { code: 'CONFLICT' } } },
      'PUT /api/v2/mcp/servers/synth-gateway-telegram': { status: 200, body: {} },
    });
    await runInstaller({
      ...MANAGED,
      mcpToken: MCP_TOKEN,
      rootDir: root,
      mcp: true,
      skills: false,
      fetchImpl,
      log: () => {},
    });
    const put = calls.find((call) => call.method === 'PUT');
    expect(put?.body).toMatchObject({
      config: { headers: { Authorization: `Bearer ${MCP_TOKEN}` } },
    });
  });

  it('без --mcp-token headers отсутствуют (enabledByDefault — есть)', async () => {
    const root = fixtureRoot();
    const { fetchImpl, calls } = mockFetch({
      'GET /api/v2/mcp/registry': { status: 200, body: { entries: [] } },
      'POST /api/v2/mcp/registry': { status: 201, body: {} },
    });
    await runInstaller({
      ...MANAGED,
      rootDir: root,
      mcp: true,
      skills: false,
      fetchImpl,
      log: () => {},
    });
    const config = (calls.find((call) => call.method === 'POST')?.body as {
      config?: Record<string, unknown>;
    }).config;
    expect(config).not.toHaveProperty('headers');
    expect(config?.enabledByDefault).toBe(true);
  });

  it('--no-enabled-by-default снимает сид для новых проектов', async () => {
    const root = fixtureRoot();
    const { fetchImpl, calls } = mockFetch({
      'GET /api/v2/mcp/registry': { status: 200, body: { entries: [] } },
      'POST /api/v2/mcp/registry': { status: 201, body: {} },
    });
    await runInstaller({
      ...MANAGED,
      enabledByDefault: false,
      rootDir: root,
      mcp: true,
      skills: false,
      fetchImpl,
      log: () => {},
    });
    expect(
      (calls.find((call) => call.method === 'POST')?.body as { config?: Record<string, unknown> })
        .config?.enabledByDefault,
    ).toBe(false);
  });
});

describe('managed-установка скиллов', () => {
  it('создаёт скилл и пересканирует реестр', async () => {
    const root = fixtureRoot();
    const { fetchImpl, calls } = mockFetch({
      'POST /api/v2/skills': { status: 201, body: { name: 'gateway-telegram' } },
      'POST /api/v2/skills/reload': { status: 200, body: { status: 'reloaded' } },
    });
    const result = await runInstaller({
      ...MANAGED,
      rootDir: root,
      mcp: false,
      skills: true,
      fetchImpl,
      log: () => {},
    });
    expect(result.skills).toEqual([{ name: 'gateway-telegram', action: 'created' }]);
    expect(calls.some((call) => call.path === '/api/v2/skills/reload')).toBe(true);
    const post = calls.find((call) => call.path === '/api/v2/skills');
    expect(post?.body).toMatchObject({
      name: 'gateway-telegram',
      description: 'Мост в Telegram',
    });
    expect((post?.body as { files?: Record<string, string> }).files?.['extra/notes.md']).toBe(
      'заметки',
    );
  });

  it('существующий скилл → PATCH + PUT файлов (идемпотентное обновление)', async () => {
    const root = fixtureRoot();
    const { fetchImpl, calls } = mockFetch({
      'POST /api/v2/skills': { status: 409, body: { error: { code: 'CONFLICT' } } },
      'PATCH /api/v2/skills/gateway-telegram': { status: 200, body: {} },
      'PUT /api/v2/skills/gateway-telegram/files/extra/notes.md': { status: 200, body: {} },
      'POST /api/v2/skills/reload': { status: 200, body: {} },
    });
    const result = await runInstaller({
      ...MANAGED,
      rootDir: root,
      mcp: false,
      skills: true,
      fetchImpl,
      log: () => {},
    });
    expect(result.skills).toEqual([{ name: 'gateway-telegram', action: 'updated' }]);
    expect(calls.map((call) => `${call.method} ${call.path}`)).toContain(
      'PUT /api/v2/skills/gateway-telegram/files/extra/notes.md',
    );
  });

  it('ошибка API → InstallerError с текстом ошибки', async () => {
    const root = fixtureRoot();
    const { fetchImpl } = mockFetch({
      'POST /api/v2/skills': { status: 403, body: { error: { message: 'нужен scope skills:write' } } },
    });
    await expect(
      runInstaller({ ...MANAGED, rootDir: root, mcp: false, skills: true, fetchImpl, log: () => {} }),
    ).rejects.toThrow(/нужен scope skills:write/);
  });
});

describe('dry-run', () => {
  it('ничего не делает: без запросов и без файловых изменений', async () => {
    const root = fixtureRoot();
    const configPath = join(root, 'config.yaml');
    writeFileSync(configPath, 'core:\n  port: 5000\n');
    const dataDir = join(root, 'data');
    const { fetchImpl, calls } = mockFetch({});

    const result = await runInstaller({
      ...MANAGED,
      rootDir: root,
      configPath,
      dataDir,
      dryRun: true,
      fetchImpl,
      log: () => {},
    });

    expect(calls).toHaveLength(0);
    expect(result.mcp?.action).toBe('dry-run');
    expect(result.skills).toEqual([{ name: 'gateway-telegram', action: 'dry-run' }]);
    expect(readFileSync(configPath, 'utf8')).toBe('core:\n  port: 5000\n');
    expect(existsSync(join(dataDir, 'skills'))).toBe(false);
  });
});

describe('standalone-режим', () => {
  it('merge config.yaml + копирование скилла, повторный прогон идемпотентен', async () => {
    const root = fixtureRoot();
    const configPath = join(root, 'config.yaml');
    writeFileSync(configPath, 'core:\n  port: 5000\n');
    const dataDir = join(root, 'data');

    const first = await runInstaller({
      rootDir: root,
      tenant: 'dev',
      mcpUrl: 'http://synth-gateway-telegram:7101',
      configPath,
      dataDir,
      fetchImpl: mockFetch({}).fetchImpl,
      log: () => {},
    });
    expect(first.mcp?.action).toBe('created');
    expect(first.skills[0]?.action).toBe('created');
    const merged = readFileSync(configPath, 'utf8');
    expect(merged).toContain('synth-gateway-telegram:');
    expect(merged).toContain('/mcp/dev');
    expect(existsSync(join(dataDir, 'skills', 'gateway-telegram', 'SKILL.md'))).toBe(true);
    expect(existsSync(join(dataDir, 'skills', 'gateway-telegram', 'extra', 'notes.md'))).toBe(true);

    const second = await runInstaller({
      rootDir: root,
      tenant: 'dev',
      mcpUrl: 'http://synth-gateway-telegram:7101',
      configPath,
      dataDir,
      fetchImpl: mockFetch({}).fetchImpl,
      log: () => {},
    });
    expect(second.mcp?.action).toBe('unchanged');
    expect(second.skills[0]?.action).toBe('updated');
    expect(readFileSync(configPath, 'utf8')).toBe(merged);
  });

  it('standalone + доступный API → пересканирование скиллов', async () => {
    const root = fixtureRoot();
    const dataDir = join(root, 'data');
    const { fetchImpl, calls } = mockFetch({
      'POST /api/v2/skills/reload': { status: 200, body: {} },
    });
    const result = await runInstaller({
      rootDir: root,
      dataDir,
      synthUrl: MANAGED.synthUrl,
      token: MANAGED.token,
      mcp: false,
      skills: true,
      fetchImpl,
      log: () => {},
    });
    expect(result.reloaded).toBe(true);
    expect(calls).toEqual([{ method: 'POST', path: '/api/v2/skills/reload' }]);
  });

  it('сбой reload не ломает установку (best-effort)', async () => {
    const root = fixtureRoot();
    const dataDir = join(root, 'data');
    const fetchImpl = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;
    const result = await runInstaller({
      rootDir: root,
      dataDir,
      synthUrl: MANAGED.synthUrl,
      token: MANAGED.token,
      mcp: false,
      skills: true,
      fetchImpl,
      log: () => {},
    });
    expect(result.skills[0]?.action).toBe('created');
    expect(result.reloaded).toBe(false);
  });

  it('installMcpStandalone: нет config.yaml → понятная ошибка', () => {
    expect(() =>
      installMcpStandalone({
        configPath: join(tmpDir('gateway-installer-'), 'nope.yaml'),
        name: 'x',
        url: 'http://x/mcp/1',
      }),
    ).toThrow(/не найден config\.yaml/);
  });

  it('installMcpStandalone: пишет headers и enabledByDefault в config.yaml', () => {
    const root = fixtureRoot();
    const configPath = join(root, 'config.yaml');
    writeFileSync(configPath, 'core:\n  port: 5000\n');
    const action = installMcpStandalone({
      configPath,
      name: 'synth-gateway-telegram',
      url: 'http://gw:7101/mcp/dev',
      description: 'Telegram-шлюз: тулы tg_*',
      headers: { Authorization: 'Bearer tok-1' },
      enabledByDefault: true,
    });
    expect(action.action).toBe('created');
    const written = readFileSync(configPath, 'utf8');
    expect(written).toContain('      enabledByDefault: true');
    expect(written).toContain('      headers:\n        Authorization: "Bearer tok-1"');

    // Идемпотентность: тот же прогон — без изменений.
    const again = installMcpStandalone({
      configPath,
      name: 'synth-gateway-telegram',
      url: 'http://gw:7101/mcp/dev',
      description: 'Telegram-шлюз: тулы tg_*',
      headers: { Authorization: 'Bearer tok-1' },
      enabledByDefault: true,
    });
    expect(again.action).toBe('unchanged');
  });

  it('installSkillStandalone копирует каталог и обновляет существующий', () => {
    const root = fixtureRoot();
    const dataDir = join(root, 'data');
    const skillDir = join(root, 'skills', 'gateway-telegram');

    expect(installSkillStandalone(skillDir, dataDir, 'gateway-telegram', false, () => {})).toEqual({
      action: 'created',
    });
    writeFileSync(join(dataDir, 'skills', 'gateway-telegram', 'stale.txt'), 'x');
    expect(installSkillStandalone(skillDir, dataDir, 'gateway-telegram', false, () => {})).toEqual({
      action: 'updated',
    });
    expect(existsSync(join(dataDir, 'skills', 'gateway-telegram', 'SKILL.md'))).toBe(true);
  });
});

describe('ошибки конфигурации инсталлятора', () => {
  it('без режима установки → понятная ошибка', async () => {
    const root = fixtureRoot();
    await expect(
      runInstaller({ rootDir: root, mcpUrl: 'http://m:7101', log: () => {} }),
    ).rejects.toThrow(/managed \(--synth-url \+ --token\) или standalone/);
  });

  it('без режима установки скиллов → понятная ошибка', async () => {
    const root = fixtureRoot();
    await expect(
      runInstaller({ rootDir: root, mcp: false, skills: true, log: () => {} }),
    ).rejects.toThrow(/managed \(--synth-url \+ --token\) или standalone \(--data-dir\)/);
  });

  it('режим проверяется ДО изменений (config.yaml не тронут)', async () => {
    const root = fixtureRoot();
    const configPath = join(root, 'config.yaml');
    writeFileSync(configPath, 'core:\n  port: 5000\n');
    await expect(
      runInstaller({
        rootDir: root,
        mcpUrl: 'http://m:7101',
        configPath,
        log: () => {},
      }),
    ).rejects.toThrow(/не задан режим установки/);
    expect(readFileSync(configPath, 'utf8')).toBe('core:\n  port: 5000\n');
  });

  it('без --mcp-url → понятная ошибка (managed)', async () => {
    const root = fixtureRoot();
    await expect(
      runInstaller({ ...MANAGED, rootDir: root, mcpUrl: undefined, mcp: true, skills: false, log: () => {} }),
    ).rejects.toThrow(/--mcp-url/);
  });

  it('--mcp без provides.mcp → нечего устанавливать', async () => {
    const root = tmpDir('gateway-installer-nomp-');
    writeFileSync(join(root, 'synth.pack'), JSON.stringify({ provides: {} }));
    await expect(
      runInstaller({ ...MANAGED, rootDir: root, mcp: true, skills: false, fetchImpl: mockFetch({}).fetchImpl, log: () => {} }),
    ).rejects.toThrow(/нечего устанавливать/);
  });
});

describe('parseInstallerArgs / main', () => {
  it('разбирает флаги (--flag value и --flag=value) и env-fallback', () => {
    const { options } = parseInstallerArgs(
      ['--synth-url=http://s/api/v2', '--token', 't', '--tenant', 'dev', '--mcp-url', 'http://m:7101', '--skills', '--dry-run'],
      {},
    );
    expect(options).toMatchObject({
      synthUrl: 'http://s/api/v2',
      token: 't',
      tenant: 'dev',
      mcpUrl: 'http://m:7101',
      skills: true,
      mcp: false,
      dryRun: true,
    });

    const fromEnv = parseInstallerArgs([], {
      SYNTH_URL: 'http://env/api/v2',
      SYNTH_INSTALL_TOKEN: 'env-token',
      SYNTH_ADDON_MCP_URL: 'http://env-mcp:7101',
      SYNTH_ADDON_SERVICE_HOST: 'gw.svc',
      SYNTH_ADDON_TENANT: 'prod',
      SYNTH_DATA_DIR: '/data',
      SYNTH_ADDON_SKILLS_DIR: '/etc/skills',
      SYNTH_MCP_TOKEN: 'env-mcp-token',
    });
    expect(fromEnv.options).toMatchObject({
      synthUrl: 'http://env/api/v2',
      token: 'env-token',
      mcpUrl: 'http://env-mcp:7101',
      serviceHost: 'gw.svc',
      tenant: 'prod',
      dataDir: '/data',
      skillsDir: '/etc/skills',
      mcpToken: 'env-mcp-token',
    });
    // Без явных --mcp/--skills — устанавливаются все сущности из provides.
    expect(fromEnv.options.mcp).toBeUndefined();
    expect(fromEnv.options.skills).toBeUndefined();
  });

  it('--only mcp / --only skills / --service-host / --skills-dir', () => {
    const onlyMcp = parseInstallerArgs(['--only', 'mcp'], {});
    expect({ mcp: onlyMcp.options.mcp, skills: onlyMcp.options.skills }).toEqual({
      mcp: true,
      skills: false,
    });
    const onlySkills = parseInstallerArgs(['--only=skills'], {});
    expect({ mcp: onlySkills.options.mcp, skills: onlySkills.options.skills }).toEqual({
      mcp: false,
      skills: true,
    });
    const both = parseInstallerArgs(['--only', 'mcp,skills'], {});
    expect({ mcp: both.options.mcp, skills: both.options.skills }).toEqual({
      mcp: true,
      skills: true,
    });
    expect(() => parseInstallerArgs(['--only', 'events'], {})).toThrow(/--only/);

    const other = parseInstallerArgs(
      ['--service-host', 'gw.synth.svc.cluster.local', '--skills-dir', '/etc/addon/skills'],
      {},
    );
    expect(other.options.serviceHost).toBe('gw.synth.svc.cluster.local');
    expect(other.options.skillsDir).toBe('/etc/addon/skills');
  });

  it('--service-host собирает MCP-URL из provides (хост + порт + путь)', async () => {
    const root = fixtureRoot();
    const { fetchImpl, calls } = mockFetch({
      'GET /api/v2/mcp/registry': { status: 200, body: { entries: [] } },
      'POST /api/v2/mcp/registry': { status: 201, body: {} },
    });
    const result = await runInstaller({
      ...MANAGED,
      mcpUrl: undefined,
      serviceHost: 'synth-gateway-telegram.synth.svc.cluster.local',
      rootDir: root,
      mcp: true,
      skills: false,
      fetchImpl,
      log: () => {},
    });
    expect(result.mcp?.url).toBe(
      'http://synth-gateway-telegram.synth.svc.cluster.local:7101/mcp/dev',
    );
    expect(calls[1]?.body).toMatchObject({
      config: { url: 'http://synth-gateway-telegram.synth.svc.cluster.local:7101/mcp/dev' },
    });
  });

  it('подстановка {tenant} в путь MCP (глобально, все вхождения)', async () => {
    const root = fixtureRoot();
    writeFileSync(
      join(root, 'synth.pack'),
      JSON.stringify({
        name: 'gw',
        version: '1.0.0',
        kind: 'gateway',
        provides: { mcp: { name: 'gw', transport: 'http', path: '/mcp/{tenant}/{tenant}' } },
      }),
    );
    const { fetchImpl, calls } = mockFetch({
      'GET /api/v2/mcp/registry': { status: 200, body: { entries: [] } },
      'POST /api/v2/mcp/registry': { status: 201, body: {} },
    });
    const result = await runInstaller({
      ...MANAGED,
      tenant: 'prod',
      rootDir: root,
      mcp: true,
      skills: false,
      fetchImpl,
      log: () => {},
    });
    expect(result.mcp?.url).toBe('http://synth-gateway-telegram:7101/mcp/prod/prod');
    expect(calls[1]?.body).toMatchObject({
      config: { url: 'http://synth-gateway-telegram:7101/mcp/prod/prod' },
    });
  });

  it('без тенанта подставляется default', async () => {
    const root = fixtureRoot();
    const { fetchImpl } = mockFetch({
      'GET /api/v2/mcp/registry': { status: 200, body: { entries: [] } },
      'POST /api/v2/mcp/registry': { status: 201, body: {} },
    });
    const result = await runInstaller({
      ...MANAGED,
      tenant: undefined,
      rootDir: root,
      mcp: true,
      skills: false,
      fetchImpl,
      log: () => {},
    });
    expect(result.mcp?.url).toBe('http://synth-gateway-telegram:7101/mcp/default');
  });

  it('--skills-dir читает дерево скиллов из смонтированного каталога', async () => {
    const root = fixtureRoot();
    const skillsDir = tmpDir('gateway-installer-skills-');
    mkdirSync(join(skillsDir, 'gateway-telegram'), { recursive: true });
    writeFileSync(
      join(skillsDir, 'gateway-telegram', 'SKILL.md'),
      ['---', 'name: gateway-telegram', 'description: Из ConfigMap', '---', '', 'тело', ''].join('\n'),
    );
    const { fetchImpl, calls } = mockFetch({
      'POST /api/v2/skills': { status: 201, body: {} },
      'POST /api/v2/skills/reload': { status: 200, body: {} },
    });
    const result = await runInstaller({
      rootDir: root,
      synthUrl: MANAGED.synthUrl,
      token: MANAGED.token,
      skillsDir,
      mcp: false,
      skills: true,
      fetchImpl,
      log: () => {},
    });
    expect(result.skills).toEqual([{ name: 'gateway-telegram', action: 'created' }]);
    expect((calls[0]?.body as { description?: string }).description).toBe('Из ConfigMap');
  });

  it('--mcp-token / --no-enabled-by-default и env SYNTH_MCP_TOKEN', () => {
    const args = parseInstallerArgs(
      ['--mcp-token', 'tok-1', '--no-enabled-by-default', '--mcp-url', 'http://m:7101'],
      {},
    );
    expect(args.options.mcpToken).toBe('tok-1');
    expect(args.options.enabledByDefault).toBe(false);

    const fromEnv = parseInstallerArgs([], { SYNTH_MCP_TOKEN: 'env-tok' });
    expect(fromEnv.options.mcpToken).toBe('env-tok');
    // По умолчанию сид не снят (enabledByDefault вычисляется как true).
    expect(fromEnv.options.enabledByDefault).toBeUndefined();
  });

  it('main: exit 0 при dry-run и манифесте в --root', async () => {
    const root = fixtureRoot();
    const lines: string[] = [];
    const code = await main(
      ['--root', root, '--tenant', 'dev', '--mcp-url', 'http://m:7101', '--dry-run'],
      {},
      { log: (message) => lines.push(message), fetchImpl: mockFetch({}).fetchImpl },
    );
    expect(code).toBe(0);
    expect(lines.join('\n')).toContain('dry-run');
  });

  it('main: exit 1 с понятным сообщением при ошибке', async () => {
    const lines: string[] = [];
    const code = await main(['--root', tmpDir('gateway-installer-none-')], {}, {
      log: (message) => lines.push(message),
    });
    expect(code).toBe(1);
    expect(lines.join('\n')).toContain('[install] ошибка:');
  });

  it('main: --help печатает справку и ничего не делает', async () => {
    const lines: string[] = [];
    const code = await main(['--help'], {}, { log: (message) => lines.push(message) });
    expect(code).toBe(0);
    expect(lines.join('\n')).toContain('--synth-url');
  });

  it('isDirectory различает файл и каталог', () => {
    const root = fixtureRoot();
    expect(isDirectory(root)).toBe(true);
    expect(isDirectory(join(root, 'synth.pack'))).toBe(false);
    expect(isDirectory(join(root, 'nope'))).toBe(false);
  });
});
