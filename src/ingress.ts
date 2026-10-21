import type { EventIdentity, IngestResult, SynthApi } from './api.js';
import { SynthEventsError } from './api.js';
import type { UnknownAction } from './config.js';
import type { GatewayHealth } from './health.js';
import { KeySet, RecordStore, StateStore } from './store.js';
import type { InboundIdentity, InboundMessage, SessionRoute } from './types.js';

/**
 * Политика приёма ядра шлюза (ADR-103, §4.1 контракта пакета).
 *
 * Порт механики приёма эталонного Telegram-шлюза (`src/gateway/poller.ts`):
 * нормализация (в Telegram — `normalize.ts`) ушла в **канал**, ядро осталось
 * политикой: список доступа → дедуп → публикация → маршрут → политика
 * неизвестного отправителя.
 *
 * Каждый шаг — fail-closed: отправитель вне списка доступа не публикуется
 * вовсе, неуспешная публикация не считается обработанной (дедуп-ключ не
 * фиксируется — повтор возможен).
 */

/** Бакет состояния с ключами дедупликации входящих сообщений. */
export const SEEN_BUCKET = 'seen';

/** Бакет состояния с маршрутами «сессия → адресат в канале». */
export const ROUTES_BUCKET = 'routes';

/** Опции {@link Ingress}. */
export interface IngressOptions {
  /** Клиент API v2 Synth (публикация события). */
  api: SynthApi;
  /** Персистентное состояние тенанта (дедуп + маршруты). */
  state: StateStore;
  /** Список доступа: `ключ → роль` (`ADMIN`/`USER`/`LEAD`/`AUDITOR`). */
  allowlist: Record<string, string>;
  /** Политика отправителя, не сопоставленного с учётной записью Synth. */
  unknownAction: UnknownAction;
  /** Источник событий (`source` в `POST /api/v2/events`). */
  source: string;
  /**
   * Известен ли отправитель профилю Synth (для политики `unknownAction`).
   *
   * Резолвит **ядро** Synth (профиль/идентичности), шлюз собственного реестра
   * пользователей не ведёт. Без резолвера отправитель считается неизвестным
   * (fail-closed): политика `reject` отклонит сообщение.
   */
  isSenderKnown?: (identity: InboundIdentity) => boolean | Promise<boolean>;
  /** Логгер тенанта (префикс `[gateway][<tenantId>]`). */
  log?: (message: string) => void;
  /** Health тенанта (фактическое состояние обновляет клиент API). */
  health?: GatewayHealth;
  /**
   * Колбэк выдачи кода линковки каналу (ADR-089, claim-flow).
   *
   * Вызывается **после** успешной публикации, когда политика — `hint` и ответ
   * приёма содержит `identityHint.code`. Канал сам решает, можно ли показывать
   * код в канале (в публичном чате код линковки не показывают).
   */
  onIdentityHint?: (code: string, message: InboundMessage) => void | Promise<void>;
  /**
   * Пометить входящее сообщение прочитанным (вызывается после успешной публикации).
   *
   * Ошибка колбэка **не** ломает обработку: ядро логирует её и продолжает
   * (результат остаётся `published`). Колбэк не вызывается при отказе политики
   * (`not_allowed`/`duplicate`/`unknown_sender`) и при ошибке публикации.
   */
  markRead?: (message: InboundMessage) => void | Promise<void>;
}

/** Итог обработки входящего сообщения. */
export type IngressOutcome =
  | {
      status: 'published';
      sessionId: string | null;
      identityHint?: { code: string; expiresAt: string };
    }
  | { status: 'rejected'; reason: 'not_allowed' | 'duplicate' | 'unknown_sender' }
  | { status: 'failed'; error: unknown };

/** Дефолтный резолвер «известности» отправителя: неизвестен (fail-closed). */
const unknownSenderResolver = (): boolean => false;

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Ядро приёма: политика допуска, дедупликации, публикации и маршрутизации
 * входящих сообщений канала в платформу внешних событий Synth (ADR-089).
 */
export class Ingress {
  private readonly api: SynthApi;
  private readonly allowlist: Record<string, string>;
  private readonly unknownAction: UnknownAction;
  private readonly source: string;
  private readonly isSenderKnown: (identity: InboundIdentity) => boolean | Promise<boolean>;
  private readonly log: (message: string) => void;
  private readonly health?: GatewayHealth;
  private readonly onIdentityHint?: (code: string, message: InboundMessage) => void | Promise<void>;
  private readonly markRead?: (message: InboundMessage) => void | Promise<void>;
  /** Персистентный дедуп входящих сообщений. */
  private readonly seen: KeySet;
  /** Персистентные маршруты «сессия → адресат в канале». */
  private readonly routes: RecordStore<SessionRoute>;

  constructor(options: IngressOptions) {
    this.api = options.api;
    this.allowlist = options.allowlist;
    this.unknownAction = options.unknownAction;
    this.source = options.source;
    this.isSenderKnown = options.isSenderKnown ?? unknownSenderResolver;
    this.log = options.log ?? (() => {});
    this.health = options.health;
    this.onIdentityHint = options.onIdentityHint;
    this.markRead = options.markRead;
    this.seen = new KeySet(options.state, SEEN_BUCKET);
    this.routes = new RecordStore<SessionRoute>(options.state, ROUTES_BUCKET);
  }

  /**
   * Обрабатывает входящее сообщение канала.
   *
   * Порядок (fail-closed на каждом шаге, §4.1 контракта):
   *
   * 1. список доступа — первый найденный ключ `identity.accessKeys` даёт роль;
   *    не найден → `not_allowed`, публикации нет;
   * 2. дедуп — `dedupKey` в персистентном множестве → `duplicate`;
   * 3. политика неизвестного отправителя (`reject` — до публикации);
   * 4. публикация `POST /api/v2/events`;
   * 5. маршрут (при `sessionId` в ответе);
   * 6. отметка «прочитано» (`options.markRead`) — после успешной публикации;
   * 7. код линковки (политика `hint`, после успешной публикации).
   *
   * Ошибка публикации → `failed`: дедуп-ключ **не** фиксируется, повтор
   * возможен.
   */
  async handle(message: InboundMessage): Promise<IngressOutcome> {
    // 1. Список доступа (fail-closed): событие вне allowlist не публикуется.
    const role = this._resolveRole(message.identity);
    if (role === undefined) {
      this.log('[gateway] входящее сообщение отклонено: отправитель вне списка доступа');
      return { status: 'rejected', reason: 'not_allowed' };
    }

    // 2. Дедуп: ключ в персистентном множестве — повтор не публикуем.
    if (await this.seen.has(message.dedupKey)) {
      this.log(`[gateway] входящее сообщение отклонено: дубль ${message.dedupKey}`);
      return { status: 'rejected', reason: 'duplicate' };
    }

    // 3. Политика неизвестного отправителя: `reject` — до публикации.
    if (this.unknownAction === 'reject') {
      const known = await this.isSenderKnown(message.identity);
      if (!known) {
        this.log(
          '[gateway] входящее сообщение отклонено: отправитель не сопоставлен с учётной записью',
        );
        return { status: 'rejected', reason: 'unknown_sender' };
      }
    }

    // 4. Публикация.
    let result: IngestResult;
    try {
      result = await this.api.postEvent(this._eventInput(message, role));
    } catch (error) {
      // Сообщение не обработано: дедуп-ключ не фиксируем — повтор возможен.
      // Сетевая ошибка (status 0) — Synth недоступен; HTTP-ответ (4xx/5xx)
      // означает, что API жив, и состояние обновляет сам клиент.
      if (error instanceof SynthEventsError && error.status === 0) {
        this.health?.setSynth('down');
      }
      this.log(`[gateway] не удалось опубликовать входящее сообщение: ${describeError(error)}`);
      return { status: 'failed', error };
    }

    // Публикация удалась — фиксируем дедуп-ключ (до него повтор был возможен).
    await this.seen.add(message.dedupKey);

    // 5. Маршрут «сессия → адресат в канале» (нужен watcher'у ответов).
    if (result.sessionId) {
      const route: SessionRoute = {
        sessionId: result.sessionId,
        target: message.target,
        ...(message.inboundMessageId !== undefined
          ? { inboundMessageId: message.inboundMessageId }
          : {}),
        updatedAt: new Date().toISOString(),
      };
      await this.routes.set(result.sessionId, route);
    }

    // 6. Отметка «прочитано» — только после успешной публикации. Ошибка
    //    канала не влияет на результат обработки (лог + продолжение).
    if (this.markRead) {
      try {
        await this.markRead(message);
      } catch (error) {
        this.log(`[gateway] не удалось пометить сообщение прочитанным: ${describeError(error)}`);
      }
    }

    // 7. Код линковки (claim-flow): только после успешной публикации.
    const identityHint = result.identityHint;
    if (this.unknownAction === 'hint' && identityHint?.code) {
      try {
        await this.onIdentityHint?.(identityHint.code, message);
      } catch (error) {
        this.log(`[gateway] не удалось передать код линковки каналу: ${describeError(error)}`);
      }
    }

    return {
      status: 'published',
      sessionId: result.sessionId ?? null,
      ...(identityHint ? { identityHint } : {}),
    };
  }

  /**
   * Роль отправителя по списку доступа: **первый** ключ из
   * `identity.accessKeys`, найденный в allowlist. Не найден — `undefined`
   * (сообщение не публикуется).
   */
  private _resolveRole(identity: InboundIdentity): string | undefined {
    for (const accessKey of identity.accessKeys) {
      const key = accessKey.trim();
      if (!key) continue;
      const role = this.allowlist[key];
      if (role !== undefined) {
        const normalized = role.trim().toUpperCase();
        if (normalized) return normalized;
      }
    }
    return undefined;
  }

  /** Тело события для `POST /api/v2/events` (роль — в `identity.roles`). */
  private _eventInput(
    message: InboundMessage,
    role: string,
  ): {
    source: string;
    type: string;
    payload: Record<string, unknown>;
    identity: EventIdentity;
    dedupKey: string;
  } {
    const identity: EventIdentity = {
      principalId: message.identity.principalId,
      ...(message.identity.chatKey !== undefined ? { chatKey: message.identity.chatKey } : {}),
      ...(message.identity.threadKey !== undefined
        ? { threadKey: message.identity.threadKey }
        : {}),
      roles: [role],
    };
    return {
      source: this.source,
      type: 'message',
      payload: { text: message.text, ...(message.meta ?? {}) },
      identity,
      dedupKey: message.dedupKey,
    };
  }
}
