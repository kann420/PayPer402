import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { parseInline, parseMarkdown, renderMarkdown } from './markdown-lite';

const html = (source: string) => renderToStaticMarkup(renderMarkdown(source));

describe('inline marks', () => {
  it('parses bold, italic, code and links', () => {
    expect(parseInline('a **b** *c* _d_ `e` [f](https://x.example)')).toEqual([
      { type: 'text', text: 'a ' },
      { type: 'bold', children: [{ type: 'text', text: 'b' }] },
      { type: 'text', text: ' ' },
      { type: 'italic', children: [{ type: 'text', text: 'c' }] },
      { type: 'text', text: ' ' },
      { type: 'italic', children: [{ type: 'text', text: 'd' }] },
      { type: 'text', text: ' ' },
      { type: 'code', text: 'e' },
      { type: 'text', text: ' f' },
    ]);
  });

  it('handles bold with a colon inside, as in "**Giá:** 2,45 USD"', () => {
    expect(html('**Giá:** 2,45 USD/lb')).toBe('<div class="md"><p><strong>Giá:</strong> 2,45 USD/lb</p></div>');
    expect(html('**Price:**2.45')).toBe('<div class="md"><p><strong>Price:</strong>2.45</p></div>');
  });

  it('nests italic and code inside bold', () => {
    expect(html('**a *b* `c`**')).toBe('<div class="md"><p><strong>a <em>b</em> <code class="md-code">c</code></strong></p></div>');
  });

  it('leaves unmatched marks, snake_case and lone asterisks literal', () => {
    expect(html('2 * 3 = 6, **open, *half, file_name_here')).toBe('<div class="md"><p>2 * 3 = 6, **open, *half, file_name_here</p></div>');
    expect(html('** spaced **')).toBe('<div class="md"><p>** spaced **</p></div>');
  });

  it('keeps code content literal, marks included', () => {
    expect(html('`**not bold**`')).toBe('<div class="md"><p><code class="md-code">**not bold**</code></p></div>');
  });
});

describe('blocks', () => {
  it('splits paragraphs on blank lines and keeps single line breaks', () => {
    expect(html('one\ntwo\n\nthree')).toBe('<div class="md"><p>one<br/>two</p><p>three</p></div>');
  });

  it('renders headings as bold lines', () => {
    expect(html('# Title\n## Sub ##\n### Small')).toBe(
      '<div class="md"><p class="md-heading"><strong>Title</strong></p><p class="md-heading"><strong>Sub</strong></p><p class="md-heading"><strong>Small</strong></p></div>',
    );
    expect(parseMarkdown('#### four')[0]).toEqual({ type: 'paragraph', lines: [[{ type: 'text', text: '#### four' }]] });
  });

  it('renders bullet lists with - and *, and numbered lists with their start', () => {
    expect(html('- a\n* b')).toBe('<div class="md"><ul><li>a</li><li>b</li></ul></div>');
    expect(html('1. a\n2. b')).toBe('<div class="md"><ol><li>a</li><li>b</li></ol></div>');
    expect(html('3. c\n4. d')).toBe('<div class="md"><ol start="3"><li>c</li><li>d</li></ol></div>');
  });

  it('renders the shape of a real answer: bold labels, a list with nested-looking items', () => {
    const answer = [
      '**Bản tin cà phê hôm nay**',
      '',
      '**Giá:** Cà phê KC 2,45 USD/lb (+1,2%).',
      '**Tin chính:**',
      '- **Mưa ở Tây Nguyên** làm chậm thu hoạch',
      '  - Sản lượng có thể giảm *khoảng 5%*',
      '- Xuất khẩu tăng',
      '',
      '_Dữ liệu mô phỏng._',
    ].join('\n');
    expect(html(answer)).toBe(
      '<div class="md">' +
        '<p><strong>Bản tin cà phê hôm nay</strong></p>' +
        '<p><strong>Giá:</strong> Cà phê KC 2,45 USD/lb (+1,2%).<br/><strong>Tin chính:</strong></p>' +
        '<ul><li><strong>Mưa ở Tây Nguyên</strong> làm chậm thu hoạch</li><li>Sản lượng có thể giảm <em>khoảng 5%</em></li><li>Xuất khẩu tăng</li></ul>' +
        '<p><em>Dữ liệu mô phỏng.</em></p>' +
        '</div>',
    );
  });

  it('keeps HTML and script tags as literal text', () => {
    const out = html('<script>alert(1)</script> **<b>x</b>** [click](javascript:alert(1))');
    expect(out).toBe('<div class="md"><p>&lt;script&gt;alert(1)&lt;/script&gt; <strong>&lt;b&gt;x&lt;/b&gt;</strong> click</p></div>');
    expect(out).not.toContain('<script');
    expect(out).not.toContain('href');
  });

  it('renders nothing but the wrapper for empty text, and handles CRLF', () => {
    expect(html('')).toBe('<div class="md"></div>');
    expect(html('a\r\nb')).toBe('<div class="md"><p>a<br/>b</p></div>');
  });
});
