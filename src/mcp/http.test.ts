import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  createMcpHttpHandler,
  DEFAULT_MCP_HTTP_PORT,
  isAuthorized,
  parseTenantPath,
  startMcpHttpServer,
  type McpHttpServerHandle,
} from './http.js';
import type { McpTool, McpToolset } from './toolset.js';

const TOKEN = 'test-mcp-token';

/** Набор инструментов тенанта (один тестовый тул). */
function toolset(): McpToolset {
  const tool: McpTool = {
    name: 'ch_echo',
    title: 'Эхо',
    description: 'Возвращает переданный текст.',
    inputSchema: { text: z.string() },
    handler: async (args) => {
      const text = (args as { text?: string } | undefined)?.text ?? '';
      return {
        content: [{ type: 'text', text: JSON.stringify({ echoed: text }) }],
        structuredContent: { echoed: text },
      };
    },
  };
  return {
    list: () => [tool],
    call: async (name, args, extra) => {
      if (name !== tool.name) throw new Error(`неизвестный инструмент «${name}»`);
      return tool.handler(args, extra);
    },
  };
}

/** Тенанты: обычный id и id с не-ASCII символами (проверка decodeURIComponent). */
function tenants(): Map<string, McpToolset> {
  const map = new Map<string, McpToolset>();
  map.set('dev', toolset());
  map.set('дев', toolset());
  return map;
}

describe('isAuthorized', () => {
  it('принимает только точный Bearer-токен', () => {
    expect(isAuthorized(`Bearer ${TOKEN}`, TOKEN)).toBe(true);
    expect(isAuthorized(`bearer ${TOKEN}`, TOKEN)).toBe(true);
    expect(isAuthorized(`Bearer ${TOKEN}x`, TOKEN)).toBe(false);
    expect(isAuthorized('Bearer wrong', TOKEN)).toBe(false);
    expect(isAuthorized(undefined, TOKEN)).toBe(false);
    expect(isAuthorized(TOKEN, TOKEN)).toBe(false);
  });

  it('токен другой длины не принимается', () => {
    expect(isAuthorized('Bearer short', TOKEN)).toBe(false);
    expect(isAuthorized(`Bearer ${TOKEN}-длиннее`, TOKEN)).toBe(false);
    expect(isAuthorized('Bearer ', TOKEN)).toBe(false);
  });

  it('пустой секрет не принимает произвольный заголовок', () => {
    expect(isAuthorized('Bearer x', '')).toBe(false);
  });
});

describe('parseTenantPath', () => {
  it('извлекает тенанта из /mcp/<id>', () => {
    const known = new Set(['dev', 'test']);
    expect(parseTenantPath('/mcp/dev', known)).toBe('dev');
    expect(parseTenantPath('/mcp/unknown', known)).toBeUndefined();
    expect(parseTenantPath('/mcp', known)).toBeUndefined();
    expect(parseTenantPath('/other/dev', known)).toBeUndefined();
  });

  it('разбирает percent-encoding и отсекает вложенный путь', () => {
    const known = new Set(['dev', 'дев']);
    expect(parseTenantPath('/mcp/%D0%B4%D0%B5%D0%B2', known)).toBe('дев');
    expect(parseTenantPath('/mcp/dev/', known)).toBeUndefined();
    expect(parseTenantPath('/mcp/dev/messages', known)).toBeUndefined();
    expect(parseTenantPath('/mcp/%E0%A4%A', known)).toBeUndefined();
  });
});

describe('HTTP-MCP: health / auth / маршрутизация по тенанту', () => {
  it('GET /health — без auth, перечисляет тенантов', async () => {
    const handle = await startMcpHttpServer({
      tenants: tenants(),
      token: TOKEN,
      host: '127.0.0.1',
      port: 0,
      version: '9.9.9',
      name: 'synth-gateway-test',
    });
    try {
      const response = await fetch(`http://127.0.0.1:${handle.port}/health`);
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        status: string;
        version: string;
        transport: string;
        tenants: string[];
      };
      expect(body).toEqual({
        status: 'ok',
        version: '9.9.9',
        transport: 'http',
        tenants: ['dev', 'дев'],
      });
    } finally {
      await handle.close();
    }
  });

  it('без токена → 401 (до маршрутизации)', async () => {
    const handle = await startMcpHttpServer({
      tenants: tenants(),
      token: TOKEN,
      host: '127.0.0.1',
      port: 0,
    });
    try {
      for (const path of ['/mcp/dev', '/mcp/unknown']) {
        const response = await fetch(`http://127.0.0.1:${handle.port}${path}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' }),
        });
        expect(response.status).toBe(401);
        expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
          'UNAUTHORIZED',
        );
      }
    } finally {
      await handle.close();
    }
  });

  it('неверный токен → 401', async () => {
    const handle = await startMcpHttpServer({
      tenants: tenants(),
      token: TOKEN,
      host: '127.0.0.1',
      port: 0,
    });
    try {
      const response = await fetch(`http://127.0.0.1:${handle.port}/mcp/dev`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer wrong' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' }),
      });
      expect(response.status).toBe(401);
    } finally {
      await handle.close();
    }
  });

  it('неизвестный тенант → 404', async () => {
    const handle = await startMcpHttpServer({
      tenants: tenants(),
      token: TOKEN,
      host: '127.0.0.1',
      port: 0,
    });
    try {
      const response = await fetch(`http://127.0.0.1:${handle.port}/mcp/unknown`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' }),
      });
      expect(response.status).toBe(404);
      const body = (await response.json()) as { error: { code: string; message: string } };
      expect(body.error.code).toBe('NOT_FOUND');
      expect(body.error.message).toContain('dev');
    } finally {
      await handle.close();
    }
  });

  it('посторонний путь → 404', async () => {
    const handle = await startMcpHttpServer({
      tenants: tenants(),
      token: TOKEN,
      host: '127.0.0.1',
      port: 0,
    });
    try {
      const response = await fetch(`http://127.0.0.1:${handle.port}/nope`, {
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      expect(response.status).toBe(404);
    } finally {
      await handle.close();
    }
  });
});

/** Разбор SSE-ответа: возвращает JSON первых `data:`-строк. */
function parseSse(text: string): unknown[] {
  const events: unknown[] = [];
  for (const line of text.split('\n')) {
    if (!line.startsWith('data:')) continue;
    const payload = line.slice('data:'.length).trim();
    if (payload) events.push(JSON.parse(payload) as unknown);
  }
  return events;
}

interface JsonRpcResult {
  jsonrpc: string;
  id?: number;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
}

describe('HTTP-MCP: stateless-транспорт (MCP-сессий нет)', () => {
  let handle: McpHttpServerHandle;
  let baseUrl: string;

  /** POST JSON-RPC на MCP-эндпоинт; возвращает ответ + распарсенные SSE-события. */
  async function rpc(
    path: string,
    body: unknown,
    headers: Record<string, string> = {},
  ): Promise<{ status: number; sessionId: string | null; messages: JsonRpcResult[] }> {
    const response = await fetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${TOKEN}`,
        ...headers,
      },
      body: JSON.stringify(body),
    });
    const text = await response.text();
    const messages = response.headers
      .get('content-type')
      ?.includes('text/event-stream')
      ? (parseSse(text) as JsonRpcResult[])
      : text
        ? [JSON.parse(text) as JsonRpcResult]
        : [];
    return { status: response.status, sessionId: response.headers.get('mcp-session-id'), messages };
  }

  const INITIALIZE = {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'gateway-test', version: '0.0.0' },
    },
  };

  it('initialize отдаёт serverInfo и не выдаёт session id', async () => {
    handle = await startMcpHttpServer({
      tenants: tenants(),
      token: TOKEN,
      host: '127.0.0.1',
      port: 0,
      version: '1.2.3',
      name: 'synth-gateway-test',
    });
    baseUrl = `http://127.0.0.1:${handle.port}`;
    const init = await rpc('/mcp/dev', INITIALIZE);
    expect(init.status).toBe(200);
    const info = init.messages.find((message) => message.id === 1)?.result?.serverInfo as {
      name: string;
      version: string;
    };
    expect(info?.name).toBe('synth-gateway-test');
    expect(info?.version).toBe('1.2.3');
    // Stateless: сервер не выдаёт `mcp-session-id`.
    expect(init.sessionId).toBeNull();
  });

  it('tools/list работает без сессии и при повторных запросах (новый транспорт каждый раз)', async () => {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const list = await rpc('/mcp/dev', { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
      expect(list.status).toBe(200);
      const tools = (list.messages.find((message) => message.id === 2)?.result?.tools ?? []) as {
        name: string;
      }[];
      expect(tools.map((tool) => tool.name)).toContain('ch_echo');
    }
  });

  it('tools/call отдаёт результат тула канала', async () => {
    const call = await rpc('/mcp/dev', {
      jsonrpc: '2.0',
      id: 5,
      method: 'tools/call',
      params: { name: 'ch_echo', arguments: { text: 'привет' } },
    });
    expect(call.status).toBe(200);
    const content = call.messages.find((message) => message.id === 5)?.result?.content as
      | { type: string; text: string }[]
      | undefined;
    expect(JSON.parse(content?.[0]?.text ?? '{}')).toEqual({ echoed: 'привет' });
  });

  it('произвольный (устаревший) mcp-session-id не даёт 404 — регресс на рестарт пода', async () => {
    const stale = 'stale-session-id-after-gateway-restart';
    const list = await rpc(
      '/mcp/dev',
      { jsonrpc: '2.0', id: 6, method: 'tools/list', params: {} },
      { 'mcp-session-id': stale },
    );
    expect(list.status).toBe(200);
    expect(list.messages.find((message) => message.id === 6)?.result?.tools).toBeDefined();
  });

  it('порт 0 → фактически назначенный порт; сервер закрывается', async () => {
    expect(handle.port).toBeGreaterThan(0);
    const closed = await handle.close();
    expect(closed).toBeUndefined();
  });
});

describe('startMcpHttpServer', () => {
  it('без токена — fail-fast с понятным сообщением', async () => {
    await expect(
      startMcpHttpServer({ tenants: tenants(), token: '  ' }),
    ).rejects.toThrow(/GATEWAY_MCP_TOKEN/);
  });

  it('порт по умолчанию — 7101', () => {
    expect(DEFAULT_MCP_HTTP_PORT).toBe(7101);
  });

  it('createMcpHttpHandler возвращает слушатель и close', () => {
    const created = createMcpHttpHandler({ tenants: tenants(), token: TOKEN });
    expect(typeof created.handler).toBe('function');
    expect(typeof created.close).toBe('function');
    created.close();
  });
});
