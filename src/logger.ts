/**
 * Логирование шлюза (ADR-087, ADR-103).
 *
 * Инвариант: логи шлюза имеют префикс `[gateway]`, в мультитенантном режиме —
 * `[gateway][<tenantId>]`. **Секреты в логах не печатаются**: для них
 * логируется только факт «задан/не задан» (см. {@link describeSecret}).
 */

/** Функция вывода логовой строки (по умолчанию — stdout). */
export type LogSink = (message: string) => void;

/** Базовый префикс логов шлюза. */
export const GATEWAY_LOG_PREFIX = '[gateway]';

/** Префикс логов мультитенантного режима: `[gateway][<tenantId>]`. */
export function tenantLogPrefix(tenantId: string): string {
  return `${GATEWAY_LOG_PREFIX}[${tenantId}]`;
}

/** Применяет префикс к сообщению, не дублируя уже присутствующий. */
function applyPrefix(prefix: string, message: string): string {
  if (message.startsWith(prefix)) return message;
  // Сообщение уже начато базовым префиксом — заменяем его тенантным.
  if (message.startsWith(GATEWAY_LOG_PREFIX)) {
    return `${prefix}${message.slice(GATEWAY_LOG_PREFIX.length)}`;
  }
  return `${prefix} ${message}`;
}

/** Стандартный приёмник логов — stdout. */
const defaultSink: LogSink = (message: string): void => {
  console.log(message);
};

/**
 * Создаёт логгер с заданным префиксом.
 *
 * Префикс подставляется автоматически: сообщение без префикса получает его
 * с пробелом (`[gateway] текст`), сообщение, начатое базовым префиксом,
 * переиспользуется как есть (`[gateway][dev] текст`).
 */
export function createLogger(
  prefix: string,
  sink: LogSink = defaultSink,
): (message: string) => void {
  const normalized = prefix.trim() || GATEWAY_LOG_PREFIX;
  return (message: string): void => {
    sink(applyPrefix(normalized, message));
  };
}

/** Логгер тенанта: префикс `[gateway][<tenantId>]`. */
export function createTenantLogger(
  tenantId: string,
  sink: LogSink = defaultSink,
): (message: string) => void {
  return createLogger(tenantLogPrefix(tenantId), sink);
}

/**
 * Описание наличия секрета — **только факт «задан/не задан»**, без значения.
 * Единственный допустимый способ упомянуть секрет в логе.
 */
export function describeSecret(name: string, value: string | undefined | null): string {
  const present = typeof value === 'string' && value.trim().length > 0;
  return `${name}: ${present ? 'задан' : 'не задан'}`;
}
