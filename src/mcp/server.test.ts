import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { callTool, createMcpServer, sessionIdFromMeta } from './server.js';
import type { McpTool, McpToolset } from './toolset.js';

/** Набор инструментов из списка тулов (вызов — по имени). */
function toolsetOf(tools: McpTool[]): McpToolset {
  return {
    list: () => tools,
    call: async (name, args, extra) => {
      const tool = tools.find((item) => item.name === name);
      if (!tool) throw new Error(`неизвестный инструмент «${name}»`);
      return tool.handler(args, extra);
    },
  };
}

/** Тестовый тул: успешный ответ с `structuredContent`. */
const echoTool: McpTool = {
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

/** Тестовый тул: ошибка с машинным кодом. */
const failingTool: McpTool = {
  name: 'ch_fail',
  title: 'Ошибка',
  description: 'Всегда падает.',
  inputSchema: {},
  handler: async () => {
    const error = new Error('канал недоступен') as Error & { code?: string };
    error.code = 'ch_channel_unavailable';
    throw error;
  },
};

async function connect(toolset: McpToolset): Promise<Client> {
  const server = createMcpServer({ toolset, name: 'synth-gateway-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

describe('createMcpServer: регистрация тулов канала', () => {
  it('регистрирует тулы из McpToolset (имя/описание/схема)', async () => {
    const client = await connect(toolsetOf([echoTool, failingTool]));
    try {
      const { tools } = await client.listTools();
      expect(tools.map((tool) => tool.name).sort()).toEqual(['ch_echo', 'ch_fail']);
      const echo = tools.find((tool) => tool.name === 'ch_echo');
      expect(echo?.description).toBe('Возвращает переданный текст.');
      expect(echo?.inputSchema.required).toEqual(['text']);
    } finally {
      await client.close();
    }
  });

  it('успешный вызов → content + structuredContent', async () => {
    const client = await connect(toolsetOf([echoTool]));
    try {
      const result = await client.callTool({ name: 'ch_echo', arguments: { text: 'привет' } });
      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).toMatchObject({ echoed: 'привет' });
      expect(JSON.stringify(result.content)).toContain('привет');
    } finally {
      await client.close();
    }
  });

  it('ошибка в хендлере → isError: true и машинный код в тексте', async () => {
    const client = await connect(toolsetOf([failingTool]));
    try {
      const result = await client.callTool({ name: 'ch_fail', arguments: {} });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result.content)).toContain('ch_channel_unavailable');
      expect(JSON.stringify(result.content)).toContain('канал недоступен');
    } finally {
      await client.close();
    }
  });

  it('метаданные запроса (_meta) доходят до канала', async () => {
    let seen: unknown;
    const tool: McpTool = {
      ...echoTool,
      handler: async (args, extra) => {
        seen = extra?._meta;
        return echoTool.handler(args, extra);
      },
    };
    const client = await connect(toolsetOf([tool]));
    try {
      await client.callTool({
        name: 'ch_echo',
        arguments: { text: 'x' },
        _meta: { 'synth/session_id': 'sess_1' },
      });
      expect(seen).toMatchObject({ 'synth/session_id': 'sess_1' });
    } finally {
      await client.close();
    }
  });
});

describe('callTool: неизвестное имя инструмента', () => {
  it('ошибка с понятным текстом и списком доступных', async () => {
    const toolset = toolsetOf([echoTool]);
    await expect(callTool(toolset, 'ch_missing', {})).rejects.toThrow(/ch_missing/);
    await expect(callTool(toolset, 'ch_missing', {})).rejects.toThrow(/ch_echo/);
  });

  it('пустой набор — понятное сообщение', async () => {
    await expect(callTool(toolsetOf([]), 'ch_missing', {})).rejects.toThrow(/Доступные: нет/);
  });
});

describe('sessionIdFromMeta', () => {
  it('достаёт id сессии Synth из _meta', () => {
    expect(sessionIdFromMeta({ 'synth/session_id': 'sess_1' })).toBe('sess_1');
    expect(sessionIdFromMeta({ 'synth/session_id': '  sess_2  ' })).toBe('sess_2');
    expect(sessionIdFromMeta({})).toBeUndefined();
    expect(sessionIdFromMeta(undefined)).toBeUndefined();
    expect(sessionIdFromMeta('строка')).toBeUndefined();
  });
});
