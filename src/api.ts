import type { BearerProvider } from './auth.js';
import type { GatewayHealth } from './health.js';

/**
 * Клиент API v2 Synth для ядра шлюза (ADR-103, §4.1/§4.3 контракта пакета).
 *
 * Порт `src/gateway/ingest.ts` эталонного Telegram-шлюза: класс
 * `SynthEventsClient` переименован в `SynthApi` и расширен (пользователи,
 * сессии). Поведение сохранено 1:1 — retry с экспоненциальным backoff на
 * 5xx/сетевых ошибках, 4xx — окончательная ошибка без повторов, один
 * auto-refresh bearer после `401` **без** траты retry-бюджета, health
 * `setSynth('up'|'down')`.
 */

/** ADR-089: нормализованное событие, как его вернул приём (`POST /events`). */
export interface SynthEvent {
  id: string;
  source: string;
  type: string;
  payload: unknown;
  identity: unknown;
  dedupKey: string;
  ts: string;
}

/** ADR-089: решение Router (дискриминант `kind` + диагностическая мета). */
export interface RouteDecision {
  kind: string;
  [key: string]: unknown;
}

/**
 * ADR-089: одноразовый код подтверждения владения внешней идентичностью
 * (claim-flow). Заполняется ядром, только если отправитель не сопознан с
 * учётной записью Synth (`identityHint` в ответе `POST /events`).
 */
export interface IdentityHint {
  code: string;
  expiresAt: string;
}

/** Ответ `POST /events`: событие, решение Router и id сессии (если создана). */
export interface IngestResult {
  event: SynthEvent;
  decision: RouteDecision;
  sessionId: string | null;
  /** Код линковки (ADR-089, claim-flow). */
  identityHint?: IdentityHint;
}

/**
 * ADR-089: идентичность отправителя внешнего события.
 *
 * Роль (`roles`) **только сужает** права профиля Synth (ADR-089) — ядро
 * пересекает её с ролью allowlist-источника.
 */
export interface EventIdentity {
  /** Полный `principalId` (`<provider>:<externalId>`). */
  principalId?: string;
  /** Ключ «чата»/переписки — ключ Binding. */
  chatKey?: string;
  /** Ключ треда — ключ Binding (приоритетнее `chatKey`). */
  threadKey?: string;
  /** Роли отправителя (allowlist источника). */
  roles?: string[];
}

/**
 * Тело внешнего события для `POST /events` (`eventIngestSchema`, ADR-089).
 *
 * Набор полей — ровно по контракту API v2: `{source, type, payload?, identity?,
 * dedupKey?, ts?}`. `id`/`ts` назначает ядро Synth при приёме.
 */
export interface EventInput {
  /** Источник события (`source` в `POST /api/v2/events`). */
  source: string;
  /** Тип события (`message`, `command`, …). */
  type: string;
  /** Полезная нагрузка (текст + метаданные канала). */
  payload?: unknown;
  /** Идентичность отправителя. */
  identity?: EventIdentity;
  /** Стабильный ключ дедупликации. */
  dedupKey?: string;
  /** Отметка времени отправки (ISO). */
  ts?: string;
}

/** ADR-089: привязка внешнего адреса к сессии/шаблону. */
export interface EventBinding {
  id: string;
  source: string;
  chatKey?: string;
  threadKey?: string;
  sessionId?: string;
  mode: string;
  agentTemplate?: string;
  project?: string;
}

/** Вход upsert привязки (`POST /events/bindings`). */
export interface EventBindingInput {
  source: string;
  chatKey?: string;
  threadKey?: string;
  sessionId?: string;
  mode: string;
  agentTemplate?: string;
  project?: string;
}

/** Срез сессии Synth (ответ `POST /sessions`, `GET /sessions/:id`). */
export interface Session {
  id: string;
  name?: string | null;
  project_id?: string | null;
  mode?: string;
  [key: string]: unknown;
}

/**
 * Внешняя идентичность профиля Synth (`ProfileData.identities[]`, ADR-089).
 *
 * API v2 отдаёт идентичности в snake_case (`external_id`), канал может
 * работать и с camelCase-вариантом.
 */
export interface SynthUserIdentity {
  provider?: string;
  externalId?: string;
  external_id?: string;
  username?: string;
  displayName?: string;
  display_name?: string;
  [key: string]: unknown;
}

/**
 * Профиль пользователя Synth (ответ `GET /users`, `GET /users/:id`).
 *
 * Нужен каналу для резолва «пользователь Synth → адресат в канале»
 * (например, `user` → id чата мессенджера).
 */
export interface SynthUser {
  id?: string;
  username?: string;
  displayName?: string;
  display_name?: string;
  email?: string;
  roles?: string[];
  identities?: SynthUserIdentity[];
  [key: string]: unknown;
}

/** Вход создания сессии (`POST /sessions`; схема `sessionCreateSchema`). */
export interface CreateSessionInput {
  name?: string;
  title?: string;
  projectId?: string;
  settings?: Record<string, unknown>;
}

/** Ошибка вызова API v2 с кодом/статусом ответа. */
export class SynthEventsError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'SynthEventsError';
  }
}

/** Опции {@link SynthApi}. */
export interface SynthApiOptions {
  /** Базовый URL API v2 (например, `http://127.0.0.1:5000/api/v2`). */
  baseUrl: string;
  /** Служебный Bearer-ключ (standalone/dev; без `bearer`). */
  apiKey?: string;
  /** Провайдер Bearer-токена (OIDC/стат. ключ); при задании приоритетнее `apiKey`. */
  bearer?: BearerProvider;
  /** Реализация fetch (для тестов). По умолчанию `globalThis.fetch`. */
  fetchImpl?: typeof fetch;
  /** Число повторных попыток при сетевой ошибке/5xx (по умолчанию 3). */
  maxRetries?: number;
  /** Базовая задержка backoff, мс (по умолчанию 500; удваивается с каждой попыткой). */
  retryBaseDelayMs?: number;
  /** Логгер (по умолчанию — тихий). */
  log?: (message: string) => void;
  /** Best-effort состояние доступности API v2 для health. */
  health?: GatewayHealth;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Тело `POST /events` — ровно по контракту API v2 (`eventIngestSchema`):
 * `{source, type, payload?, identity?, dedupKey?, ts?}`; `identity` — `{principalId?,
 * chatKey?, threadKey?, roles?}`. Лишние поля во входе **не** уходят в API.
 */
function eventBody(input: EventInput): Record<string, unknown> {
  const body: Record<string, unknown> = { source: input.source, type: input.type };
  if (input.payload !== undefined) body.payload = input.payload;
  if (input.identity) {
    const identity: Record<string, unknown> = {};
    if (input.identity.principalId !== undefined) identity.principalId = input.identity.principalId;
    if (input.identity.chatKey !== undefined) identity.chatKey = input.identity.chatKey;
    if (input.identity.threadKey !== undefined) identity.threadKey = input.identity.threadKey;
    if (input.identity.roles !== undefined) identity.roles = input.identity.roles;
    body.identity = identity;
  }
  if (input.dedupKey !== undefined) body.dedupKey = input.dedupKey;
  if (input.ts !== undefined) body.ts = input.ts;
  return body;
}

/** Нормализует ответ `GET /users` (`{users}` или массив). */
function toUserList(data: unknown): SynthUser[] {
  if (Array.isArray(data)) return data.filter(isRecord) as SynthUser[];
  if (isRecord(data) && Array.isArray(data.users)) {
    return data.users.filter(isRecord) as SynthUser[];
  }
  return [];
}

/** Нормализует ответ `GET /users/:id` (сам объект или `{user}`). */
function toUser(data: unknown): SynthUser | undefined {
  if (!isRecord(data)) return undefined;
  if (isRecord(data.user)) return data.user as SynthUser;
  return data as SynthUser;
}

/**
 * HTTP-клиент платформы внешних событий Synth (ADR-089) и сессий (API v2).
 *
 * Публикует нормализованные события (`POST /events`), управляет привязками
 * (`/events/bindings*`), сессиями (`/sessions*`) и читает пользователей
 * (`/users*`). Сетевые ошибки и ответы 5xx повторяются с экспоненциальным
 * backoff; 4xx — окончательная ошибка без повторов.
 */
export class SynthApi {
  private readonly baseUrl: string;
  private readonly apiKey?: string;
  private readonly bearer?: BearerProvider;
  private readonly fetchImpl: typeof fetch;
  private readonly maxRetries: number;
  private readonly retryBaseDelayMs: number;
  private readonly log: (message: string) => void;
  private readonly health?: GatewayHealth;

  constructor(options: SynthApiOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.apiKey = options.apiKey?.trim() ? options.apiKey.trim() : undefined;
    this.bearer = options.bearer;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.maxRetries = options.maxRetries ?? 3;
    this.retryBaseDelayMs = options.retryBaseDelayMs ?? 500;
    this.log = options.log ?? (() => {});
    this.health = options.health;
  }

  /** Публикует внешнее событие; логирует решение Router. */
  async postEvent(input: EventInput): Promise<IngestResult> {
    const result = await this.request<IngestResult>('POST', '/events', eventBody(input));
    const suffix = result.sessionId ? ` (сессия ${result.sessionId})` : '';
    this.log(`[gateway] событие ${result.event.id} → решение «${result.decision.kind}»${suffix}`);
    return result;
  }

  /**
   * Список привязок событий (опционально с фильтром по `source`).
   *
   * Фильтр — **на стороне клиента**: в API v2 у `GET /events/bindings` фильтра
   * по источнику нет.
   */
  async listBindings(source?: string): Promise<EventBinding[]> {
    const data = await this.request<{ bindings?: EventBinding[] }>('GET', '/events/bindings');
    const bindings = data.bindings ?? [];
    return source ? bindings.filter((binding) => binding.source === source) : bindings;
  }

  /** Upsert привязки событий. */
  async createBinding(input: EventBindingInput): Promise<EventBinding> {
    return this.request<EventBinding>('POST', '/events/bindings', input);
  }

  /** Удаляет привязку событий. */
  async deleteBinding(id: string): Promise<void> {
    await this.request<unknown>('DELETE', `/events/bindings/${encodeURIComponent(id)}`);
  }

  /** Создаёт сессию (`POST /sessions`; единый funnel ядра). */
  async createSession(input: CreateSessionInput): Promise<Session> {
    return this.request<Session>('POST', '/sessions', input);
  }

  /** Читает сессию; `null` — сессия не найдена (404). */
  async getSession(id: string): Promise<Session | null> {
    try {
      return await this.request<Session>('GET', `/sessions/${encodeURIComponent(id)}`);
    } catch (error) {
      if (error instanceof SynthEventsError && error.status === 404) return null;
      throw error;
    }
  }

  /** Прерывает активный ответ агента в сессии (`POST /sessions/:id/abort`). */
  async abortSession(id: string): Promise<void> {
    await this.request<unknown>('POST', `/sessions/${encodeURIComponent(id)}/abort`);
  }

  /**
   * Список пользователей Synth (`GET /users`).
   *
   * Нужен каналу для резолва «пользователь Synth → адресат в канале».
   * Ответ API v2 — `{users}`; приходит список профилей **без** идентичностей
   * (идентичности — в `GET /users/:id`, см. {@link SynthApi.getUser}).
   */
  async listUsers(): Promise<SynthUser[]> {
    const data = await this.request<unknown>('GET', '/users');
    return toUserList(data);
  }

  /**
   * Профиль пользователя Synth (`GET /users/:id`) — вместе с идентичностями
   * (`identities[]`), по которым резолвится адресат в канале.
   *
   * `null` — профиль не найден (404).
   */
  async getUser(id: string): Promise<SynthUser | null> {
    try {
      const data = await this.request<unknown>('GET', `/users/${encodeURIComponent(id)}`);
      return toUser(data) ?? null;
    } catch (error) {
      if (error instanceof SynthEventsError && error.status === 404) return null;
      throw error;
    }
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    let lastError: unknown;
    // Один раз после `401` принудительно обновляем токен и повторяем без
    // траты бюджета retry (защита от зацикливания — флаг).
    let authRefreshed = false;

    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      if (attempt > 0) {
        await sleep(this.retryBaseDelayMs * 2 ** (attempt - 1));
      }

      const headers: Record<string, string> = { accept: 'application/json' };
      const token = this.bearer ? await this.bearer.getBearer() : this.apiKey;
      if (token) headers.authorization = `Bearer ${token}`;
      if (body !== undefined) headers['content-type'] = 'application/json';

      let response: Response;
      try {
        response = await this.fetchImpl(url, {
          method,
          headers,
          body: body !== undefined ? JSON.stringify(body) : undefined,
        });
      } catch (error) {
        lastError = error;
        continue;
      }

      const text = await response.text();
      let data: unknown;
      try {
        data = text ? JSON.parse(text) : undefined;
      } catch {
        data = text;
      }

      if (response.ok) {
        this.health?.setSynth('up');
        return data as T;
      }

      if (response.status === 401 && this.bearer && !authRefreshed) {
        authRefreshed = true;
        try {
          await this.bearer.refreshBearer();
        } catch {
          /* ошибку получения токена отразит health; повтор покажет итог */
        }
        attempt -= 1; // повтор после refresh — не расходует retry-бюджет
        continue;
      }

      const error = (data as { error?: { code?: string; message?: string } } | undefined)?.error;
      const apiError = new SynthEventsError(
        response.status,
        error?.code ?? `http_${response.status}`,
        error?.message ?? response.statusText,
      );

      // 5xx — временная ошибка сервера, повторяем; 4xx — окончательная.
      if (response.status >= 500) {
        lastError = apiError;
        continue;
      }
      this.health?.setSynth('up');
      throw apiError;
    }

    this.health?.setSynth('down');
    if (lastError instanceof SynthEventsError) throw lastError;
    throw new SynthEventsError(
      0,
      'network_error',
      lastError instanceof Error ? lastError.message : String(lastError),
    );
  }
}
