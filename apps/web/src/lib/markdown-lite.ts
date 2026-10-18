/**
 * A small, safe Markdown subset for the live run's answer and spend explanation (design spec
 * §10.10). It builds React elements: no `dangerouslySetInnerHTML`, no dependency, and any HTML in
 * the text stays literal text (React escapes it).
 *
 * Supported: paragraphs, line breaks, `**bold**`, `*italic*` / `_italic_`, `` `code` ``, bullet
 * lists (`-`, `*`), numbered lists (`1.`), and headings `#` to `###` (bold lines). Links render as
 * their text. Anything else is literal. Nested list levels are flattened into one list.
 */
import { createElement, Fragment, type ReactNode } from 'react';

export type Inline =
  | { type: 'text'; text: string }
  | { type: 'code'; text: string }
  | { type: 'bold'; children: Inline[] }
  | { type: 'italic'; children: Inline[] };

export type Block =
  | { type: 'paragraph'; lines: Inline[][] }
  | { type: 'heading'; children: Inline[] }
  | { type: 'bullets'; items: Inline[][] }
  | { type: 'numbered'; start: number; items: Inline[][] };

const HEADING = /^\s{0,3}#{1,3}\s+(.*?)\s*#*\s*$/;
const BULLET = /^\s*[-*]\s+(.*)$/;
const NUMBERED = /^\s*(\d{1,9})[.)]\s+(.*)$/;

const isWordChar = (ch: string | undefined) => ch !== undefined && /[\p{L}\p{N}]/u.test(ch);

function pushText(out: Inline[], text: string): void {
  if (text === '') return;
  const last = out.at(-1);
  if (last?.type === 'text') last.text += text;
  else out.push({ type: 'text', text });
}

/** Inline Markdown to nodes. Unclosed or unmatched marks stay literal. */
export function parseInline(source: string, depth = 0): Inline[] {
  const out: Inline[] = [];
  let i = 0;
  while (i < source.length) {
    const rest = source.slice(i);
    const ch = source[i];

    if (ch === '`') {
      const m = /^`([^`\n]+)`/.exec(rest);
      if (m) {
        out.push({ type: 'code', text: m[1] as string });
        i += m[0].length;
        continue;
      }
    }
    if (ch === '[' && depth < 4) {
      // The URL may hold one level of balanced parentheses; it is dropped either way.
      const m = /^\[([^\]\n]+)\]\(((?:[^()\s]|\([^()\s]*\))*)\)/.exec(rest);
      if (m) {
        for (const node of parseInline(m[1] as string, depth + 1)) {
          if (node.type === 'text') pushText(out, node.text);
          else out.push(node);
        }
        i += m[0].length;
        continue;
      }
    }
    if (rest.startsWith('**') && depth < 4) {
      const m = /^\*\*(?!\s)([^\n]+?)(?<!\s)\*\*/.exec(rest);
      if (m) {
        out.push({ type: 'bold', children: parseInline(m[1] as string, depth + 1) });
        i += m[0].length;
        continue;
      }
    }
    if ((ch === '*' || ch === '_') && depth < 4 && !(ch === '*' && rest.startsWith('**'))) {
      const mark = ch === '*' ? '\\*' : '_';
      const m = new RegExp(`^${mark}(?!\\s)([^\\n${ch === '*' ? '*' : '_'}]+?)(?<!\\s)${mark}`).exec(rest);
      // An underscore inside a word (snake_case) is not emphasis.
      const boundaryOk = ch === '*' || (!isWordChar(source[i - 1]) && !isWordChar(source[i + (m?.[0].length ?? 0)]));
      if (m && boundaryOk) {
        out.push({ type: 'italic', children: parseInline(m[1] as string, depth + 1) });
        i += m[0].length;
        continue;
      }
    }
    pushText(out, ch as string);
    i += 1;
  }
  return out;
}

/** Markdown text to blocks. */
export function parseMarkdown(source: string): Block[] {
  const blocks: Block[] = [];
  let paragraph: Inline[][] | undefined;
  const closeParagraph = () => {
    if (paragraph !== undefined && paragraph.length > 0) blocks.push({ type: 'paragraph', lines: paragraph });
    paragraph = undefined;
  };

  for (const raw of source.replace(/\r\n?/g, '\n').split('\n')) {
    const line = raw.replace(/\s+$/, '');
    if (line.trim() === '') {
      closeParagraph();
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      closeParagraph();
      blocks.push({ type: 'heading', children: parseInline(heading[1] as string) });
      continue;
    }
    // "**Bold:** text" starts with "**", which is not a "* " bullet.
    const bullet = /^\s*\*\*/.test(line) ? null : BULLET.exec(line);
    if (bullet) {
      closeParagraph();
      const last = blocks.at(-1);
      const item = parseInline(bullet[1] as string);
      if (last?.type === 'bullets') last.items.push(item);
      else blocks.push({ type: 'bullets', items: [item] });
      continue;
    }
    const numbered = NUMBERED.exec(line);
    if (numbered) {
      closeParagraph();
      const last = blocks.at(-1);
      const item = parseInline(numbered[2] as string);
      if (last?.type === 'numbered') last.items.push(item);
      else blocks.push({ type: 'numbered', start: Number(numbered[1]), items: [item] });
      continue;
    }
    paragraph ??= [];
    paragraph.push(parseInline(line.trim()));
  }
  closeParagraph();
  return blocks;
}

function renderInline(nodes: Inline[], keyPrefix: string): ReactNode[] {
  return nodes.map((node, index) => {
    const key = `${keyPrefix}.${index}`;
    switch (node.type) {
      case 'text':
        return createElement(Fragment, { key }, node.text);
      case 'code':
        return createElement('code', { key, className: 'md-code' }, node.text);
      case 'bold':
        return createElement('strong', { key }, ...renderInline(node.children, key));
      case 'italic':
        return createElement('em', { key }, ...renderInline(node.children, key));
    }
  });
}

/** The blocks as React elements; class names are styled by `.md` in globals.css. */
export function renderMarkdown(source: string): ReactNode {
  const blocks = parseMarkdown(source);
  return createElement(
    'div',
    { className: 'md' },
    ...blocks.map((block, index) => {
      const key = `b${index}`;
      switch (block.type) {
        case 'heading':
          return createElement('p', { key, className: 'md-heading' }, createElement('strong', null, ...renderInline(block.children, key)));
        case 'paragraph':
          return createElement(
            'p',
            { key },
            ...block.lines.flatMap((line, n) => {
              const parts = renderInline(line, `${key}.${n}`);
              return n === 0 ? parts : [createElement('br', { key: `${key}.br${n}` }), ...parts];
            }),
          );
        case 'bullets':
          return createElement('ul', { key }, ...block.items.map((item, n) => createElement('li', { key: `${key}.${n}` }, ...renderInline(item, `${key}.${n}`))));
        case 'numbered':
          return createElement(
            'ol',
            { key, ...(block.start === 1 ? {} : { start: block.start }) },
            ...block.items.map((item, n) => createElement('li', { key: `${key}.${n}` }, ...renderInline(item, `${key}.${n}`))),
          );
      }
    }),
  );
}
