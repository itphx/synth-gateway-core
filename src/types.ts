/**
 * Контракт канала и доставки (ADR-103, класс Gateway — ADR-087).
 *
 * Ядро (`@itphx/synth-gateway-core`) не знает wire-протокола канала, канал не
 * знает про API Synth (кроме `ctx.publish`). Этот модуль — единственное место,
 * где описана граница между ними: типы ниже используют и ядро, и канал.
 *
 * Определения — дословно из `docs/contract.md` §3.1; правки здесь = breaking
 * change пакета.
 */

/** JSON-значение — сериализуемый формат цели канала. */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

/** Возможности канала. */
export interface ChannelCapabilities {
  /** Канал умеет частичные обновления (live-стриминг ответа). */
  streaming: boolean;
  /** Канал умеет редактировать ранее отправленное сообщение. */
  editing: boolean;
  /** Канал умеет черновики: ответ требует подтверждения перед отправкой. */
  drafts: boolean;
  /** Канал умеет треды (у сообщения есть `threadKey`). */
  threads: boolean;
  /** Канал принимает вложения (информационно: контент ядром не передаётся). */
  attachments: boolean;
  /** Канал умеет удалять ранее отправленные сообщения. */
  deleting: boolean;
  /** Канал умеет действия в чате, не связанные с сообщением (индикатор набора и т.п.). */
  actions: boolean;
}

/** Идентичность входящего отправителя в терминах канала. */
export interface InboundIdentity {
  /** Полный `principalId` (`<provider>:<externalId>`) — маппится на профиль Synth. */
  principalId: string;
  /** Ключ «чата»/переписки — ключ Binding. */
  chatKey?: string;
  /** Ключ треда — ключ Binding (приоритетнее `chatKey`). */
  threadKey?: string;
  /** Ключи списка доступа (адрес в канале). Первый найденный в allowlist — истина. */
  accessKeys: string[];
}

/** Нормализованное входящее сообщение канала. */
export interface InboundMessage {
  /** Стабильный ключ дедупликации — `<source>:<...>`, переживает реконнект. */
  dedupKey: string;
  identity: InboundIdentity;
  /** Текст сообщения → `payload.text`. */
  text: string;
  /** Канал-специфичные метаданные → `payload` (тема, заголовки, вложения). */
  meta?: Record<string, unknown>;
  /** Адресат ответа в канале (формат определяет канал) — попадает в маршрут. */
  target: JsonValue;
  /** Идентификатор входящего сообщения (reply-цель) — попадает в маршрут. */
  inboundMessageId?: string;
}

/** Маршрут «сессия → адресат в канале». */
export interface SessionRoute {
  sessionId: string;
  /** Цель в канале (формат определяет канал). */
  target: JsonValue;
  /** Идентификатор входящего сообщения (reply-цель). */
  inboundMessageId?: string;
  updatedAt: string;
}

/** Вид доставки. */
export type DeliveryKind = 'partial' | 'final' | 'error' | 'cancelled';

/** Запрос доставки ответа в канал. */
export interface DeliveryRequest {
  route: SessionRoute;
  /** Текст ответа (частичный — при `kind: 'partial'`). */
  content: string;
  kind: DeliveryKind;
  /** Идентификатор стрима (для дедупа). */
  streamId?: string;
  /** Индекс сообщения в сессии (для дедупа). */
  messageIndex?: number;
  /** Итерация Tool Use — смена означает завершение промежуточного шага. */
  iteration?: number;
  /** Служебная приписка (например «↻ повтор 2/3…»). */
  note?: string;
  /** id ранее отправленного сообщения — канал может отредактировать его. */
  replaceMessageId?: string;
  /** Кнопки/действия, прикрепляемые к сообщению (если канал умеет). */
  buttons?: ChannelButton[];
}

/** Результат доставки. */
export interface DeliveryResult {
  /** id отправленного сообщения в канале — для последующих правок. */
  messageId?: string;
  /** Фактически доставленный текст (канал мог обрезать). */
  content?: string;
}

/** Кнопка/действие, прикрепляемое к сообщению (инлайн-кнопки, клавиатура). */
export interface ChannelButton {
  /** Идентификатор действия (callback-данные). */
  id: string;
  /** Подпись кнопки. */
  label: string;
  /** URL вместо callback (кнопка-ссылка). */
  url?: string;
}

/** Запрос правки ранее отправленного сообщения. */
export interface EditRequest {
  route: SessionRoute;
  /** Идентификатор сообщения в канале (из `DeliveryResult.messageId`). */
  messageId: string;
  /** Новый текст. */
  content: string;
  /** Кнопки (если канал умеет). */
  buttons?: ChannelButton[];
}

/** Запрос удаления ранее отправленного сообщения. */
export interface DeleteRequest {
  route: SessionRoute;
  messageId: string;
}

/** Запрос действия в чате, не связанного с сообщением. */
export interface ActionRequest {
  route: SessionRoute;
  /** Тип действия (`typing` — индикатор набора). */
  type: string;
  /** Полезная нагрузка действия (для канала). */
  payload?: Record<string, unknown>;
}

/** Запрос отметки «прочитано». */
export interface MarkReadRequest {
  route: SessionRoute;
  /** Идентификатор входящего сообщения (канал помечает конкретное сообщение). */
  inboundMessageId?: string;
}

/** Служебное уведомление каналу (код линковки, отказ). */
export interface NoticeRequest {
  /** Адресат уведомления в канале. */
  target: JsonValue;
  text: string;
  /** Код линковки (claim-flow ADR-089). */
  claimCode?: string;
}
