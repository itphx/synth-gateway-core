/**
 * Инсталлятор ресурсов `provides` (MCP-реестр, скилл) в инстанс Synth
 * (ADR-103, §4.7 контракта пакета).
 *
 * Зачем: шлюз отдаёт MCP по HTTP и поставляет скилл — их надо зарегистрировать
 * в инстансе Synth. Делается это идемпотентно, двумя путями:
 *
 * - **managed** (`--synth-url` + `--token`, машинная креда со scopes
 *   `addons:install`/`skills:*`): `GET /mcp/registry` → запись с тем же именем
 *   обновляется (`PUT /mcp/registry/:id`), иначе `POST /mcp/registry` (при
 *   конфликте — `PUT /mcp/servers/:name`); скилл — `POST /skills` (при
 *   конфликте — `PATCH /skills/:name` + `PUT /skills/:name/files/*`), затем
 *   `POST /skills/reload`;
 * - **standalone** (`--config <config.yaml>` + `--data-dir <dir>`): merge
 *   `mcp.servers` в config.yaml и копирование каталога скилла в
 *   `{dataDir}/skills/<name>/` (при доступном API — `POST /skills/reload`).
 *
 * Контракт `provides` берётся из `synth.pack`; `{tenant}` в `provides.mcp.path`
 * подставляется значением `--tenant`.
 *
 * Идемпотентность: повторный прогон не создаёт дублей и не ломает настройки
 * (обновление вместо создания, файлы перезаписываются теми же содержимыми).
 * Режим установки проверяется **до** любых изменений — частичная установка
 * невозможна. Секреты не логируются; при ошибке — понятное сообщение и код
 * возврата ≠ 0.
 */

import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Каталог репозитория шлюза (по умолчанию — корень пакета). */
const DEFAULT_ROOT = fileURLToPath(new URL('../', import.meta.url));

/** Префикс логов инсталлятора. */
export const INSTALL_LOG_PREFIX = '[gateway][install]';

/** Ошибка инсталлятора (понятное сообщение; код возврата ≠ 0). */
export class InstallerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InstallerError';
  }
}

/** MCP-часть манифеста `provides`. */
export interface InstallerMcpProvides {
  name: string;
  /** Транспорт: `http` (единственный поддерживаемый инсталлятором). */
  transport?: string;
  /** Порт MCP-сервера (информационно; для логов и `--service-host`). */
  port?: number;
  /** Путь эндпоинта с плейсхолдером `{tenant}`. */
  path?: string;
  description?: string;
  /** Явный URL MCP-сервера (иначе — `--mcp-url`, иначе — `--service-host`). */
  url?: string;
}

/** Скилл-часть манифеста `provides`. */
export interface InstallerSkillProvides {
  name: string;
  /** Относительный путь каталога скилла в репозитории шлюза. */
  path: string;
}

/** Секция `provides` манифеста `synth.pack`. */
export interface InstallerProvides {
  mcp?: InstallerMcpProvides;
  skills?: InstallerSkillProvides[];
}

/** Манифест шлюза (срез, нужный инсталлятору). */
export interface InstallerManifest {
  name?: string;
  version?: string;
  /** Класс расширения (`gateway`/`addon`/…) — из `synth.pack`. */
  kind?: string;
  provides?: InstallerProvides;
}

/** Скилл, прочитанный с диска (формат AD-046, `SKILL.md` + supporting-файлы). */
export interface SkillBundle {
  name: string;
  description: string;
  /** Тело Markdown без frontmatter. */
  body: string;
  /** Дополнительные файлы: относительный путь → содержимое. */
  files: Record<string, string>;
}

/** Итог установки одной сущности. */
export type InstallAction = 'created' | 'updated' | 'unchanged' | 'skipped' | 'dry-run' | 'planned';

/** Итог прогона инсталлятора. */
export interface InstallerResult {
  mcp?: { action: InstallAction; url?: string };
  skills: { name: string; action: InstallAction }[];
  reloaded: boolean;
}

/** Опции прогона инсталлятора (после разбора аргументов). */
export interface InstallerOptions {
  /** Корень репозитория шлюза (где `synth.pack`). */
  rootDir?: string;
  /** Тенант — подстановка в `provides.mcp.path`. */
  tenant?: string;
  /** Базовый URL API v2 инстанса Synth. */
  synthUrl?: string;
  /** Машинный токен (service-key со scope `addons:install`). */
  token?: string;
  /** Базовый URL MCP-эндпоинта шлюза (без пути тенанта). */
  mcpUrl?: string;
  /**
   * Хост сервиса шлюза в кластере (`--service-host`): из него собирается
   * базовый URL MCP (`http://<host>:<provides.mcp.port>`) — общий контракт с
   * hook-Job'ом чарта (`serviceHost` → `--service-host`).
   */
  serviceHost?: string;
  /**
   * Корень каталога скиллов (`--skills-dir`): скиллы читаются как
   * `<skillsDir>/<provides.skills[].name>` — для шлюзов без образа, где файлы
   * монтируются из ConfigMap.
   */
  skillsDir?: string;
  /** Устанавливать MCP (выбор пользователя). */
  mcp?: boolean;
  /** Устанавливать скиллы. */
  skills?: boolean;
  /** Только показать план, ничего не менять. */
  dryRun?: boolean;
  /**
   * Bearer-токен MCP-клиентов шлюза (`--mcp-token` / env `SYNTH_MCP_TOKEN`):
   * уходит в `config.headers.Authorization` записи реестра (ядро пробрасывает
   * `headers` в MCP-клиент). В логи не пишется.
   */
  mcpToken?: string;
  /**
   * Сид «включён по умолчанию для новых проектов» (`enabledByDefault` в записи
   * реестра / config). По умолчанию `true`; `--no-enabled-by-default` снимает.
   */
  enabledByDefault?: boolean;
  /** Standalone: путь к config.yaml (merge `mcp.servers`). */
  configPath?: string;
  /** Standalone: каталог данных инстанса (копирование скиллов). */
  dataDir?: string;
  /** Реализация fetch (для тестов). */
  fetchImpl?: typeof fetch;
  /** Логгер (по умолчанию — stdout). */
  log?: (message: string) => void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function describeUnknown(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Читает и валидирует `synth.pack` (понятные ошибки на отсутствие/битый JSON). */
export function readAddonManifest(rootDir: string): InstallerManifest {
  const path = join(rootDir, 'synth.pack');
  if (!existsSync(path)) {
    throw new InstallerError(`не найден манифест шлюза: ${path}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  } catch (error) {
    throw new InstallerError(`некорректный JSON в ${path}: ${describeUnknown(error)}`);
  }
  if (!isRecord(parsed)) throw new InstallerError(`${path}: ожидается объект`);

  const manifest: InstallerManifest = {};
  if (typeof parsed.name === 'string') manifest.name = parsed.name;
  if (typeof parsed.version === 'string') manifest.version = parsed.version;
  if (typeof parsed.kind === 'string') manifest.kind = parsed.kind;

  const providesRaw = parsed.provides;
  if (providesRaw !== undefined) {
    if (!isRecord(providesRaw)) throw new InstallerError(`${path}: «provides» должен быть объектом`);
    const provides: InstallerProvides = {};

    const mcpRaw = providesRaw.mcp;
    if (mcpRaw !== undefined) {
      if (!isRecord(mcpRaw) || typeof mcpRaw.name !== 'string' || !mcpRaw.name.trim()) {
        throw new InstallerError(`${path}: provides.mcp.name обязателен`);
      }
      provides.mcp = {
        name: mcpRaw.name.trim(),
        ...(typeof mcpRaw.transport === 'string' ? { transport: mcpRaw.transport } : {}),
        ...(typeof mcpRaw.port === 'number' ? { port: mcpRaw.port } : {}),
        ...(typeof mcpRaw.path === 'string' ? { path: mcpRaw.path } : {}),
        ...(typeof mcpRaw.description === 'string' ? { description: mcpRaw.description } : {}),
        ...(typeof mcpRaw.url === 'string' ? { url: mcpRaw.url } : {}),
      };
    }

    const skillsRaw = providesRaw.skills;
    if (skillsRaw !== undefined) {
      if (!Array.isArray(skillsRaw)) {
        throw new InstallerError(`${path}: «provides.skills» должен быть массивом`);
      }
      provides.skills = skillsRaw.map((entry, index) => {
        if (!isRecord(entry) || typeof entry.name !== 'string' || typeof entry.path !== 'string') {
          throw new InstallerError(`${path}: provides.skills[${index}] требует name и path`);
        }
        return { name: entry.name.trim(), path: entry.path.trim() };
      });
    }
    manifest.provides = provides;
  }
  return manifest;
}

/** Подставляет `{tenant}` в путь MCP-эндпоинта. */
export function resolveMcpEndpointPath(path: string | undefined, tenant: string): string {
  const template = path?.trim() || '/mcp/{tenant}';
  return template.replace(/\{tenant\}/g, tenant);
}

/** Разбирает frontmatter `SKILL.md` (плоские скаляры `key: value`). */
export function parseSkillFrontmatter(content: string): {
  meta: Record<string, string>;
  body: string;
} {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(content);
  if (!match) return { meta: {}, body: content };
  const meta: Record<string, string> = {};
  for (const line of (match[1] ?? '').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf(':');
    if (idx <= 0) continue;
    const key = trimmed.slice(0, idx).trim();
    let value = trimmed.slice(idx + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    meta[key] = value;
  }
  return { meta, body: content.slice(match[0].length) };
}

/** Рекурсивно собирает файлы каталога: относительный путь → содержимое. */
function readFilesRecursive(dir: string, base = dir): Record<string, string> {
  const files: Record<string, string> = {};
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      Object.assign(files, readFilesRecursive(full, base));
    } else if (entry.isFile()) {
      files[relative(base, full).split('\\').join('/')] = readFileSync(full, 'utf8');
    }
  }
  return files;
}

/**
 * Читает каталог скилла (`SKILL.md` + supporting-файлы) в пакет для API v2.
 * Описание берётся из frontmatter `description` (обязательно для `POST /skills`).
 */
export function readSkillBundle(skillDir: string, fallbackName: string): SkillBundle {
  const skillFile = join(skillDir, 'SKILL.md');
  if (!existsSync(skillFile)) {
    throw new InstallerError(`не найден ${skillFile}`);
  }
  const { meta, body } = parseSkillFrontmatter(readFileSync(skillFile, 'utf8'));
  const name = (meta.name ?? fallbackName).trim();
  const description = (meta.description ?? '').trim();
  if (!description) {
    throw new InstallerError(`${skillFile}: во frontmatter нужен «description»`);
  }
  const files = readFilesRecursive(skillDir);
  delete files['SKILL.md'];
  return { name, description, body, files };
}

function indentOf(line: string): number {
  return line.length - line.trimStart().length;
}

/** Строка YAML-значения: кавычки защищают от спецсимволов (двоеточие, `*`, `{`). */
function yamlString(value: string): string {
  return JSON.stringify(value);
}

/** Конфигурация MCP-сервера (совместима с `mcpServerConfigSchema`, AD-071). */
export interface McpServerConfigInput {
  type: 'http' | 'sse' | 'stdio';
  url?: string;
  description?: string;
  enabled?: boolean;
  /** Сид «включён по умолчанию для НОВЫХ проектов» (`snapshot` на момент создания). */
  enabledByDefault?: boolean;
  /**
   * HTTP-заголовки подключения (AD-071): авторизация MCP-клиента Synth —
   * `{ Authorization: 'Bearer <токен MCP-клиентов>' }`.
   */
  headers?: Record<string, string>;
}

/** Сериализует запись MCP-сервера в строки config.yaml (отступ 4). */
function renderConfigEntry(name: string, config: McpServerConfigInput): string[] {
  const lines = [`    ${name}:`, `      type: ${config.type}`];
  if (config.url) lines.push(`      url: ${yamlString(config.url)}`);
  if (config.description) lines.push(`      description: ${yamlString(config.description)}`);
  if (config.enabled !== undefined) lines.push(`      enabled: ${config.enabled}`);
  if (config.enabledByDefault !== undefined) {
    lines.push(`      enabledByDefault: ${config.enabledByDefault}`);
  }
  if (config.headers && Object.keys(config.headers).length > 0) {
    lines.push('      headers:');
    for (const [key, value] of Object.entries(config.headers)) {
      lines.push(`        ${key}: ${yamlString(value)}`);
    }
  }
  return lines;
}

/**
 * Merge записи MCP-сервера в `mcp.servers` config.yaml (минимальный, но
 * полноценный YAML-фрагмент; внешних зависимостей нет).
 *
 * Идемпотентность: существующая запись того же имени **переписывается** теми же
 * значениями (повторный прогон → `unchanged`).
 */
export function mergeMcpServerIntoConfig(
  content: string,
  name: string,
  config: McpServerConfigInput,
): { content: string; action: 'created' | 'updated' | 'unchanged' } {
  const entryLines = renderConfigEntry(name, config);
  const lines = content.split('\n');

  const mcpIdx = lines.findIndex((line) => /^mcp:\s*$/.test(line));
  if (mcpIdx < 0) {
    const body = ['', 'mcp:', '  servers:', ...entryLines].join('\n');
    return { content: `${content.replace(/\s*$/, '')}${body}\n`, action: 'created' };
  }

  // Границы блока `mcp:` — до первой непустой строки без отступа (без хвостовых
  // пустых строк: иначе сравнение «то же содержимое» ломается на финальном `\n`).
  let lastContent = lines.length;
  while (lastContent > 0 && (lines[lastContent - 1] ?? '').trim() === '') lastContent -= 1;

  let mcpEnd = lines.length;
  for (let i = mcpIdx + 1; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    if (line.trim() && indentOf(line) === 0) {
      mcpEnd = i;
      break;
    }
  }
  if (mcpEnd === lines.length) mcpEnd = lastContent;

  const serversIdx = lines.findIndex(
    (line, index) => index > mcpIdx && index < mcpEnd && /^ {2}servers:\s*(\{\})?\s*$/.test(line),
  );
  if (serversIdx < 0) {
    // `mcp:` без `servers:` — добавляем блок сразу после `mcp:`.
    const inserted = ['  servers:', ...entryLines];
    lines.splice(mcpIdx + 1, 0, ...inserted);
    return { content: lines.join('\n'), action: 'created' };
  }

  const inlineEmpty = /^ {2}servers:\s*\{\}\s*$/.test(lines[serversIdx] ?? '');
  if (inlineEmpty) lines[serversIdx] = '  servers:';

  const serversEnd = (() => {
    for (let i = serversIdx + 1; i < mcpEnd; i += 1) {
      const line = lines[i] ?? '';
      if (line.trim() && indentOf(line) <= 2) return i;
    }
    return mcpEnd;
  })();
  const entryIdx = lines.findIndex(
    (line, index) => index > serversIdx && index < serversEnd && new RegExp(`^ {4}${name}:\\s*$`).test(line),
  );

  if (entryIdx < 0) {
    lines.splice(serversEnd, 0, ...entryLines);
    return { content: lines.join('\n'), action: 'created' };
  }

  let entryEnd = serversEnd;
  for (let i = entryIdx + 1; i < serversEnd; i += 1) {
    const line = lines[i] ?? '';
    if (line.trim() && indentOf(line) <= 4) {
      entryEnd = i;
      break;
    }
  }
  const existing = lines.slice(entryIdx, entryEnd);
  const same =
    existing.length === entryLines.length && existing.every((line, i) => line === entryLines[i]);
  if (same) return { content, action: 'unchanged' };

  lines.splice(entryIdx, entryEnd - entryIdx, ...entryLines);
  return { content: lines.join('\n'), action: 'updated' };
}

/** Атомарная запись файла (tmp → rename), как в FileStore ядра (AD-005). */
function atomicWrite(path: string, content: string): void {
  const tmp = `${path}.tmp.${randomUUID()}`;
  writeFileSync(tmp, content, 'utf8');
  renameSync(tmp, path);
}

interface ApiResponse {
  status: number;
  data: unknown;
}

/** Вызов API v2 с машинным токеном; сетевые ошибки — понятный InstallerError. */
async function api(
  options: Required<Pick<InstallerOptions, 'synthUrl'>> & { token: string; fetchImpl: typeof fetch },
  method: string,
  path: string,
  body?: unknown,
): Promise<ApiResponse> {
  const url = `${options.synthUrl.replace(/\/+$/, '')}${path}`;
  let response: Response;
  try {
    response = await options.fetchImpl(url, {
      method,
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${options.token}`,
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  } catch (error) {
    throw new InstallerError(`API Synth недоступен (${url}): ${describeUnknown(error)}`);
  }
  const text = await response.text();
  let data: unknown;
  try {
    data = text ? JSON.parse(text) : undefined;
  } catch {
    data = text;
  }
  return { status: response.status, data };
}

/** Текст ошибки API v2 (`{ error: { code, message } }`). */
function apiErrorText(result: ApiResponse): string {
  if (isRecord(result.data) && isRecord(result.data.error)) {
    const message = result.data.error.message;
    if (typeof message === 'string' && message.trim()) return message.trim();
  }
  return `HTTP ${result.status}`;
}

/**
 * Собирает конфигурацию MCP-сервера для записи реестра/`config.yaml`:
 * `enabled` (мастер-флаг), `enabledByDefault` (сид для новых проектов; по умолчанию
 * `true`) и `headers.Authorization` при заданном `--mcp-token` (ядро пробрасывает
 * `headers` в MCP-клиент — без токена подключение к HTTP-MCP шлюза получит 401).
 * Секрет в логи не попадает: в конфиг уходит, в сообщения — нет.
 */
export function buildMcpServerConfig(
  options: Pick<InstallerOptions, 'mcpToken' | 'enabledByDefault'>,
  mcpUrl: string,
  description: string | undefined,
): McpServerConfigInput {
  const token = options.mcpToken?.trim();
  return {
    type: 'http',
    url: mcpUrl,
    ...(description ? { description } : {}),
    enabled: true,
    enabledByDefault: options.enabledByDefault !== false,
    ...(token ? { headers: { Authorization: `Bearer ${token}` } } : {}),
  };
}

async function installMcpManaged(
  options: InstallerOptions,
  manifest: InstallerManifest,
  mcpUrl: string,
): Promise<InstallerResult['mcp']> {
  const mcp = manifest.provides?.mcp;
  if (!mcp) return undefined;
  const config = buildMcpServerConfig(
    options,
    mcpUrl,
    mcp.description ?? `Шлюз ${manifest.name ?? mcp.name}`,
  );
  const client = {
    synthUrl: options.synthUrl!,
    token: options.token!,
    fetchImpl: options.fetchImpl ?? globalThis.fetch,
  };
  const log = options.log ?? (() => {});

  // Идемпотентность: запись в реестре с тем же именем → обновляем по id.
  const registry = await api(client, 'GET', '/mcp/registry');
  if (registry.status === 200) {
    const entries = isRecord(registry.data) && Array.isArray(registry.data.entries)
      ? registry.data.entries
      : Array.isArray(registry.data)
        ? registry.data
        : [];
    const existing = entries.filter(isRecord).find((entry) => entry.name === mcp.name);
    if (existing && typeof existing.id === 'string') {
      const updated = await api(client, 'PUT', `/mcp/registry/${encodeURIComponent(existing.id)}`, {
        config,
        enabled: true,
      });
      if (updated.status === 200 || updated.status === 201) return { action: 'updated', url: mcpUrl };
      log(`${INSTALL_LOG_PREFIX} не удалось обновить запись реестра: ${apiErrorText(updated)}`);
    }
  }

  // Поле `origin` НЕ отправляем: это серверная деталь (AD-071) — схема допускает
  // только `instance|user`, а для installer-ключа инстанс сам проставляет
  // `instance`. Клиентская передача чужого значения даёт 400 invalid_enum_value.
  const created = await api(client, 'POST', '/mcp/registry', {
    name: mcp.name,
    config,
    enabled: true,
  });
  if (created.status === 200 || created.status === 201) return { action: 'created', url: mcpUrl };

  if (created.status === 409) {
    const updated = await api(client, 'PUT', `/mcp/servers/${encodeURIComponent(mcp.name)}`, {
      name: mcp.name,
      config,
    });
    if (updated.status === 200 || updated.status === 201) return { action: 'updated', url: mcpUrl };
    throw new InstallerError(`MCP-сервер «${mcp.name}» уже есть, обновление не удалось: ${apiErrorText(updated)}`);
  }
  throw new InstallerError(`не удалось зарегистрировать MCP-сервер «${mcp.name}»: ${apiErrorText(created)}`);
}

async function installSkillsManaged(
  options: InstallerOptions,
  skills: SkillBundle[],
): Promise<{ name: string; action: InstallAction }[]> {
  const client = {
    synthUrl: options.synthUrl!,
    token: options.token!,
    fetchImpl: options.fetchImpl ?? globalThis.fetch,
  };
  const log = options.log ?? (() => {});
  const results: { name: string; action: InstallAction }[] = [];

  for (const skill of skills) {
    const created = await api(client, 'POST', '/skills', {
      name: skill.name,
      description: skill.description,
      body: skill.body,
      files: skill.files,
    });
    if (created.status === 200 || created.status === 201) {
      results.push({ name: skill.name, action: 'created' });
      continue;
    }
    if (created.status !== 409) {
      throw new InstallerError(`не удалось создать скилл «${skill.name}»: ${apiErrorText(created)}`);
    }

    const patched = await api(client, 'PATCH', `/skills/${encodeURIComponent(skill.name)}`, {
      description: skill.description,
      body: skill.body,
    });
    if (patched.status !== 200) {
      throw new InstallerError(`не удалось обновить скилл «${skill.name}»: ${apiErrorText(patched)}`);
    }
    for (const [relPath, content] of Object.entries(skill.files)) {
      const filePath = relPath.split('/').map(encodeURIComponent).join('/');
      const written = await api(
        client,
        'PUT',
        `/skills/${encodeURIComponent(skill.name)}/files/${filePath}`,
        { content },
      );
      if (written.status !== 200 && written.status !== 201) {
        throw new InstallerError(
          `не удалось записать файл скилла «${skill.name}/${relPath}»: ${apiErrorText(written)}`,
        );
      }
    }
    results.push({ name: skill.name, action: 'updated' });
  }

  // Best-effort: ре-скан реестра скиллов (ленивая инвалидация по mtime).
  const reloaded = await api(client, 'POST', '/skills/reload');
  if (reloaded.status !== 200) {
    log(`${INSTALL_LOG_PREFIX} предупреждение: POST /skills/reload вернул ${apiErrorText(reloaded)}`);
  }
  return results;
}

/** Опции standalone-установки MCP (merge `mcp.servers` в config.yaml). */
export interface StandaloneMcpOptions {
  /** Путь к `config.yaml` инстанса. */
  configPath: string;
  /** Имя записи в `mcp.servers`. */
  name: string;
  /** URL MCP-эндпоинта (с подставленным тенантом). */
  url: string;
  description?: string;
  /** Заголовки подключения (Authorization при `--mcp-token`). */
  headers?: Record<string, string>;
  /** Сид `enabledByDefault` для новых проектов. */
  enabledByDefault?: boolean;
  dryRun?: boolean;
  log?: (message: string) => void;
}

/** Standalone: merge `mcp.servers` в config.yaml (идемпотентно, атомарно). */
export function installMcpStandalone(
  options: StandaloneMcpOptions,
): { action: 'created' | 'updated' | 'unchanged' | 'dry-run' } {
  const { configPath, name, url, description, headers, enabledByDefault } = options;
  const dryRun = options.dryRun === true;
  const log = options.log ?? (() => {});
  if (!existsSync(configPath)) {
    throw new InstallerError(`не найден config.yaml: ${configPath}`);
  }
  const original = readFileSync(configPath, 'utf8');
  const { content, action } = mergeMcpServerIntoConfig(original, name, {
    type: 'http',
    url,
    ...(description ? { description } : {}),
    enabled: true,
    enabledByDefault: enabledByDefault !== false,
    ...(headers && Object.keys(headers).length > 0 ? { headers } : {}),
  });
  if (dryRun) {
    log(`${INSTALL_LOG_PREFIX} (dry-run) config ${configPath}: mcp.servers.${name} → ${action}`);
    return { action: 'dry-run' };
  }
  if (action !== 'unchanged') atomicWrite(configPath, content);
  log(`${INSTALL_LOG_PREFIX} config ${configPath}: mcp.servers.${name} — ${action}`);
  return { action };
}

/** Standalone: копирование каталога скилла в `{dataDir}/skills/<name>/`. */
export function installSkillStandalone(
  skillDir: string,
  dataDir: string,
  name: string,
  dryRun: boolean,
  log: (message: string) => void,
): { action: 'created' | 'updated' | 'dry-run' } {
  const target = join(dataDir, 'skills', name);
  const existed = existsSync(target);
  if (dryRun) {
    log(`${INSTALL_LOG_PREFIX} (dry-run) скилл ${name}: ${skillDir} → ${target}`);
    return { action: 'dry-run' };
  }
  mkdirSync(dirname(target), { recursive: true });
  cpSync(skillDir, target, { recursive: true });
  log(`${INSTALL_LOG_PREFIX} скилл ${name}: ${target} — ${existed ? 'обновлён' : 'скопирован'}`);
  return { action: existed ? 'updated' : 'created' };
}

/** Best-effort ре-скан скиллов через API (когда инстанс доступен). */
async function tryReloadSkills(options: InstallerOptions): Promise<boolean> {
  const { synthUrl, token, fetchImpl } = options;
  if (!synthUrl || !token) return false;
  const log = options.log ?? (() => {});
  try {
    const client = { synthUrl, token, fetchImpl: fetchImpl ?? globalThis.fetch };
    const result = await api(client, 'POST', '/skills/reload');
    if (result.status === 200) {
      log(`${INSTALL_LOG_PREFIX} скиллы пересканированы (POST /skills/reload)`);
      return true;
    }
    log(`${INSTALL_LOG_PREFIX} предупреждение: POST /skills/reload вернул ${apiErrorText(result)}`);
  } catch (error) {
    log(`${INSTALL_LOG_PREFIX} предупреждение: не удалось пересканировать скиллы: ${describeUnknown(error)}`);
  }
  return false;
}

/**
 * Прогон инсталлятора: standalone (config/dataDir) и/или managed (synthUrl+token).
 * Идемпотентен: повторный запуск не создаёт дублей.
 */
export async function runInstaller(options: InstallerOptions): Promise<InstallerResult> {
  const rootDir = options.rootDir ?? DEFAULT_ROOT;
  const log = options.log ?? ((message: string) => console.log(message));
  const manifest = readAddonManifest(rootDir);
  const provides = manifest.provides ?? {};

  const wantMcp = (options.mcp ?? true) && provides.mcp !== undefined;
  const wantSkills = (options.skills ?? true) && (provides.skills?.length ?? 0) > 0;
  const standaloneConfig = options.configPath;
  const standaloneDataDir = options.dataDir;

  if ((options.mcp === true || options.skills === true) && !wantMcp && !wantSkills) {
    throw new InstallerError(
      'в synth.pack.provides нет выбранных сущностей (mcp/skills) — нечего устанавливать',
    );
  }

  const tenant = options.tenant?.trim() ?? '';
  const mcpProvides = provides.mcp;
  // База MCP-URL: явный --mcp-url > provides.mcp.url > хост сервиса (--service-host).
  const explicitBase = (options.mcpUrl ?? mcpProvides?.url ?? '').replace(/\/+$/, '');
  const serviceHostBase = options.serviceHost?.trim()
    ? `http://${options.serviceHost.trim()}${mcpProvides?.port ? `:${mcpProvides.port}` : ''}`
    : '';
  const mcpBaseUrl = explicitBase || serviceHostBase;
  const mcpUrl = mcpProvides && mcpBaseUrl
    ? `${mcpBaseUrl}${resolveMcpEndpointPath(mcpProvides.path, tenant || 'default')}`
    : undefined;

  const result: InstallerResult = { skills: [], reloaded: false };
  const dryRun = options.dryRun === true;
  const managed = Boolean(options.synthUrl || options.token);

  // Fail-fast до любых изменений: для выбранных сущностей нужен режим
  // (managed либо standalone), иначе можно было бы применить часть установки.
  if (!dryRun) {
    if (wantMcp && !standaloneConfig && !managed) {
      throw new InstallerError(
        'не задан режим установки: managed (--synth-url + --token) или standalone (--config/--data-dir)',
      );
    }
    if (wantSkills && !standaloneDataDir && !managed) {
      throw new InstallerError(
        'не задан режим установки скиллов: managed (--synth-url + --token) или standalone (--data-dir)',
      );
    }
  }
  if (dryRun) log(`${INSTALL_LOG_PREFIX} dry-run: реальные изменения не выполняются`);

  if (wantMcp && mcpProvides) {
    if (!mcpBaseUrl) {
      if (dryRun) {
        log(`${INSTALL_LOG_PREFIX} (dry-run) MCP: не задан --mcp-url — URL для регистрации неизвестен`);
        result.mcp = { action: 'planned' };
      } else {
        throw new InstallerError(
          'не задан --mcp-url (базовый URL MCP-эндпоинта шлюза, например http://synth-gateway:7101)',
        );
      }
    } else if (standaloneConfig) {
      const action = installMcpStandalone({
        configPath: standaloneConfig,
        name: mcpProvides.name,
        url: mcpUrl!,
        ...(mcpProvides.description !== undefined
          ? { description: mcpProvides.description }
          : {}),
        ...(options.mcpToken?.trim()
          ? { headers: { Authorization: `Bearer ${options.mcpToken.trim()}` } }
          : {}),
        enabledByDefault: options.enabledByDefault !== false,
        dryRun,
        log,
      });
      result.mcp = { action: action.action, url: mcpUrl };
    } else if (managed) {
      if (dryRun) {
        log(`${INSTALL_LOG_PREFIX} (dry-run) MCP ${mcpProvides.name} → ${mcpUrl} (POST /mcp/registry)`);
        result.mcp = { action: 'dry-run', url: mcpUrl };
      } else {
        result.mcp = await installMcpManaged(options, manifest, mcpUrl!);
        log(`${INSTALL_LOG_PREFIX} MCP ${mcpProvides.name} → ${mcpUrl}: ${result.mcp?.action}`);
      }
    } else if (dryRun) {
      log(`${INSTALL_LOG_PREFIX} (dry-run) MCP ${mcpProvides.name} → ${mcpUrl} (нужен --synth-url + --token)`);
      result.mcp = { action: 'planned', url: mcpUrl };
    } else {
      throw new InstallerError(
        'не задан режим установки: managed (--synth-url + --token) или standalone (--config/--data-dir)',
      );
    }
  }

  if (wantSkills) {
    for (const skill of provides.skills ?? []) {
      const skillDir = options.skillsDir
        ? join(options.skillsDir, skill.name)
        : join(rootDir, skill.path);
      const bundle = readSkillBundle(skillDir, skill.name);

      if (standaloneDataDir) {
        const action = installSkillStandalone(skillDir, standaloneDataDir, skill.name, dryRun, log);
        result.skills.push({ name: skill.name, action: action.action });
      } else if (managed) {
        if (dryRun) {
          log(`${INSTALL_LOG_PREFIX} (dry-run) скилл ${skill.name}: POST /skills`);
          result.skills.push({ name: skill.name, action: 'dry-run' });
        } else {
          const installed = await installSkillsManaged(options, [bundle]);
          result.skills.push(...installed);
          log(`${INSTALL_LOG_PREFIX} скилл ${skill.name}: ${installed[0]?.action ?? 'skipped'}`);
        }
      } else if (dryRun) {
        log(
          `${INSTALL_LOG_PREFIX} (dry-run) скилл ${skill.name}: POST /skills (нужен --synth-url + --token)`,
        );
        result.skills.push({ name: skill.name, action: 'planned' });
      } else {
        throw new InstallerError(
          'не задан режим установки скиллов: managed (--synth-url + --token) или standalone (--data-dir)',
        );
      }
    }
  }

  // Standalone: если API доступен — попросить ре-скан скиллов.
  if (!dryRun && standaloneDataDir && result.skills.length > 0) {
    result.reloaded = await tryReloadSkills(options);
  }

  return result;
}

/** Разобранные аргументы CLI. */
export interface ParsedInstallerArgs {
  options: InstallerOptions;
  help: boolean;
}

/** Разбирает аргументы CLI инсталлятора (`--flag value` и `--flag=value`). */
export function parseInstallerArgs(argv: string[], env: NodeJS.ProcessEnv = {}): ParsedInstallerArgs {
  const options: InstallerOptions = {};
  let help = false;
  let mcpFlag: boolean | undefined;
  let skillsFlag: boolean | undefined;
  let onlyValue: string | undefined;

  const envOr = (key: string): string | undefined => {
    const value = env[key];
    return value !== undefined && value.trim() ? value.trim() : undefined;
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] ?? '';
    const [flag, inline] = arg.includes('=') ? arg.split('=', 2) : [arg, undefined];
    const next = (): string | undefined => inline ?? argv[(i += 1)];

    switch (flag) {
      case '--help':
      case '-h':
        help = true;
        break;
      case '--synth-url': {
        const value = next();
        if (value) options.synthUrl = value;
        break;
      }
      case '--token': {
        const value = next();
        if (value) options.token = value;
        break;
      }
      case '--tenant': {
        const value = next();
        if (value) options.tenant = value;
        break;
      }
      case '--mcp-url': {
        const value = next();
        if (value) options.mcpUrl = value;
        break;
      }
      case '--service-host': {
        const value = next();
        if (value) options.serviceHost = value;
        break;
      }
      case '--skills-dir': {
        const value = next();
        if (value) options.skillsDir = value;
        break;
      }
      case '--mcp-token': {
        const value = next();
        if (value) options.mcpToken = value;
        break;
      }
      case '--no-enabled-by-default':
        options.enabledByDefault = false;
        break;
      case '--only': {
        const value = next();
        if (value) onlyValue = value;
        break;
      }
      case '--mcp':
        mcpFlag = true;
        break;
      case '--skills':
        skillsFlag = true;
        break;
      case '--dry-run':
        options.dryRun = true;
        break;
      case '--config': {
        const value = next();
        if (value) options.configPath = value;
        break;
      }
      case '--data-dir': {
        const value = next();
        if (value) options.dataDir = value;
        break;
      }
      case '--root': {
        const value = next();
        if (value) options.rootDir = value;
        break;
      }
      default:
        break;
    }
  }

  options.synthUrl ??= envOr('SYNTH_URL');
  options.token ??= envOr('SYNTH_INSTALL_TOKEN');
  options.mcpUrl ??= envOr('SYNTH_ADDON_MCP_URL');
  options.serviceHost ??= envOr('SYNTH_ADDON_SERVICE_HOST');
  options.tenant ??= envOr('SYNTH_ADDON_TENANT');
  if (options.configPath === undefined) options.configPath = envOr('SYNTH_CONFIG');
  if (options.dataDir === undefined) options.dataDir = envOr('SYNTH_DATA_DIR');
  if (options.skillsDir === undefined) options.skillsDir = envOr('SYNTH_ADDON_SKILLS_DIR');
  options.mcpToken ??= envOr('SYNTH_MCP_TOKEN');

  // Фильтр сущностей: `--only mcp,skills` (общий контракт с чартом) либо
  // флаги `--mcp`/`--skills`. Без них — всё из `provides`.
  if (onlyValue !== undefined) {
    const selected = onlyValue
      .split(',')
      .map((item) => item.trim().toLowerCase())
      .filter(Boolean);
    for (const item of selected) {
      if (item !== 'mcp' && item !== 'skills') {
        throw new InstallerError(`--only: неизвестное значение «${item}» (ожидается mcp,skills)`);
      }
    }
    options.mcp = selected.includes('mcp');
    options.skills = selected.includes('skills');
  } else if (mcpFlag !== undefined || skillsFlag !== undefined) {
    options.mcp = mcpFlag === true;
    options.skills = skillsFlag === true;
  }

  return { options, help };
}

/** Справка CLI. */
export function installerHelp(): string {
  return [
    'synth-gateway-core: установка MCP-сервера и скиллов шлюза в инстанс Synth',
    '',
    'Использование:',
    '  node scripts/install-into-synth.mjs --synth-url URL --token TOKEN --tenant ID \\',
    '       --mcp-url http://synth-gateway:7101 [--mcp] [--skills] [--dry-run]',
    '  node scripts/install-into-synth.mjs --config /path/config.yaml --data-dir /var/synth/data \\',
    '       [--tenant ID] [--mcp-url URL] [--dry-run]',
    '',
    'Аргументы:',
    '  --synth-url URL  базовый URL API v2 инстанса Synth (env SYNTH_URL)',
    '  --token TOKEN    машинный ключ (service-key, scope addons:install; env SYNTH_INSTALL_TOKEN)',
    '  --tenant ID      тенант: подставляется в provides.mcp.path вместо {tenant} (env SYNTH_ADDON_TENANT)',
    '  --mcp-url URL    базовый URL MCP-эндпоинта шлюза (env SYNTH_ADDON_MCP_URL)',
    '  --service-host H хост сервиса шлюза: MCP-URL собирается как http://H:<provides.mcp.port>',
    '                   (общий контракт с чартом; env SYNTH_ADDON_SERVICE_HOST)',
    '  --only LIST      что устанавливать: mcp,skills (по умолчанию — всё из provides)',
    '  --mcp / --skills синонимы-фильтры для --only',
    '  --skills-dir DIR корень дерева скиллов (шлюз без образа; env SYNTH_ADDON_SKILLS_DIR)',
    '  --mcp-token TOK  bearer-токен MCP-клиентов шлюза → config.headers.Authorization',
    '                   записи реестра (env SYNTH_MCP_TOKEN; в логи не попадает)',
    '  --no-enabled-by-default  не включать MCP-сервер по умолчанию для новых',
    '                   проектов (по умолчанию enabledByDefault: true)',
    '  --dry-run        показать план, ничего не менять',
    '  --config PATH    standalone: merge mcp.servers в config.yaml (env SYNTH_CONFIG)',
    '  --data-dir DIR   standalone: копировать скиллы в {dataDir}/skills (env SYNTH_DATA_DIR)',
    '  --root DIR       корень репозитория шлюза с synth.pack',
    '  --help, -h       эта справка',
    '',
    'Идемпотентно: повторный запуск не создаёт дублей (обновление вместо создания).',
  ].join('\n');
}

/**
 * Точка входа инсталлятора: разбор аргументов → прогон → код возврата.
 * Ошибки печатаются понятным сообщением (без секретов), код ≠ 0.
 */
export async function main(
  argv: string[],
  env: NodeJS.ProcessEnv = process.env,
  deps: { fetchImpl?: typeof fetch; log?: (message: string) => void } = {},
): Promise<number> {
  const log = deps.log ?? ((message: string) => console.log(message));
  const { options, help } = parseInstallerArgs(argv, env);
  if (help) {
    log(installerHelp());
    return 0;
  }
  if (deps.fetchImpl) options.fetchImpl = deps.fetchImpl;
  options.log = log;

  try {
    const result = await runInstaller(options);
    const summary: string[] = [];
    if (result.mcp) summary.push(`MCP: ${result.mcp.action}${result.mcp.url ? ` (${result.mcp.url})` : ''}`);
    for (const skill of result.skills) summary.push(`скилл ${skill.name}: ${skill.action}`);
    log(`${INSTALL_LOG_PREFIX} готово${summary.length ? `: ${summary.join('; ')}` : ''}`);
    return 0;
  } catch (error) {
    if (error instanceof InstallerError) {
      log(`${INSTALL_LOG_PREFIX} ошибка: ${error.message}`);
      return 1;
    }
    log(`${INSTALL_LOG_PREFIX} ошибка: ${describeUnknown(error)}`);
    return 1;
  }
}

/** Проверка существования каталога (для быстрых пре-проверок). */
export function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}
