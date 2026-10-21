import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { FileStore, KeySet, RecordStore, StateStore } from './store.js';

describe('FileStore', () => {
  let dir: string;
  let store: FileStore;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'gateway-core-store-'));
    store = new FileStore(dir);
    await store.init();
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('write → read: данные сохраняются и читаются обратно', async () => {
    await store.write('items/a.json', { id: 'a', value: 1 });
    expect(await store.read<{ id: string; value: number }>('items/a.json')).toEqual({
      id: 'a',
      value: 1,
    });
  });

  it('read отсутствующего файла → null', async () => {
    expect(await store.read('nope.json')).toBeNull();
  });

  it('запись атомарна: файл валиден и временных *.tmp.* не остаётся', async () => {
    await store.write('items/b.json', { ok: true });
    const names = await readdir(join(dir, 'items'));
    expect(names).toEqual(['b.json']);
    const raw = await readdir(join(dir, 'items'));
    expect(raw.some((name) => name.includes('.tmp.'))).toBe(false);
  });

  it('запись вне корня хранилища запрещена (containment)', () => {
    expect(() => store.resolvePath('../escape.json')).toThrow(/вне хранилища/);
    expect(() => store.resolvePath('/etc/passwd')).toThrow(/вне хранилища/);
  });

  it('remove: true для существующего файла, false для отсутствующего', async () => {
    await store.write('items/c.json', { ok: true });
    expect(await store.remove('items/c.json')).toBe(true);
    expect(await store.remove('items/c.json')).toBe(false);
  });
});

describe('StateStore', () => {
  let dir: string;
  let store: StateStore;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'gateway-core-state-'));
    store = new StateStore(dir);
    await store.init();
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('бакеты живут в state/<bucket>.json', async () => {
    await store.write('routes', { sess_1: { target: 'chat:1' } });
    expect(await readdir(join(dir, 'state'))).toEqual(['routes.json']);
    expect(await store.read<Record<string, { target: string }>>('routes')).toEqual({
      sess_1: { target: 'chat:1' },
    });
  });

  it('отсутствующий бакет → null, remove → true/false', async () => {
    expect(await store.read('missing')).toBeNull();
    await store.write('tmp', { a: 1 });
    expect(await store.remove('tmp')).toBe(true);
    expect(await store.remove('tmp')).toBe(false);
  });

  it('недопустимое имя бакета → ошибка (нет выхода за пределы state/)', async () => {
    expect(() => store.bucketPath('../escape')).toThrow(/Недопустимое имя бакета/);
    expect(() => store.bucketPath('a/b')).toThrow(/Недопустимое имя бакета/);
  });
});

describe('KeySet', () => {
  let dir: string;
  let store: StateStore;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'gateway-core-keys-'));
    store = new StateStore(dir);
    await store.init();
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('has/add: ключ появляется после добавления', async () => {
    const keys = new KeySet(store, 'dedup');
    expect(await keys.has('a')).toBe(false);
    await keys.add('a');
    expect(await keys.has('a')).toBe(true);
    expect(await keys.has('b')).toBe(false);
    expect(await keys.size()).toBe(1);
  });

  it('переполнение обрезает хвост (старые ключи), лимит сохраняется', async () => {
    const keys = new KeySet(store, 'dedup', 3);
    for (const key of ['a', 'b', 'c', 'd', 'e']) await keys.add(key);
    expect(await keys.size()).toBe(3);
    expect(await keys.keys()).toEqual(['c', 'd', 'e']);
    expect(await keys.has('a')).toBe(false);
    expect(await keys.has('e')).toBe(true);
  });

  it('множество персистентно (переживает пересоздание стора)', async () => {
    const keys = new KeySet(store, 'dedup');
    await keys.add('stream:abc');
    const reopened = new KeySet(new StateStore(dir), 'dedup');
    expect(await reopened.has('stream:abc')).toBe(true);
  });
});

describe('RecordStore', () => {
  let dir: string;
  let store: StateStore;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'gateway-core-records-'));
    store = new StateStore(dir);
    await store.init();
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('get/set/delete/all', async () => {
    const routes = new RecordStore<{ target: string }>(store, 'routes');
    expect(await routes.get('sess_1')).toBeUndefined();
    await routes.set('sess_1', { target: 'chat:1' });
    await routes.set('sess_2', { target: 'chat:2' });
    expect(await routes.get('sess_1')).toEqual({ target: 'chat:1' });
    expect(Object.keys(await routes.all()).sort()).toEqual(['sess_1', 'sess_2']);

    expect(await routes.delete('sess_1')).toBe(true);
    expect(await routes.delete('sess_1')).toBe(false);
    expect(await routes.get('sess_1')).toBeUndefined();
    expect(await routes.all()).toEqual({ sess_2: { target: 'chat:2' } });
  });

  it('данные персистентны (переживают пересоздание стора)', async () => {
    const routes = new RecordStore<{ target: string }>(store, 'routes');
    await routes.set('sess_1', { target: 'chat:1' });
    const reopened = new RecordStore<{ target: string }>(new StateStore(dir), 'routes');
    expect(await reopened.get('sess_1')).toEqual({ target: 'chat:1' });
  });
});
