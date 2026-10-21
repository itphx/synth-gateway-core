import type { OidcAuthConfig } from './config.js';
import type { AuthMode, GatewayHealth, TokenStatus } from './health.js';

/**
 * Режим аутентификации вызовов Synth API.
 *
 * Каноническое определение — в `health.ts` (там же режим попадает в снимок
 * `GET /health`); здесь — реэкспорт, чтобы модуль аутентификации был
 * самодостаточным для потребителя (значения совпадают побайтово, дубль
 * определения разошёлся бы с health-снимком).
 */
export type { AuthMode };

/**
 * Минимальный провайдер Bearer-токена для вызовов Synth API.
 *
 * Используется HTTP-клиентами (`SynthApi`, watcher ответов агента): даёт
 * текущий токен и умеет принудительно обновить его после `401`.
 */
export interface BearerProvider {
  /** Текущий токен (для OIDC — обновляется заранее, до истечения). */
  getBearer(): Promise<string | undefined>;
  /** Принудительно обновить токен (после `401`); для статического ключа — тот же ключ. */
  refreshBearer(): Promise<string | undefined>;
}

/** Опции {@link AuthTokenProvider}. */
export interface AuthTokenProviderOptions {
  /**
   * Scoped service-key `synth_svc_…` (ADR-052) — приоритетная машинная
   * аутентификация; задан явно — он главный. Статический Bearer (как `apiKey`).
   */
  serviceKey?: string;
  /** Статический служебный ключ (`SYNTH_API_KEY`) — legacy-fallback. */
  apiKey?: string;
  /** Конфигурация OIDC client-credentials. */
  oidc?: OidcAuthConfig;
  /** Обновлять токен за столько секунд до истечения (по умолчанию 30). */
  refreshMarginSec?: number;
  /** Таймаут запросов к token/discovery-эндпоинту, мс (по умолчанию 10000). */
  timeoutMs?: number;
  /** Реализация fetch (для тестов). По умолчанию `globalThis.fetch`. */
  fetchImpl?: typeof fetch;
  /** Инъекция текущего времени (мс) для тестов. */
  now?: () => number;
  /** Best-effort состояние токена для `GET /health`. */
  health?: GatewayHealth;
  /** Логгер (по умолчанию — тихий). */
  log?: (message: string) => void;
}

/** Обновлять токен заранее за столько секунд до `expires_in`. */
export const DEFAULT_REFRESH_MARGIN_SEC = 30;

/** Таймаут запросов к OIDC token/discovery-эндпоинту, мс. */
export const DEFAULT_OIDC_TIMEOUT_MS = 10_000;

/** Фоллбек времени жизни токена, сек, если провайдер не вернул `expires_in`. */
const FALLBACK_EXPIRES_IN_SEC = 300;

/** Настроен ли OIDC: нужны client_id/secret и хотя бы token- или discovery-URL. */
export function isOidcConfigured(oidc?: OidcAuthConfig): boolean {
  if (!oidc) return false;
  const hasEndpoint = Boolean(oidc.tokenUrl || oidc.discoveryUrl);
  return hasEndpoint && Boolean(oidc.clientId) && Boolean(oidc.clientSecret);
}

/** Задано ли хотя бы одно OIDC-поле при неполной настройке (для предупреждения). */
export function isOidcPartial(oidc?: OidcAuthConfig): boolean {
  if (!oidc) return false;
  const any = Boolean(
    oidc.tokenUrl || oidc.discoveryUrl || oidc.clientId || oidc.clientSecret || oidc.scope,
  );
  return any && !isOidcConfigured(oidc);
}

/**
 * Провайдер токена аутентификации Synth API (ADR-052/ADR-089).
 *
 * Приоритет: **scoped service-key** (`synth_svc_…`, ADR-052; задан явно — главный)
 * → **OIDC client-credentials** (managed) → статический API-ключ (`SYNTH_API_KEY`,
 * legacy-fallback) → без аутентификации. `service-key`/`api-key` — статические
 * Bearer; OIDC-токен кэшируется в памяти и
 * обновляется заранее (за {@link DEFAULT_REFRESH_MARGIN_SEC} секунд до
 * `expires_in`); конкурентные вызовы объединяются в один refresh (single-flight).
 *
 * OIDC-запросы идут **напрямую** обычным `fetch` — прокси/настройки egress- слоя
 * канала к ним не применяются (токен-эндпоинт IdP — внешний по отношению к
 * каналу адрес).
 *
 * Ошибки оборачиваются в понятный код `gateway.oidc_token_failed`; секреты в
 * сообщения и логи не попадают, тело ответа OIDC-сервера **не логируется**.
 */
export class AuthTokenProvider implements BearerProvider {
  /** Режим аутентификации: `service-key` | `oidc` | `api-key` | `none`. */
  readonly mode: AuthMode;

  private readonly serviceKey?: string;
  private readonly apiKey?: string;
  private readonly oidc: OidcAuthConfig;
  private readonly refreshMarginMs: number;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly health?: GatewayHealth;
  private readonly log: (message: string) => void;

  private token?: string;
  private expiresAt = 0;
  private resolvedTokenUrl?: string;
  private inflight?: Promise<string>;
  private status: TokenStatus = 'error';

  constructor(options: AuthTokenProviderOptions) {
    this.serviceKey = options.serviceKey?.trim() ? options.serviceKey.trim() : undefined;
    this.apiKey = options.apiKey?.trim() ? options.apiKey.trim() : undefined;
    this.oidc = options.oidc ?? {};
    this.refreshMarginMs = (options.refreshMarginSec ?? DEFAULT_REFRESH_MARGIN_SEC) * 1000;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_OIDC_TIMEOUT_MS;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.now = options.now ?? (() => Date.now());
    this.health = options.health;
    this.log = options.log ?? (() => {});
    // Приоритет (ADR-052, этап IV): service-key → OIDC → api-key → none.
    this.mode = this.serviceKey
      ? 'service-key'
      : isOidcConfigured(this.oidc)
        ? 'oidc'
        : this.apiKey
          ? 'api-key'
          : 'none';
    if (this.mode === 'service-key' || this.mode === 'api-key') this._setStatus('ok');
  }

  /** Текущий best-effort статус токена (для health/тестов). */
  get tokenStatus(): TokenStatus {
    return this.status;
  }

  /** Текущий токен; OIDC обновляется по необходимости. */
  async getBearer(): Promise<string | undefined> {
    return this._token(false);
  }

  /** Принудительное обновление токена (после `401`) — один refresh на конкурентов. */
  async refreshBearer(): Promise<string | undefined> {
    return this._token(true);
  }

  /** Best-effort проверка доступности токена; не бросает, обновляет health. */
  async check(): Promise<TokenStatus> {
    try {
      const token = await this.getBearer();
      this._setStatus(token ? 'ok' : 'error');
    } catch {
      this._setStatus('error');
    }
    return this.status;
  }

  private async _token(force: boolean): Promise<string | undefined> {
    if (this.mode === 'service-key') return this.serviceKey;
    if (this.mode === 'api-key') return this.apiKey;
    if (this.mode !== 'oidc') return undefined;

    if (force) this.token = undefined;
    if (this.token && this.now() < this.expiresAt - this.refreshMarginMs) {
      return this.token;
    }
    return this._fetchToken();
  }

  /** Single-flight refresh: конкурентные вызовы ждут один и тот же запрос. */
  private async _fetchToken(): Promise<string> {
    if (this.inflight) return this.inflight;
    this.inflight = this._doFetchToken().finally(() => {
      this.inflight = undefined;
    });
    return this.inflight;
  }

  private async _doFetchToken(): Promise<string> {
    try {
      const url = await this._resolveTokenUrl();
      const body = new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: this.oidc.clientId ?? '',
        client_secret: this.oidc.clientSecret ?? '',
      });
      if (this.oidc.scope) body.set('scope', this.oidc.scope);

      const response = await this.fetchImpl(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          accept: 'application/json',
        },
        body: body.toString(),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (!response.ok) {
        // Тело ошибки не логируем, чтобы не задеть возможные чувствительные поля.
        throw new Error(`HTTP ${response.status}`);
      }

      const data = (await response.json()) as { access_token?: unknown; expires_in?: unknown };
      const accessToken = typeof data.access_token === 'string' ? data.access_token : undefined;
      if (!accessToken) throw new Error('ответ без access_token');

      const expiresIn =
        typeof data.expires_in === 'number' && data.expires_in > 0
          ? data.expires_in
          : FALLBACK_EXPIRES_IN_SEC;
      this.token = accessToken;
      this.expiresAt = this.now() + expiresIn * 1000;
      this._setStatus('ok');
      this.log(`[gateway] OIDC-токен получен (expires_in ${expiresIn} с)`);
      return accessToken;
    } catch (error) {
      this._setStatus('error');
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`gateway.oidc_token_failed: ${reason}`);
    }
  }

  /** Резолвит token-эндпоинт: явный URL либо `token_endpoint` из discovery (с кэшем). */
  private async _resolveTokenUrl(): Promise<string> {
    if (this.oidc.tokenUrl) return this.oidc.tokenUrl;
    if (this.resolvedTokenUrl) return this.resolvedTokenUrl;
    if (!this.oidc.discoveryUrl) throw new Error('не задан token/discovery URL');

    const response = await this.fetchImpl(this.oidc.discoveryUrl, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!response.ok) throw new Error(`discovery HTTP ${response.status}`);
    const doc = (await response.json()) as { token_endpoint?: unknown };
    const tokenUrl = typeof doc.token_endpoint === 'string' ? doc.token_endpoint : undefined;
    if (!tokenUrl) throw new Error('discovery без token_endpoint');
    this.resolvedTokenUrl = tokenUrl;
    return tokenUrl;
  }

  private _setStatus(status: TokenStatus): void {
    this.status = status;
    this.health?.setToken(status);
  }
}
