import { describe, expect, it } from 'vitest';
import { parseMarkdownBlocks, type MarkdownBlock } from './markdown-blocks';

const text = (value: string) => ({ text: value, isCode: false });
const code = (value: string) => ({ text: value, isCode: true });

describe('parseMarkdownBlocks', () => {
  it.each<{ name: string; markdown: string; expected: MarkdownBlock[] }>([
    { name: 'a level 1 heading', markdown: '# Title', expected: [{ type: 'heading', level: 1, segments: [text('Title')] }] },
    { name: 'a level 3 heading', markdown: '### Deep', expected: [{ type: 'heading', level: 3, segments: [text('Deep')] }] },
    { name: 'a level 4 heading is a paragraph', markdown: '#### Too deep', expected: [{ type: 'paragraph', segments: [text('#### Too deep')] }] },
    { name: 'a dash list', markdown: '- one\n- two', expected: [{ type: 'list', items: [[text('one')], [text('two')]] }] },
    { name: 'a star list', markdown: '* one\n* two', expected: [{ type: 'list', items: [[text('one')], [text('two')]] }] },
    { name: 'a paragraph over several lines', markdown: 'first\nsecond', expected: [{ type: 'paragraph', segments: [text('first second')] }] },
    { name: 'two paragraphs separated by a blank line', markdown: 'first\n\nsecond', expected: [
      { type: 'paragraph', segments: [text('first')] },
      { type: 'paragraph', segments: [text('second')] },
    ] },
    { name: 'a fenced code block', markdown: '```\nconst a = 1\n```', expected: [{ type: 'code', text: 'const a = 1' }] },
    { name: 'a fence that is never closed swallows the rest of the note', markdown: 'before\n\n```\nconst a = 1\nmore', expected: [
      { type: 'paragraph', segments: [text('before')] },
      { type: 'code', text: 'const a = 1\nmore' },
    ] },
    { name: 'inline code', markdown: 'use `pnpm` here', expected: [{ type: 'paragraph', segments: [text('use '), code('pnpm'), text(' here')] }] },
    { name: 'a lone backtick stays text', markdown: 'price is 5` and more', expected: [{ type: 'paragraph', segments: [text('price is 5` and more')] }] },
    { name: 'a third backtick stays text', markdown: '`a` and `b` and ` c', expected: [
      { type: 'paragraph', segments: [code('a'), text(' and '), code('b'), text(' and ` c')] },
    ] },
    { name: 'a blank-only body has no block', markdown: '  \n\n   \n', expected: [] },
    { name: 'an empty body has no block', markdown: '', expected: [] },
    { name: 'Windows line endings around a heading and a list', markdown: '# Title\r\n\r\n- one\r\n- two\r\n', expected: [
      { type: 'heading', level: 1, segments: [text('Title')] },
      { type: 'list', items: [[text('one')], [text('two')]] },
    ] },
    { name: 'Windows line endings inside a fenced block', markdown: '```\r\na\r\nb\r\n```', expected: [{ type: 'code', text: 'a\nb' }] },
    { name: 'a mention line', markdown: '--- @table:t-1 → Ship it ---', expected: [{ type: 'mention-line', kind: 'table', id: 't-1', text: 'Ship it' }] },
    { name: 'a mentioned note with its own body', markdown: '--- from note @note:abc (Title, 2026-01-01) ---\n# Inner\n--- end @note:abc ---', expected: [
      { type: 'mention-note', kind: 'note', id: 'abc', title: 'Title', blocks: [{ type: 'heading', level: 1, segments: [text('Inner')] }] },
    ] },
    { name: 'a mentioned note that is never closed runs to the end', markdown: '--- from note @note:abc (Title, 2026-01-01) ---\ninner text', expected: [
      { type: 'mention-note', kind: 'note', id: 'abc', title: 'Title', blocks: [{ type: 'paragraph', segments: [text('inner text')] }] },
    ] },
    { name: 'mentioned notes nested in a mentioned note', markdown: [
      '--- from note @note:outer (Outer, d) ---',
      '--- from note @note:inner (Inner, d) ---',
      'deep',
      '--- end @note:inner ---',
      '--- end @note:outer ---',
    ].join('\n'), expected: [
      { type: 'mention-note', kind: 'note', id: 'outer', title: 'Outer', blocks: [
        { type: 'mention-note', kind: 'note', id: 'inner', title: 'Inner', blocks: [{ type: 'paragraph', segments: [text('deep')] }] },
      ] },
    ] },
  ])('parses $name', ({ markdown, expected }) => {
    expect(parseMarkdownBlocks(markdown)).toEqual(expected);
  });

  it('parses three thousand nested mentioned notes without overflowing the stack', () => {
    const opens = Array.from({ length: 3000 }, (_, index) => `--- from note @note:n${index} (t, d) ---`);
    const closes = Array.from({ length: 3000 }, (_, index) => `--- end @note:n${2999 - index} ---`);

    const blocks = parseMarkdownBlocks([...opens, 'x', ...closes].join('\n'));

    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ type: 'mention-note', id: 'n0' });
  });
});
