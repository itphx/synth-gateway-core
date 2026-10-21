import type { SynthApi } from './api.js';
import type { TenantConfig } from './config.js';
import type { GatewayHealth } from './health.js';
import type { StateStore } from './store.js';
import type {
  ActionRequest,
  ChannelCapabilities,
  DeleteRequest,
  DeliveryRequest,
  DeliveryResult,
  EditRequest,
  InboundMessage,
  MarkReadRequest,
  NoticeRequest,
} from './types.js';

/**
 * Контракт канала — граница между ядром шлюза и внешним транспортом
 * (ADR-103, §3.2 контракта пакета).
 *
 * Ядро не знает wire-протокола канала, канал не знает про API Synth (кроме
 * `ctx.publish`). Определения ниже — дословно из `docs/contract.md` §3.2:
 * правки здесь = breaking change пакета.
 */

/**
 * Конфигурация тенанта в контексте канала.
 *
 * `TenantConfig` в `config.ts` — дженерик по типу канала (`TChannel`), а ядро
 * тип канала не знает: в контексте это `unknown`, канал сам приводит
 * `ctx.tenant.channel` к своему типу.
 */
export type TenantContext = TenantConfig<unknown>;

/** Результат публикации входящего сообщения. */
export interface PublishResult {
  /** Сессия, выбранная ядром (null — маршрут не создаётся). */
  sessionId: string | null;
  /** Код линковки для несопознанного отправителя (ADR-089). */
  identityHint?: { code: string; expiresAt: string };
}

/** Контекст, который ядро передаёт каналу при старте. */
export interface ChannelContext {
  /** Публикация в Synth. Ядро уже проверило allowlist и дедуп. */
  publish(message: InboundMessage): Promise<PublishResult>;
  /** Персистентное состояние канала (изолировано по тенанту). */
  state: StateStore;
  /** Клиент API v2 Synth (привязки, сессии, пользователи). */
  synth: SynthApi;
  /** Логгер тенанта: префикс `[gateway][<tenantId>]`. */
  log: (message: string) => void;
  /** Health тенанта. */
  health: GatewayHealth;
  /** Конфигурация тенанта. */
  tenant: TenantContext;
}

/**
 * Контракт канала — внешнего транспорта одного тенанта.
 *
 * Операции `edit`/`delete`/`actions`/`markRead` **опциональны**: канал без
 * правок (почта) не обязан их реализовывать. Поддержку канал объявляет через
 * `capabilities` (`editing`/`deleting`/`actions`), отсутствие метода означает
 * «не умеет» — ядро такую операцию просто не вызывает.
 */
export interface ChannelAdapter {
  /** Источник событий (`source` в `POST /api/v2/events`). */
  readonly source: string;
  /** Возможности канала. */
  readonly capabilities: ChannelCapabilities;

  /** Подключиться и начать приём. Резолвится сразу: цикл — внутри. */
  start(ctx: ChannelContext): Promise<void>;
  /** Остановить приём и освободить ресурсы. Идемпотентно. */
  stop(): Promise<void>;

  /** Отправить сообщение в канал. */
  send(req: DeliveryRequest): Promise<DeliveryResult>;

  /** Служебное уведомление (код линковки). Опционально. */
  notify?(req: NoticeRequest): Promise<void>;

  /** Отредактировать ранее отправленное сообщение (`capabilities.editing`). */
  edit?(req: EditRequest): Promise<DeliveryResult>;
  /** Удалить ранее отправленное сообщение (`capabilities.deleting`). */
  delete?(req: DeleteRequest): Promise<void>;
  /** Действие в чате, не связанное с сообщением (`capabilities.actions`; `typing`). */
  actions?(req: ActionRequest): Promise<void>;
  /** Отметить входящее сообщение прочитанным (аналог IMAP `\Seen`). */
  markRead?(req: MarkReadRequest): Promise<void>;
}
