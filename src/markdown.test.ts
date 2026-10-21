import { describe, expect, it } from 'vitest';

import { chunkText, escapeHtml, markdownToHtml } from './markdown.js';

/** Считает открывающие и закрывающие теги указанного имени. */
function countTag(html: string, name: string): { open: number; close: number } {
  return {
    open: (html.match(new RegExp(`<${name}[\\s>]`, 'g')) ?? []).length,
    close: (html.match(new RegExp(`</${name}>`, 'g')) ?? []).length,
  };
}

describe('markdownToHtml', () => {
  it('экранирует HTML-инъекции', () => {
    expect(markdownToHtml('<script>alert(1)</script>')).toBe(
      '&lt;script&gt;alert(1)&lt;/script&gt;',
    );
  });

  it('рендерит жирный, курсив, зачёркнутый и инлайн-код', () => {
    expect(markdownToHtml('**жирный** и *курсив* ~~зачёркнутый~~ `код`')).toBe(
      '<b>жирный</b> и <i>курсив</i> <s>зачёркнутый</s> <code>код</code>',
    );
    expect(markdownToHtml('__тоже жирный__ и _курсив_')).toBe('<b>тоже жирный</b> и <i>курсив</i>');
  });

  it('рендерит ссылки с экранированием href', () => {
    expect(markdownToHtml('[Synth](https://example.com/a?x=1&y=2)')).toBe(
      '<a href="https://example.com/a?x=1&amp;y=2">Synth</a>',
    );
    expect(markdownToHtml('[t](https://ex.com/a"b)')).toBe(
      '<a href="https://ex.com/a&quot;b">t</a>',
    );
  });

  it('рендерит заголовки, цитаты, горизонтальные линии и списки', () => {
    expect(markdownToHtml('## Заголовок')).toBe('<b>Заголовок</b>');
    expect(markdownToHtml('> цитата\n> вторая')).toBe('<blockquote>цитата\nвторая</blockquote>');
    expect(markdownToHtml('---')).toBe('———');
    expect(markdownToHtml('- один\n- два')).toBe('• один\n• два');
  });

  it('рендерит фенсед-блок без языка и с языком', () => {
    expect(markdownToHtml('```\nconst a = 1;\n```')).toBe('<pre>const a = 1;</pre>');
    expect(markdownToHtml('```ts\nconst a = 1;\n```')).toBe(
      '<pre><code class="language-ts">const a = 1;</code></pre>',
    );
  });

  it('незакрытые маркеры остаются литералами (стриминг-толерантность)', () => {
    expect(markdownToHtml('**незакрыт')).toBe('**незакрыт');
    expect(markdownToHtml('*курсив без конца')).toBe('*курсив без конца');
    expect(markdownToHtml('текст `код без конца')).toBe('текст `код без конца');
    // Баланс тегов: ни одного открытого тега без закрытия.
    expect(markdownToHtml('**bold** и **незакрыт')).toBe('<b>bold</b> и **незакрыт');
  });

  it('жирный может охватывать несколько строк', () => {
    expect(markdownToHtml('**начало\nконец**')).toBe('<b>начало\nконец</b>');
  });

  it('экранирует спецсимволы внутри кода, но не трогает разметку', () => {
    expect(markdownToHtml('`a && b < c`')).toBe('<code>a &amp;&amp; b &lt; c</code>');
  });

  it('не трогает идентификаторы с подчёркиваниями', () => {
    expect(markdownToHtml('snake_case_name')).toBe('snake_case_name');
  });

  it('вывод сбалансирован по тегам', () => {
    const html = markdownToHtml('**жирный** *курсив* `код` [ссылка](https://ex.com)');
    for (const tag of ['b', 'i', 'code', 'a']) {
      expect(countTag(html, tag)).toEqual({ open: 1, close: 1 });
    }
  });
});

describe('escapeHtml', () => {
  it('экранирует спецсимволы', () => {
    expect(escapeHtml('<b>&</b>')).toBe('&lt;b&gt;&amp;&lt;/b&gt;');
  });
});

describe('chunkText', () => {
  it('не режет короткий текст', () => {
    expect(chunkText('привет')).toEqual(['привет']);
  });

  it('режет длинный текст по границам строк в пределах лимита', () => {
    const line = 'x'.repeat(10);
    const text = Array.from({ length: 5 }, () => line).join('\n'); // 54 символа
    const chunks = chunkText(text, 20);
    expect(chunks.every((chunk) => chunk.length <= 20)).toBe(true);
    expect(chunks.join('\n')).toBe(text);
  });

  it('режет текст без переводов строк ровно по лимиту', () => {
    const chunks = chunkText('a'.repeat(25), 10);
    expect(chunks).toEqual(['a'.repeat(10), 'a'.repeat(10), 'a'.repeat(5)]);
  });
});
