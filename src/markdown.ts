/**
 * Конвертер Markdown → HTML общего назначения.
 *
 * Общая часть конвертера Telegram-шлюза (ADR-103): покрывает подмножество
 * Markdown, достаточное для ответов агента — фенсед-блоки и инлайн-код,
 * жирный/курсив/зачёркнутый, ссылки, заголовки, цитаты, горизонтальные линии и
 * маркеры списков.
 *
 * Главное свойство — **толерантность к стримингу**: незакрытые маркеры остаются
 * литералами, а вывод всегда сбалансирован по тегам (любой открытый тег закрыт).
 * Поэтому функция безопасна для инкрементального live-превью.
 *
 * Чанкинг **HTML**-разметки и её обрезка — задача канала (в Telegram это
 * балансировка тегов Telegram-HTML), здесь только обычный текст.
 */

/** Дефолтный лимит длины текстового сообщения (символов). */
export const DEFAULT_TEXT_LIMIT = 4096;

/** Открывающий фенсед-блок: ```` ```lang ```` (язык необязателен). */
const FENCE_OPEN_RE = /^[ \t]*```[ \t]*([A-Za-z0-9_+.-]*)[ \t]*$/;
/** Закрывающий фенсед-блок: ```` ``` ````. */
const FENCE_CLOSE_RE = /^[ \t]*```[ \t]*$/;
/** Заголовок ATX: `# …` … `###### …`. */
const HEADING_RE = /^(#{1,6})[ \t]+(.+)$/;
/** Цитата: строка, начинающаяся с `>` (после экранирования — `&gt;`). */
const QUOTE_RE = /^&gt;[ \t]?/;
/** Горизонтальная линия: `---`, `***` или `___` (возможно с отступами). */
const HR_RE = /^[ \t]*(?:-{3,}|\*{3,}|_{3,})[ \t]*$/;
/** Маркер ненумерованного списка: `- `, `* `, `+ `. */
const LIST_RE = /^([ \t]*)[-*+][ \t]+/;

/** Экранирует `&`, `<`, `>` для HTML. */
export function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Экранирует кавычки в `href` (URL уже прошёл общий escape). */
function escapeHref(url: string): string {
  return url.replace(/"/g, '&quot;');
}

/** Является ли символ «пробельным» для проверки границ маркеров. */
function isSpace(char: string | undefined): boolean {
  return char === undefined || /\s/.test(char);
}

/** Является ли символ словесным (`[A-Za-z0-9_]`) — защита `_`-маркеров. */
function isWordChar(char: string | undefined): boolean {
  return char !== undefined && /[A-Za-z0-9_]/.test(char);
}

/**
 * Обрабатывает инлайн-разметку в уже экранированном тексте. Рекурсивно
 * применяется к содержимому найденных пар, поэтому вывод всегда сбалансирован.
 */
function renderInline(text: string): string {
  let out = '';
  let i = 0;
  const len = text.length;
  while (i < len) {
    const char = text[i]!;

    // Инлайн-код: `code` (не переносим через строку — как в Markdown).
    if (char === '`') {
      const end = text.indexOf('`', i + 1);
      if (end > i + 1 && !text.slice(i + 1, end).includes('\n')) {
        out += `<code>${text.slice(i + 1, end)}</code>`;
        i = end + 1;
        continue;
      }
    }

    // Ссылка: [text](url).
    if (char === '[') {
      const match = /^\[([^\]\n]*)\]\(([^)\s]+)\)/.exec(text.slice(i));
      if (match) {
        out += `<a href="${escapeHref(match[2]!)}">${renderInline(match[1]!)}</a>`;
        i += match[0].length;
        continue;
      }
    }

    // Зачёркнутый: ~~text~~.
    if (char === '~' && text[i + 1] === '~') {
      const end = text.indexOf('~~', i + 2);
      if (end > i + 2) {
        out += `<s>${renderInline(text.slice(i + 2, end))}</s>`;
        i = end + 2;
        continue;
      }
    }

    // Жирный: **text** либо __text__.
    if (char === '*' && text[i + 1] === '*') {
      const end = text.indexOf('**', i + 2);
      if (end > i + 2) {
        out += `<b>${renderInline(text.slice(i + 2, end))}</b>`;
        i = end + 2;
        continue;
      }
    }
    if (char === '_' && text[i + 1] === '_' && !isWordChar(text[i - 1])) {
      const end = text.indexOf('__', i + 2);
      if (end > i + 2 && !isWordChar(text[end + 2])) {
        out += `<b>${renderInline(text.slice(i + 2, end))}</b>`;
        i = end + 2;
        continue;
      }
    }

    // Курсив: *text* (маркер не должен примыкать к пробелам).
    if (char === '*' && text[i + 1] !== '*' && !isSpace(text[i + 1])) {
      const end = text.indexOf('*', i + 1);
      if (end > i + 1 && !isSpace(text[end - 1]) && text[end + 1] !== '*') {
        out += `<i>${renderInline(text.slice(i + 1, end))}</i>`;
        i = end + 1;
        continue;
      }
    }
    // Курсив: _text_ (защита от идентификаторов вида snake_case).
    if (char === '_' && text[i + 1] !== '_' && !isSpace(text[i + 1]) && !isWordChar(text[i - 1])) {
      const end = text.indexOf('_', i + 1);
      if (end > i + 1 && !isSpace(text[end - 1]) && !isWordChar(text[end + 1])) {
        out += `<i>${renderInline(text.slice(i + 1, end))}</i>`;
        i = end + 1;
        continue;
      }
    }

    out += char;
    i += 1;
  }
  return out;
}

/**
 * Обрабатывает блок текста (без фенсед-кода): цитаты, заголовки, линии, списки.
 * Соседние «обычные» строки склеиваются в один буфер, чтобы инлайн-разметка
 * могла охватывать несколько строк.
 */
function renderBlock(text: string): string {
  const lines = text.split('\n');
  const out: string[] = [];
  let buffer: string[] = [];
  const flush = (): void => {
    if (buffer.length > 0) {
      out.push(renderInline(buffer.join('\n')));
      buffer = [];
    }
  };

  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;

    if (HR_RE.test(line)) {
      flush();
      out.push('———');
      i += 1;
      continue;
    }

    const heading = HEADING_RE.exec(line);
    if (heading) {
      flush();
      out.push(`<b>${renderInline(heading[2]!)}</b>`);
      i += 1;
      continue;
    }

    if (QUOTE_RE.test(line)) {
      flush();
      const quoted: string[] = [];
      while (i < lines.length && QUOTE_RE.test(lines[i]!)) {
        quoted.push(lines[i]!.replace(QUOTE_RE, ''));
        i += 1;
      }
      out.push(`<blockquote>${renderInline(quoted.join('\n'))}</blockquote>`);
      continue;
    }

    buffer.push(line.replace(LIST_RE, '$1• '));
    i += 1;
  }

  flush();
  return out.join('\n');
}

/**
 * Конвертирует Markdown в подмножество HTML. Сначала текст экранируется
 * (`&`, `<`, `>`), затем разбирается разметка — сгенерированные теги в
 * экранирование не попадают.
 */
export function markdownToHtml(md: string): string {
  const escaped = escapeHtml(md);
  const lines = escaped.split('\n');
  const out: string[] = [];
  let buffer: string[] = [];
  const flush = (): void => {
    if (buffer.length > 0) {
      out.push(renderBlock(buffer.join('\n')));
      buffer = [];
    }
  };

  let i = 0;
  while (i < lines.length) {
    const fence = FENCE_OPEN_RE.exec(lines[i]!);
    if (fence) {
      let end = i + 1;
      while (end < lines.length && !FENCE_CLOSE_RE.test(lines[end]!)) end += 1;
      // Незакрытый фенсед (стриминг) — обрабатываем как обычный текст.
      if (end < lines.length) {
        flush();
        const code = lines.slice(i + 1, end).join('\n');
        const lang = fence[1];
        out.push(
          lang ? `<pre><code class="language-${lang}">${code}</code></pre>` : `<pre>${code}</pre>`,
        );
        i = end + 1;
        continue;
      }
    }
    buffer.push(lines[i]!);
    i += 1;
  }
  flush();
  return out.join('\n');
}

/** Режет текст на сообщения не длиннее `limit`, предпочитая границы строк. */
export function chunkText(text: string, limit: number = DEFAULT_TEXT_LIMIT): string[] {
  if (text.length <= limit) return [text];
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > limit) {
    let cut = rest.lastIndexOf('\n', limit);
    if (cut <= 0) cut = limit;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n/, '');
  }
  if (rest.length > 0) chunks.push(rest);
  return chunks;
}
