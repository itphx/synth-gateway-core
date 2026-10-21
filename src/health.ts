/**
 * Health-состояние шлюза и его зависимостей (ADR-103).
 *
 * Порт `health.ts`/`health-probe.ts` эталонного Telegram-шлюза: `setBot`
 * переименован в `setChannel` (ядро не знает про конкретный транспорт), поле
 * снимка `bot` → `channel`.
 *
 * Health — best-effort: ошибки проб не влияют на основной цикл приёма/доставки.
 */

/** Состояние доступности зависимости: `up`/`down`. */
export type HealthStatus = 'up' | 'down';

/**
 * Состояние канала: `ok` — канал работает, `dry-run` — канал подключён, но
 * работает без внешних кредов (нет токена/подписки), `unknown` — состояние
 * неизвестно.
 */
export type ChannelStatus = 'ok' | 'dry-run' | 'unknown';

/** Режим аутентификации вызовов Synth API (ADR-052/ADR-089, managed/standalone). */
export type AuthMode = 'service-key' | 'oidc' | 'api-key' | 'none';

/** Доступность Bearer-токена: `ok` — получен, `error` — нет токена/ошибка получения. */
export type TokenStatus = 'ok' | 'error';

/** Агрегатный статус процесса/тенанта: `ok` — всё доступно, `degraded`/`down`. */
export type OverallStatus = 'ok' | 'degraded' | 'down';

/** Снимок состояния шлюза для health-эндпоинта. */
export interface HealthSnapshot {
  synth: HealthStatus;
  /** Состояние канала (в эталоне — `bot`). */
  channel: ChannelStatus;
  watcher: HealthStatus;
  /** Режим аутентификации Synth API: `service-key` (ADR-052) / `oidc` / `api-key` / `none`. */
  auth: AuthMode;
  /** Доступность токена аутентификации (best-effort, не влияет на основной цикл). */
  token: TokenStatus;
}

/** Агрегированный снимок процесса (плоские поля `GET /health`). */
export interface AggregatedHealth extends HealthSnapshot {
  status: OverallStatus;
}

/**
 * Best-effort runtime-состояние шлюза (ADR-089). Обновляется клиентами по мере
 * работы; используется только в `GET /health`, ошибки не влияют на основной цикл.
 *
 * В мультитенантном режиме создаётся отдельный экземпляр на тенант (см.
 * {@link GatewayHealthRegistry}).
 */
export class GatewayHealth {
  private synth: HealthStatus = 'down';
  private channel: ChannelStatus = 'unknown';
  private watcher: HealthStatus = 'down';
  private auth: AuthMode = 'none';
  private token: TokenStatus = 'error';

  /** Доступность Synth API. */
  setSynth(status: HealthStatus): void {
    this.synth = status;
  }

  /** Состояние канала (в эталоне — `setBot`). */
  setChannel(status: ChannelStatus): void {
    this.channel = status;
  }

  /** Состояние watcher'а ответов агента. */
  setWatcher(status: HealthStatus): void {
    this.watcher = status;
  }

  /** Режим аутентификации Synth API. */
  setAuth(mode: AuthMode): void {
    this.auth = mode;
  }

  /** Доступность токена аутентификации. */
  setToken(status: TokenStatus): void {
    this.token = status;
  }

  /** Текущий снимок состояния. */
  snapshot(): HealthSnapshot {
    return {
      synth: this.synth,
      channel: this.channel,
      watcher: this.watcher,
      auth: this.auth,
      token: this.token,
    };
  }
}

/** Статус одного тенанта по его снимку (для агрегата процесса). */
export function tenantHealthStatus(snapshot: HealthSnapshot): OverallStatus {
  if (snapshot.synth === 'down') return 'down';
  if (snapshot.channel === 'unknown' || snapshot.watcher === 'down' || snapshot.token === 'error') {
    return 'degraded';
  }
  return 'ok';
}

/** Агрегирует `channel` из набора тенантов: `unknown` важнее `dry-run`, `ok` — при смеси. */
function aggregateChannel(channels: ChannelStatus[]): ChannelStatus {
  if (channels.some((channel) => channel === 'unknown')) return 'unknown';
  if (channels.every((channel) => channel === 'ok')) return 'ok';
  if (channels.every((channel) => channel === 'dry-run')) return 'dry-run';
  return 'ok';
}

/**
 * Сводный снимок по тенантам (плоские поля `GET /health`).
 *
 * - `synth`/`watcher`/`token` — `up`/`ok`, только если так у **всех** тенантов;
 * - `channel` — `unknown`, если хоть у одного `unknown`; `ok` при смеси `ok`/`dry-run`;
 * - `auth` — режим, если он общий для всех; иначе `none` (смешанный);
 * - `status` — `down`, если хоть один тенант `down`; `degraded`, если хоть один
 *   `degraded`; иначе `ok`.
 */
export function aggregateHealth(snapshots: HealthSnapshot[]): AggregatedHealth {
  if (snapshots.length === 0) {
    return {
      synth: 'down',
      channel: 'unknown',
      watcher: 'down',
      auth: 'none',
      token: 'error',
      status: 'down',
    };
  }
  const synth: HealthStatus = snapshots.every((s) => s.synth === 'up') ? 'up' : 'down';
  const watcher: HealthStatus = snapshots.every((s) => s.watcher === 'up') ? 'up' : 'down';
  const token: TokenStatus = snapshots.every((s) => s.token === 'ok') ? 'ok' : 'error';
  const firstAuth = snapshots[0]?.auth ?? 'none';
  const auth: AuthMode = snapshots.every((s) => s.auth === firstAuth) ? firstAuth : 'none';
  const statuses = snapshots.map(tenantHealthStatus);
  const status: OverallStatus = statuses.includes('down')
    ? 'down'
    : statuses.includes('degraded')
      ? 'degraded'
      : 'ok';
  return {
    synth,
    channel: aggregateChannel(snapshots.map((s) => s.channel)),
    watcher,
    auth,
    token,
    status,
  };
}

/**
 * Реестр health-контекстов тенантов: per-tenant состояние + агрегат для
 * `GET /health`. Один экземпляр на процесс.
 */
export class GatewayHealthRegistry {
  private readonly entries = new Map<string, GatewayHealth>();

  /** Регистрирует (или возвращает уже зарегистрированный) контекст тенанта. */
  register(id: string): GatewayHealth {
    const existing = this.entries.get(id);
    if (existing) return existing;
    const health = new GatewayHealth();
    this.entries.set(id, health);
    return health;
  }

  /** Контекст тенанта, если зарегистрирован. */
  get(id: string): GatewayHealth | undefined {
    return this.entries.get(id);
  }

  /** id зарегистрированных тенантов (в порядке регистрации). */
  ids(): string[] {
    return [...this.entries.keys()];
  }

  /** Агрегат процесса + разбивка по тенантам. */
  snapshot(): { aggregate: AggregatedHealth; tenants: Record<string, HealthSnapshot> } {
    const tenants: Record<string, HealthSnapshot> = {};
    for (const [id, health] of this.entries) tenants[id] = health.snapshot();
    return { aggregate: aggregateHealth(Object.values(tenants)), tenants };
  }
}

/** Короткий таймаут health-пробы Synth по умолчанию, мс. */
export const DEFAULT_HEALTH_PROBE_TIMEOUT_MS = 3000;

/** Интервал периодической health-пробы Synth, мс. */
export const DEFAULT_HEALTH_PROBE_INTERVAL_MS = 30_000;

/** Опции {@link SynthHealthProbe}. */
export interface SynthHealthProbeOptions {
  /** Базовый URL API v2 (например, `http://127.0.0.1:5000/api/v2`). */
  baseUrl: string;
  /** Служебный Bearer-ключ (для проб, требующих auth; `/health` публичный). */
  apiKey?: string;
  /** Реализация fetch (для тестов). По умолчанию `globalThis.fetch`. */
  fetchImpl?: typeof fetch;
  /** Таймаут пробы, мс (по умолчанию {@link DEFAULT_HEALTH_PROBE_TIMEOUT_MS}). */
  timeoutMs?: number;
  /** Интервал периодической пробы, мс (по умолчанию {@link DEFAULT_HEALTH_PROBE_INTERVAL_MS}). */
  intervalMs?: number;
  /** Best-effort состояние для health-эндпоинта. */
  health: GatewayHealth;
  /** Логгер (по умолчанию — тихий). */
  log?: (message: string) => void;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Периодическая/ленивая health-проба Synth API (ADR-089).
 *
 * `health.synth` инициализируется `down` и, помимо ингеста, обновляется этой
 * пробой: без неё `GET /health` врёт о доступности Synth, когда событий нет.
 * Проба бьёт по `GET {baseUrl}/health` (в API v2 — `/api/v2/health`) коротким
 * таймаутом и **никогда не бросает**: ошибка отражается только в статусе и не
 * влияет на основной цикл (приём/доставку).
 */
export class SynthHealthProbe {
  private readonly url: string;
  private readonly apiKey?: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly intervalMs: number;
  private readonly health: GatewayHealth;
  private readonly log: (message: string) => void;
  private timer?: ReturnType<typeof setInterval>;

  constructor(options: SynthHealthProbeOptions) {
    this.url = `${options.baseUrl.replace(/\/+$/, '')}/health`;
    this.apiKey = options.apiKey?.trim() ? options.apiKey.trim() : undefined;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_HEALTH_PROBE_TIMEOUT_MS;
    this.intervalMs = options.intervalMs ?? DEFAULT_HEALTH_PROBE_INTERVAL_MS;
    this.health = options.health;
    this.log = options.log ?? (() => {});
  }

  /** Одна проба; обновляет health и возвращает статус. Ошибки не пробрасываются. */
  async probe(): Promise<HealthStatus> {
    const controller = new AbortController();
    const headers: Record<string, string> = { accept: 'application/json' };
    if (this.apiKey) headers.authorization = `Bearer ${this.apiKey}`;

    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error('synth.health_probe_timeout'));
      }, this.timeoutMs);
    });

    try {
      const response = await Promise.race([
        this.fetchImpl(this.url, { headers, signal: controller.signal }),
        timeout,
      ]);
      const status: HealthStatus = response.ok ? 'up' : 'down';
      this.health.setSynth(status);
      if (!response.ok) {
        this.log(`[gateway] health-проба Synth: HTTP ${response.status} → down`);
      }
      return status;
    } catch (error) {
      this.health.setSynth('down');
      this.log(`[gateway] health-проба Synth недоступна: ${describeError(error)}`);
      return 'down';
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** Запускает немедленную пробу и периодический опрос (таймер не держит процесс). */
  start(): void {
    void this.probe();
    this.timer = setInterval(() => void this.probe(), this.intervalMs);
    this.timer.unref?.();
  }

  /** Останавливает периодический опрос. */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }
}
