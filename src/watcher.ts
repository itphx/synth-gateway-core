import type { BearerProvider } from './auth.js';
import type { ChannelAdapter } from './channel.js';
import type { GatewayHealth } from './health.js';
import { ROUTES_BUCKET } from './ingress.js';
import { KeySet, RecordStore, StateStore } from './store.js';
import type { DeliveryRequest, DeliveryResult, SessionRoute } from './types.js';

/**
 * Доставка ответов агента в канал (ADR-103, §4.2 контракта пакета).
 *
 * Порт `src/gateway/watcher.ts` эталонного Telegram-шлюза: общая часть
 * (SSE-подписка, переподключение с backoff, дедуп исходящих, grace-фоллбек
 * `message.added`) перенесена без изменений, а Telegram-специфика
 * (live-сообщение, правки, «Печатает…», rich-черновики, троттлинг правок,
 * удаление промежуточных сообщений Tool Use, HTML-рендеринг) ушла в **канал**
 * (§4.2 контракта: «доставка → `channel.send`»).
 *
 * Ядро знает wire-протокола канала не знает: ответ уходит через
 * `channel.send(DeliveryRequest)`, а частичные обновления ядро связывает с
 * предыдущим сообщением по `replaceMessageId`.
 */

/**
 * Grace-пауза фоллбека `message.added`, мс: ядро может прислать `message.added`
 * (обрезанный контент) раньше `stream.done` (полный) — отложенная доставка
 * отменяется, если за паузу пришёл стрим.
 */
export const ADDED_FALLBACK_GRACE_MS = 3000;

/** Метка, добавляемая к частичному ответу при остановке (`/stop`). */
export const STOPPED_MARK = '⏹ Остановлено';

/** Бакет состояния с ключами отправленных сообщений (дедуп исходящих). */
export const SENT_BUCKET = 'sent';

/** Максимум запоминаемых завершённых `stream_id` (защита от допоздних чанков). */
const FINALIZED_STREAMS_LIMIT = 500;

/** Начальная пауза переподключения SSE, мс. */
const DEFAULT_BACKOFF_MS = 1000;

/** Максимальная пауза переподключения SSE, мс. */
const DEFAULT_MAX_BACKOFF_MS = 30_000;

/** Событие глобального SSE-потока `GET /events` (конверт ядра). */
export interface SseEvent {
  type: string;
  data: Record<string, unknown>;
  sessionId?: string;
  timestamp?: string;
}

/** Накопленное состояние активного стрима сессии. */
interface LiveStream {
  /** Идентификатор стрима (для дедупа и `DeliveryRequest.streamId`). */
  streamId?: string;
  /** Текущая итерация Tool Use (номер из `stream.chunk.iteration`). */
  iteration?: number;
  /** Накопленный контент (без reasoning). */
  text: string;
  /** Служебная приписка (например, «↻ повтор 2/3…»). */
  note?: string;
  /**
   * id последнего доставленного сообщения — с ним ядро помечает следующую
   * частичную доставку (`replaceMessageId`), чтобы канал обновил уже
   * созданное сообщение, а не создал новое.
   */
  messageId?: string;
  /**
   * Индикатор набора уже отправлен (один раз на стрим — частота — забота
   * канала).
   */
  typingSent?: boolean;
}

/** Отложенная фоллбек-доставка `message.added`: таймер grace-паузы. */
interface PendingAdded {
  timer: ReturnType<typeof setTimeout>;
  /** Разрешается после доставки либо отмены (для наблюдения в тестах). */
  settled: Promise<void>;
  settle: () => void;
}

/** Опции {@link ResponseWatcher}. */
export interface WatcherOptions {
  /** Базовый URL API v2. */
  baseUrl: string;
  /** Служебный Bearer-ключ (standalone/dev; без `bearer`). */
  apiKey?: string;
  /** Провайдер Bearer-токена (OIDC/стат. ключ); при задании приоритетнее `apiKey`. */
  bearer?: BearerProvider;
  /** Канал-адресат доставки. */
  channel: ChannelAdapter;
  /** Персистентное состояние тенанта (маршруты + дедуп исходящих). */
  state: StateStore;
  /** Реализация fetch (для тестов). */
  fetchImpl?: typeof fetch;
  /** Начальная пауза переподключения, мс (по умолчанию 1000). */
  backoffMs?: number;
  /** Максимальная пауза переподключения, мс (по умолчанию 30000). */
  maxBackoffMs?: number;
  /** Логгер тенанта (префикс `[gateway][<tenantId>]`). */
  log?: (message: string) => void;
  /** Health тенанта. */
  health?: GatewayHealth;
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** `stream_id` из данных `message.added` (несётся в `metadata`). */
function streamIdOf(data: Record<string, unknown>): string | undefined {
  const metadata = data.metadata;
  if (typeof metadata !== 'object' || metadata === null) return undefined;
  return str((metadata as Record<string, unknown>).stream_id);
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function safeParse(payload: string): SseEvent | null {
  try {
    const parsed = JSON.parse(payload) as unknown;
    if (typeof parsed !== 'object' || parsed === null) return null;
    return parsed as SseEvent;
  } catch {
    return null;
  }
}

/**
 * Разбирает буфер SSE на полезные нагрузки `data:`.
 *
 * Блоки разделяются пустой строкой; комментарии-keepalive (`:keepalive`)
 * игнорируются. Возвращает разобранные payload'ы и незавершённый «хвост» буфера.
 */
export function parseSseData(buffer: string): { payloads: string[]; rest: string } {
  const blocks = buffer.split('\n\n');
  const rest = blocks.pop() ?? '';
  const payloads: string[] = [];
  for (const block of blocks) {
    const dataLines = block
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice('data:'.length).trimStart());
    if (dataLines.length > 0) payloads.push(dataLines.join('\n'));
  }
  return { payloads, rest };
}

/**
 * Watcher ответов агента: слушает глобальный SSE `GET /events` и доставляет
 * ответы в канал по маршруту «сессия → адресат».
 *
 * Обработка (контракт §4.2):
 *
 * | Событие | Действие |
 * |---|---|
 * | `stream.chunk` | накопление текста; при `capabilities.streaming` — доставка `kind: 'partial'` (первый вызов создаёт сообщение, последующие — с `replaceMessageId`); индикатор набора (`capabilities.actions`, `type: 'typing'`) — один раз на стрим |
 * | `stream.done` | отмена отложенного `message.added`; доставка `kind: 'final'` (полный текст: `data.content` ?? накопленный) |
 * | `stream.cancelled` | отмена отложенного `message.added`; доставка `kind: 'cancelled'` |
 * | `stream.error` | отмена отложенного `message.added`; доставка `kind: 'error'` |
 * | `message.added` (роль `assistant`) | **отложенный** фоллбек через grace-паузу (3000 мс): если за паузу пришёл `stream.done`/`stream.cancelled` — отменяется |
 *
 * Дедуп исходящих — персистентный (бакет `sent`); ключ проставляется **до**
 * фактической отправки. События сессий без маршрута игнорируются.
 */
export class ResponseWatcher {
  private readonly baseUrl: string;
  private readonly apiKey?: string;
  private readonly bearer?: BearerProvider;
  private readonly channel: ChannelAdapter;
  private readonly fetchImpl: typeof fetch;
  private readonly backoffMs: number;
  private readonly maxBackoffMs: number;
  private readonly log: (message: string) => void;
  private readonly health?: GatewayHealth;
  /** Персистентный дедуп исходящих доставок. */
  private readonly sent: KeySet;
  /** Персистентные маршруты «сессия → адресат в канале». */
  private readonly routes: RecordStore<SessionRoute>;
  /** Активные стримы по сессиям (накопленный контент + id сообщения). */
  private readonly live = new Map<string, LiveStream>();
  /** Завершённые `stream_id` — допоздние чанки после `done`/`cancelled` игнорируются. */
  private readonly finalizedStreams = new Set<string>();
  /** Отложенные фоллбек-доставки `message.added` по сессиям. */
  private readonly pendingAdded = new Map<string, PendingAdded>();
  /** Контроллер текущего SSE-соединения. */
  private controller?: AbortController;
  /** Читатель текущего SSE-потока (для прерывания при останове). */
  private reader?: ReadableStreamDefaultReader<Uint8Array>;
  /** Сигнал остановки watcher'а (прерывает паузу переподключения). */
  private readonly stopController = new AbortController();
  private stopped = false;

  constructor(options: WatcherOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.apiKey = options.apiKey?.trim() ? options.apiKey.trim() : undefined;
    this.bearer = options.bearer;
    this.channel = options.channel;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.backoffMs = options.backoffMs ?? DEFAULT_BACKOFF_MS;
    this.maxBackoffMs = options.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS;
    this.log = options.log ?? (() => {});
    this.health = options.health;
    this.sent = new KeySet(options.state, SENT_BUCKET);
    this.routes = new RecordStore<SessionRoute>(options.state, ROUTES_BUCKET);
  }

  /**
   * Цикл подключения к SSE с переподключением и backoff. Завершается после
   * {@link ResponseWatcher.stop}.
   */
  async run(): Promise<void> {
    let backoff = this.backoffMs;
    while (!this.stopped) {
      try {
        await this.connect();
        backoff = this.backoffMs;
      } catch (error) {
        this.health?.setWatcher('down');
        if (this.stopped) break;
        this.log(`[gateway] watcher ошибка: ${describeError(error)}`);
      }
      if (this.stopped) break;
      await this.delay(backoff);
      backoff = Math.min(backoff * 2, this.maxBackoffMs);
    }
  }

  /** Останавливает watcher (прерывает SSE-соединение и гасит отложенные доставки). */
  async stop(): Promise<void> {
    this.stopped = true;
    this.stopController.abort();
    this.controller?.abort();
    try {
      await this.reader?.cancel();
    } catch {
      /* поток уже закрыт */
    }
    this.clearPendingAdded();
  }

  /** Подключение к SSE и чтение потока событий до обрыва. */
  private async connect(): Promise<void> {
    const controller = new AbortController();
    this.controller = controller;

    const headers: Record<string, string> = { accept: 'text/event-stream' };
    const token = this.bearer ? await this.bearer.getBearer() : this.apiKey;
    if (token) headers.authorization = `Bearer ${token}`;

    const url = `${this.baseUrl}/events`;
    let response = await this.fetchImpl(url, { headers, signal: controller.signal });

    // 401 — токен истёк/недействителен: обновляем и повторяем один раз
    // (без траты retry-бюджета переподключения).
    if (response.status === 401 && this.bearer) {
      await response.body?.cancel().catch(() => undefined);
      try {
        await this.bearer.refreshBearer();
      } catch {
        /* ошибку получения токена отразит health */
      }
      const retryToken = await this.bearer.getBearer().catch(() => undefined);
      const retryHeaders: Record<string, string> = { ...headers };
      if (retryToken) retryHeaders.authorization = `Bearer ${retryToken}`;
      else delete retryHeaders.authorization;
      response = await this.fetchImpl(url, { headers: retryHeaders, signal: controller.signal });
    }

    if (!response.ok || !response.body) {
      throw new Error(`SSE ${response.status} ${response.statusText}`);
    }
    this.health?.setWatcher('up');
    this.log('[gateway] watcher подключён к SSE /events');

    const reader = response.body.getReader();
    this.reader = reader;
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const { payloads, rest } = parseSseData(buffer);
        buffer = rest;
        for (const payload of payloads) {
          const parsed = safeParse(payload);
          if (parsed) await this.handleEvent(parsed);
        }
      }
    } finally {
      try {
        reader.releaseLock();
      } catch {
        /* уже освобождён */
      }
      if (this.reader === reader) this.reader = undefined;
      this.health?.setWatcher('down');
    }
  }

  /** Обрабатывает одно SSE-событие. */
  private async handleEvent(event: SseEvent): Promise<void> {
    const sessionId = event.sessionId;
    if (!sessionId) return;
    // События сессий без маршрута игнорируются.
    const route = await this.routes.get(sessionId);
    if (!route) return;

    switch (event.type) {
      case 'stream.start':
        this.onStreamStart(sessionId, event.data);
        return;
      case 'stream.chunk':
        await this.onStreamChunk(sessionId, route, event.data);
        return;
      case 'stream.retry':
        this.onStreamRetry(sessionId, event.data);
        return;
      case 'stream.done':
        await this.onStreamDone(sessionId, route, event);
        return;
      case 'stream.cancelled':
        await this.onStreamCancelled(sessionId, route, event);
        return;
      case 'stream.error':
        await this.onStreamError(sessionId, route, event.data);
        return;
      case 'message.added':
        await this.onMessageAdded(sessionId, route, event.data);
        return;
      default:
        return;
    }
  }

  /** `stream.start` — запоминаем стрим сессии (доставок не делаем). */
  private onStreamStart(sessionId: string, data: Record<string, unknown>): void {
    const streamId = str(data.stream_id);
    if (!streamId) return;
    this.ensureLive(sessionId, streamId);
  }

  /** `stream.chunk` — накопление контента и частичная доставка. */
  private async onStreamChunk(
    sessionId: string,
    route: SessionRoute,
    data: Record<string, unknown>,
  ): Promise<void> {
    const streamId = str(data.stream_id);
    if (streamId !== undefined && this.finalizedStreams.has(streamId)) return;
    const live = this.ensureLive(sessionId, streamId);

    const iteration = num(data.iteration);
    if (iteration !== undefined) live.iteration = iteration;

    // `content` — дельта контента; reasoning не накапливаем и не стримим.
    const delta = str(data.content);
    if (delta) {
      live.text += delta;
      // Индикатор набора — один раз на стрим (частота — забота канала).
      await this.notifyTyping(route, live);
    }
    if (!this.channel.capabilities.streaming) return;
    if (live.text.length === 0) return;
    await this.deliverPartial(route, live);
  }

  /**
   * Индикатор набора в чате: `channel.actions({ type: 'typing' })`.
   *
   * Отправляется **один раз на стрим** и только если канал объявил
   * `capabilities.actions` и реализовал метод. Ошибка канала не роняет
   * watcher (лог + продолжение).
   */
  private async notifyTyping(route: SessionRoute, live: LiveStream): Promise<void> {
    if (live.typingSent) return;
    if (!this.channel.capabilities.actions) return;
    const actions = this.channel.actions;
    if (typeof actions !== 'function') return;
    live.typingSent = true;
    try {
      await actions.call(this.channel, { route, type: 'typing' });
    } catch (error) {
      this.log(`[gateway] watcher: ошибка действия канала (typing): ${describeError(error)}`);
    }
  }

  /** `stream.retry` — служебная приписка «↻ повтор N/M…» (доставка — со следующим чанком). */
  private onStreamRetry(sessionId: string, data: Record<string, unknown>): void {
    const live = this.live.get(sessionId);
    if (!live) return;
    const attempt = num(data.attempt);
    if (attempt === undefined) return;
    const max = num(data.max_retries);
    live.note = `↻ повтор ${attempt}${max !== undefined ? `/${max}` : ''}…`;
  }

  /** `stream.done` — финал: полный ответ (или накопленный текст). */
  private async onStreamDone(
    sessionId: string,
    route: SessionRoute,
    event: SseEvent,
  ): Promise<void> {
    // Стрим доставил (или доставит) полный ответ — отложенный фоллбек-огрызок
    // `message.added` отменяем.
    this.cancelPendingAdded(sessionId);
    const live = this.live.get(sessionId);
    const iteration = live?.iteration;
    const streamId =
      str(event.data.stream_id) ?? live?.streamId ?? `${sessionId}:${event.timestamp ?? ''}`;
    const content = str(event.data.content) ?? live?.text ?? '';
    const messageIndex = num(event.data.message_index);

    if (
      messageIndex !== undefined &&
      (await this.sent.has(`message:${sessionId}:${messageIndex}`))
    ) {
      this.finishLive(sessionId);
      return;
    }
    if (await this.sent.has(`stream:${streamId}`)) {
      this.finishLive(sessionId);
      return;
    }
    // Нечего доставлять — помечать стрим отправленным нельзя: иначе повтор
    // `stream.done` с контентом уже не доставится.
    if (!content) {
      this.finishLive(sessionId);
      return;
    }

    await this.sent.add(`stream:${streamId}`);
    if (messageIndex !== undefined) await this.sent.add(`message:${sessionId}:${messageIndex}`);
    this.markFinalized(streamId);
    this.finishLive(sessionId);
    await this.deliver(route, {
      content,
      kind: 'final',
      ...(streamId ? { streamId } : {}),
      ...(messageIndex !== undefined ? { messageIndex } : {}),
      ...(iteration !== undefined ? { iteration } : {}),
    });
  }

  /** `stream.cancelled` — финализация частичным текстом с пометкой остановки. */
  private async onStreamCancelled(
    sessionId: string,
    route: SessionRoute,
    event: SseEvent,
  ): Promise<void> {
    this.cancelPendingAdded(sessionId);
    const live = this.live.get(sessionId);
    const iteration = live?.iteration;
    const streamId =
      str(event.data.stream_id) ?? live?.streamId ?? `${sessionId}:${event.timestamp ?? ''}`;
    if (await this.sent.has(`stream:${streamId}`)) {
      this.finishLive(sessionId);
      return;
    }
    await this.sent.add(`stream:${streamId}`);
    this.markFinalized(streamId);
    this.finishLive(sessionId);

    const content = str(event.data.content) ?? live?.text ?? '';
    const body = content ? `${content}\n\n${STOPPED_MARK}` : STOPPED_MARK;
    await this.deliver(route, {
      content: body,
      kind: 'cancelled',
      ...(streamId ? { streamId } : {}),
      ...(iteration !== undefined ? { iteration } : {}),
    });
  }

  /** `stream.error` — доставка текста ошибки. */
  private async onStreamError(
    sessionId: string,
    route: SessionRoute,
    data: Record<string, unknown>,
  ): Promise<void> {
    this.cancelPendingAdded(sessionId);
    const live = this.live.get(sessionId);
    const iteration = live?.iteration;
    const streamId = str(data.stream_id) ?? live?.streamId ?? `${sessionId}:error`;
    if (await this.sent.has(`error:${streamId}`)) {
      this.finishLive(sessionId);
      return;
    }
    await this.sent.add(`error:${streamId}`);
    this.markFinalized(streamId);
    this.finishLive(sessionId);

    const message = str(data.error) ?? 'Неизвестная ошибка';
    await this.deliver(route, {
      content: `⚠️ Ошибка агента: ${message}`,
      kind: 'error',
      ...(streamId ? { streamId } : {}),
      ...(iteration !== undefined ? { iteration } : {}),
    });
  }

  /**
   * Фоллбек-доставка `message.added` (assistant) без стрима.
   *
   * `message.added` может прийти **раньше** `stream.done` (и нести контент,
   * обрезанный ядром) — поэтому доставляем не сразу, а с grace-паузой: если за
   * неё придёт стрим, отложенная доставка отменяется. Сообщения пользователя
   * (`role === 'user'`) не доставляются — это входящие, а не ответы.
   */
  private async onMessageAdded(
    sessionId: string,
    route: SessionRoute,
    data: Record<string, unknown>,
  ): Promise<void> {
    const role = str(data.role)?.toLowerCase();
    if (role === 'user') return;
    if (role !== 'assistant') return;
    const content = str(data.content);
    if (!content) return;
    const messageIndex = num(data.message_index);
    const streamId = streamIdOf(data);
    // Уже финализировано стримом (или повтор) — огрызок не доставляем.
    if (await this.isAnswerDelivered(sessionId, messageIndex, streamId)) return;
    this.scheduleMessageAdded(sessionId, route, content, messageIndex, streamId);
  }

  /** Откладывает фоллбек-доставку `message.added` на grace-паузу. */
  private scheduleMessageAdded(
    sessionId: string,
    route: SessionRoute,
    content: string,
    messageIndex: number | undefined,
    streamId: string | undefined,
  ): void {
    this.cancelPendingAdded(sessionId);
    let settle!: () => void;
    const settled = new Promise<void>((resolve) => {
      settle = resolve;
    });
    const timer = setTimeout(() => {
      this.pendingAdded.delete(sessionId);
      void this.flushMessageAdded(sessionId, route, content, messageIndex, streamId)
        .catch((error) => {
          this.log(`[gateway] watcher: ошибка фоллбека message.added: ${describeError(error)}`);
        })
        .finally(settle);
    }, ADDED_FALLBACK_GRACE_MS);
    if (typeof timer.unref === 'function') timer.unref();
    this.pendingAdded.set(sessionId, { timer, settled, settle });
  }

  /** По срабатыванию grace-паузы: повторная проверка дедупа и доставка. */
  private async flushMessageAdded(
    sessionId: string,
    route: SessionRoute,
    content: string,
    messageIndex: number | undefined,
    streamId: string | undefined,
  ): Promise<void> {
    if (await this.isAnswerDelivered(sessionId, messageIndex, streamId)) return;
    const key =
      messageIndex !== undefined
        ? `message:${sessionId}:${messageIndex}`
        : `message-content:${sessionId}:${streamId ?? content.length}`;
    if (await this.sent.has(key)) return;
    await this.sent.add(key);
    await this.deliver(route, {
      content,
      kind: 'final',
      ...(streamId ? { streamId } : {}),
      ...(messageIndex !== undefined ? { messageIndex } : {}),
    });
  }

  /** Ответ уже доставлен стримом (по `message_index` либо `stream_id`)? */
  private async isAnswerDelivered(
    sessionId: string,
    messageIndex: number | undefined,
    streamId: string | undefined,
  ): Promise<boolean> {
    if (
      messageIndex !== undefined &&
      (await this.sent.has(`message:${sessionId}:${messageIndex}`))
    ) {
      return true;
    }
    return streamId !== undefined && (await this.sent.has(`stream:${streamId}`));
  }

  /** Частичная доставка накопленного текста (только при `capabilities.streaming`). */
  private async deliverPartial(route: SessionRoute, live: LiveStream): Promise<void> {
    const content = live.note ? `${live.text}\n\n${live.note}` : live.text;
    const result = await this.deliver(route, {
      content,
      kind: 'partial',
      ...(live.streamId ? { streamId: live.streamId } : {}),
      ...(live.iteration !== undefined ? { iteration: live.iteration } : {}),
      ...(live.note !== undefined ? { note: live.note } : {}),
      ...(live.messageId !== undefined ? { replaceMessageId: live.messageId } : {}),
    });
    // Ядро помнит id отправленного сообщения: следующая частичная доставка
    // идёт с `replaceMessageId` (канал обновляет то же сообщение).
    if (result?.messageId) live.messageId = result.messageId;
  }

  /** Доставка в канал; ошибки канала не роняют watcher. */
  private async deliver(
    route: SessionRoute,
    request: Omit<DeliveryRequest, 'route'>,
  ): Promise<DeliveryResult | undefined> {
    try {
      return await this.channel.send({ ...request, route });
    } catch (error) {
      this.log(`[gateway] watcher: ошибка доставки в канал: ${describeError(error)}`);
      return undefined;
    }
  }

  /**
   * Возвращает (при необходимости создаёт) состояние стрима сессии.
   *
   * Новый `stream_id` в той же сессии — прежний стрим больше не актуален:
   * накопленный текст, итерация и id сообщения сбрасываются (иначе текст
   * прошлого ответа попал бы в новый).
   */
  private ensureLive(sessionId: string, streamId?: string): LiveStream {
    let live = this.live.get(sessionId);
    if (!live) {
      live = { text: '' };
      this.live.set(sessionId, live);
    }
    if (streamId !== undefined && live.streamId !== streamId) {
      live.streamId = streamId;
      live.text = '';
      live.iteration = undefined;
      live.note = undefined;
      live.messageId = undefined;
      live.typingSent = undefined;
    }
    return live;
  }

  /** Убирает состояние стрима сессии. */
  private finishLive(sessionId: string): void {
    this.live.delete(sessionId);
  }

  private markFinalized(streamId: string): void {
    this.finalizedStreams.add(streamId);
    if (this.finalizedStreams.size > FINALIZED_STREAMS_LIMIT) {
      const oldest = this.finalizedStreams.values().next().value;
      if (oldest !== undefined) this.finalizedStreams.delete(oldest);
    }
  }

  /** Гасит отложенные фоллбек-доставки `message.added` (все сессии). */
  private clearPendingAdded(): void {
    for (const pending of this.pendingAdded.values()) {
      clearTimeout(pending.timer);
      pending.settle();
    }
    this.pendingAdded.clear();
  }

  /** Гасит отложенную фоллбек-доставку `message.added` конкретной сессии. */
  private cancelPendingAdded(sessionId: string): void {
    const pending = this.pendingAdded.get(sessionId);
    if (pending === undefined) return;
    clearTimeout(pending.timer);
    pending.settle();
    this.pendingAdded.delete(sessionId);
  }

  /** Пауза переподключения; прерывается остановом watcher'а. */
  private delay(ms: number): Promise<void> {
    const signal = this.stopController.signal;
    return new Promise((resolve) => {
      if (signal.aborted) {
        resolve();
        return;
      }
      const onAbort = (): void => {
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        signal.removeEventListener('abort', onAbort);
        resolve();
      }, ms);
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }
}
