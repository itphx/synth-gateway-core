import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';

/**
 * JSON-хранилище поверх файловой системы.
 *
 * Соответствует модели хранения Synth (AD-005): запись атомарна — данные пишутся
 * во временный файл `*.tmp.<uuid>` в том же каталоге, затем выполняется
 * `rename()` (атомарна на POSIX). Побочные `.tmp.*` файлы при успешной записи не
 * остаются.
 */
export class FileStore {
  readonly rootDir: string;

  constructor(rootDir: string) {
    this.rootDir = resolve(rootDir);
  }

  /** Создаёт корневой каталог хранилища. */
  async init(): Promise<void> {
    await mkdir(this.rootDir, { recursive: true });
  }

  /** Абсолютный путь с проверкой containment внутри корня. */
  resolvePath(relativePath: string): string {
    const target = resolve(this.rootDir, relativePath);
    const rel = relative(this.rootDir, target);
    if (rel.startsWith('..') || isAbsolute(rel)) {
      throw new Error(`Путь вне хранилища: ${relativePath}`);
    }
    return target;
  }

  /** Читает JSON. Возвращает `null`, если файла нет. */
  async read<T>(relativePath: string): Promise<T | null> {
    const target = this.resolvePath(relativePath);
    try {
      const raw = await readFile(target, 'utf8');
      return JSON.parse(raw) as T;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  /** Атомарно записывает JSON (tmp → rename). */
  async write<T>(relativePath: string, data: T): Promise<void> {
    const target = this.resolvePath(relativePath);
    await mkdir(dirname(target), { recursive: true });
    const tmp = `${target}.tmp.${randomUUID()}`;
    const payload = `${JSON.stringify(data, null, 2)}\n`;
    await writeFile(tmp, payload, 'utf8');
    await rename(tmp, target);
  }

  /** Удаляет файл. Возвращает `true`, если файл существовал. */
  async remove(relativePath: string): Promise<boolean> {
    try {
      await rm(this.resolvePath(relativePath));
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    }
  }

  /** Имена `.json`-файлов каталога (без расширения), отсортированные. */
  async listNames(relativeDir: string): Promise<string[]> {
    const dir = this.resolvePath(relativeDir);
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    return entries
      .filter((name) => name.endsWith('.json'))
      .map((name) => name.slice(0, -'.json'.length))
      .sort();
  }

  /** Читает все JSON-объекты каталога. */
  async listJson<T>(relativeDir: string): Promise<T[]> {
    const names = await this.listNames(relativeDir);
    const result: T[] = [];
    for (const name of names) {
      const value = await this.read<T>(join(relativeDir, `${name}.json`));
      if (value !== null) result.push(value);
    }
    return result;
  }
}

/** Каталог, в котором живут бакеты состояния. */
export const STATE_DIR = 'state';

/** Допустимое имя бакета состояния: буквы, цифры, `.`, `_`, `-`. */
const BUCKET_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * Именованные JSON-бакеты состояния (`state/<bucket>.json`).
 *
 * Изоляция по тенанту задаётся корнем {@link FileStore}: тенант пишет в
 * `data/tenants/<id>`, поэтому бакеты разных тенантов не пересекаются.
 */
export class StateStore {
  private readonly store: FileStore;

  constructor(store: FileStore | string) {
    this.store = typeof store === 'string' ? new FileStore(store) : store;
  }

  /** Создаёт корневой каталог хранилища. */
  async init(): Promise<void> {
    await this.store.init();
  }

  /** Путь файла бакета относительно корня хранилища. */
  bucketPath(bucket: string): string {
    if (!BUCKET_PATTERN.test(bucket)) {
      throw new Error(`Недопустимое имя бакета состояния: «${bucket}»`);
    }
    return join(STATE_DIR, `${bucket}.json`);
  }

  /** Читает бакет. Возвращает `null`, если бакета нет. */
  async read<T>(bucket: string): Promise<T | null> {
    return this.store.read<T>(this.bucketPath(bucket));
  }

  /** Атомарно записывает бакет. */
  async write<T>(bucket: string, value: T): Promise<void> {
    await this.store.write(this.bucketPath(bucket), value);
  }

  /** Удаляет бакет. Возвращает `true`, если бакет существовал. */
  async remove(bucket: string): Promise<boolean> {
    return this.store.remove(this.bucketPath(bucket));
  }
}

/** Максимум ключей в множестве с ограничением размера (дедуп). */
export const DEFAULT_KEY_SET_LIMIT = 1000;

/**
 * Множество ключей с ограничением размера (персистентный дедуп).
 *
 * При переполнении обрезается **хвост** (самые старые ключи) — поведение
 * LRU-подобное, как в эталонном Telegram-шлюзе. Множество персистентно: ключи
 * переживают перезапуск процесса.
 */
export class KeySet {
  private readonly store: StateStore;
  private readonly bucket: string;
  private readonly limit: number;
  private cache: Set<string> | null = null;

  constructor(store: StateStore, bucket: string, limit: number = DEFAULT_KEY_SET_LIMIT) {
    this.store = store;
    this.bucket = bucket;
    this.limit = limit > 0 ? limit : DEFAULT_KEY_SET_LIMIT;
  }

  /** Проверяет, есть ли ключ в множестве. */
  async has(key: string): Promise<boolean> {
    const keys = await this.load();
    return keys.has(key);
  }

  /** Добавляет ключ и сохраняет множество (с обрезанием хвоста при переполнении). */
  async add(key: string): Promise<void> {
    const keys = await this.load();
    keys.add(key);
    const trimmed = [...keys].slice(-this.limit);
    this.cache = new Set(trimmed);
    await this.store.write(this.bucket, { keys: trimmed });
  }

  /** Все ключи множества (в порядке добавления, хвост обрезан). */
  async keys(): Promise<string[]> {
    return [...(await this.load())];
  }

  /** Количество ключей в множестве. */
  async size(): Promise<number> {
    return (await this.load()).size;
  }

  private async load(): Promise<Set<string>> {
    if (this.cache) return this.cache;
    const data = await this.store.read<{ keys?: unknown }>(this.bucket);
    const raw = Array.isArray(data?.keys) ? data.keys : [];
    this.cache = new Set(raw.filter((value): value is string => typeof value === 'string'));
    return this.cache;
  }
}

/**
 * Карта «ключ → значение» в одном бакете состояния (маршруты, курсоры).
 */
export class RecordStore<T> {
  private readonly store: StateStore;
  private readonly bucket: string;

  constructor(store: StateStore, bucket: string) {
    this.store = store;
    this.bucket = bucket;
  }

  /** Значение по ключу; `undefined` — если записи нет. */
  async get(key: string): Promise<T | undefined> {
    const map = await this.load();
    return map[key];
  }

  /** Записывает значение по ключу. */
  async set(key: string, value: T): Promise<void> {
    const map = await this.load();
    map[key] = value;
    await this.store.write(this.bucket, map);
  }

  /** Удаляет запись. Возвращает `true`, если запись существовала. */
  async delete(key: string): Promise<boolean> {
    const map = await this.load();
    if (!(key in map)) return false;
    delete map[key];
    await this.store.write(this.bucket, map);
    return true;
  }

  /** Все записи карты (копия). */
  async all(): Promise<Record<string, T>> {
    return { ...(await this.load()) };
  }

  private async load(): Promise<Record<string, T>> {
    const data = await this.store.read<Record<string, T>>(this.bucket);
    return data ?? {};
  }
}
