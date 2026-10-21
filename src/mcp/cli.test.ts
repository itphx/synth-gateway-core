import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { DEFAULT_MCP_HTTP_PORT } from './http.js';
import { MCP_TOKEN_ENV, parseArgs, readMcpToken } from './cli.js';

const tmpDirs: string[] = [];

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'gateway-mcp-cli-'));
  tmpDirs.push(dir);
  return dir;
}

describe('parseArgs', () => {
  it('по умолчанию — stdio, хост 0.0.0.0, порт 7101', () => {
    expect(parseArgs([])).toEqual({ http: false, host: '0.0.0.0', port: 7101, help: false });
  });

  it('--http / --host / --port (и форма --flag=value)', () => {
    expect(parseArgs(['--http'])).toMatchObject({ http: true });
    expect(parseArgs(['--http', '--host', '127.0.0.1', '--port', '7200'])).toMatchObject({
      http: true,
      host: '127.0.0.1',
      port: 7200,
    });
    expect(parseArgs(['--host=127.0.0.2', '--port=7201'])).toMatchObject({
      host: '127.0.0.2',
      port: 7201,
    });
  });

  it('--help / -h', () => {
    expect(parseArgs(['--help']).help).toBe(true);
    expect(parseArgs(['-h']).help).toBe(true);
  });

  it('мусорный порт игнорируется (остаётся дефолт)', () => {
    expect(parseArgs(['--port', 'не-число']).port).toBe(DEFAULT_MCP_HTTP_PORT);
  });
});

describe('readMcpToken', () => {
  it('env важнее файла', () => {
    const dir = tmpDir();
    writeFileSync(join(dir, 'mcp_token'), 'из-файла');
    expect(readMcpToken({ [MCP_TOKEN_ENV]: 'из-env' }, dir)).toBe('из-env');
  });

  it('файл — fallback, пустая строка = отсутствие значения', () => {
    const dir = tmpDir();
    writeFileSync(join(dir, 'mcp_token'), '  из-файла  \n');
    expect(readMcpToken({}, dir)).toBe('из-файла');

    const empty = tmpDir();
    writeFileSync(join(empty, 'mcp_token'), '   \n');
    expect(readMcpToken({}, empty)).toBeUndefined();
  });

  it('пустой env = отсутствие значения (файл читается)', () => {
    const dir = tmpDir();
    writeFileSync(join(dir, 'mcp_token'), 'из-файла');
    expect(readMcpToken({ [MCP_TOKEN_ENV]: '  ' }, dir)).toBe('из-файла');
  });

  it('нет ни env, ни файла → undefined', () => {
    expect(readMcpToken({}, tmpDir())).toBeUndefined();
  });
});
