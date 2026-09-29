import { describe, expect, it } from 'vitest';
import { countRenderCost, parseMarkdownBlocks, takeWithinRenderBudget, type MarkdownBlock } from './markdown-blocks';

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
    { name: 'a mention marker line as ordinary text', markdown: '--- @table:t-1 → Ship it ---', expected: [{ type: 'paragraph', segments: [text('--- @table:t-1 → Ship it ---')] }] },
    { name: 'a mentioned note envelope as ordinary text', markdown: '--- from note @note:abc (Title, 2026-01-01) ---\n# Inner\n--- end @note:abc ---', expected: [
      { type: 'paragraph', segments: [text('--- from note @note:abc (Title, 2026-01-01) ---')] },
      { type: 'heading', level: 1, segments: [text('Inner')] },
      { type: 'paragraph', segments: [text('--- end @note:abc ---')] },
    ] },
  ])('parses $name', ({ markdown, expected }) => {
    expect(parseMarkdownBlocks(markdown)).toEqual(expected);
  });

  it('keeps two inline code spans written back to back as two chips', () => {
    const [paragraph] = parseMarkdownBlocks('`a``b`');

    expect(paragraph).toEqual({ type: 'paragraph', segments: [code('a'), code('b')] });
  });

  it('merges the plain text left around empty code spans into one segment', () => {
    const oneMebibyteOfEmptySpans = 'a``'.repeat(349_525);

    const [block] = parseMarkdownBlocks(oneMebibyteOfEmptySpans);

    expect(block).toEqual({ type: 'paragraph', segments: [text('a'.repeat(349_525))] });
  });

  it.each(['\r', '\u2028', '\u2029'])('splits lines on %j like on a newline', (lineBreak) => {
    const blocks = parseMarkdownBlocks(`# Title${lineBreak}- one${lineBreak}- two`);

    expect(blocks).toEqual([
      { type: 'heading', level: 1, segments: [text('Title')] },
      { type: 'list', items: [[text('one')], [text('two')]] },
    ]);
  });

  it.each([
    { name: 'a heading marker', prefix: '#' },
    { name: 'a dash bullet', prefix: '-' },
    { name: 'a star bullet', prefix: '*' },
  ])('parses $name followed by a huge run of spaces and a line separator in linear time', ({ prefix }) => {
    const startedAt = performance.now();

    parseMarkdownBlocks(`${prefix}${' '.repeat(200_000)}\u2028x`);

    expect(performance.now() - startedAt).toBeLessThan(1000);
  });
});

describe('takeWithinRenderBudget', () => {
  it('keeps one list of three items when the first bullet is empty', () => {
    const blocks = takeWithinRenderBudget(parseMarkdownBlocks('- \n- b\n- c'), 2000);

    expect(blocks).toMatchObject([{ type: 'list', items: [expect.anything(), expect.anything(), expect.anything()] }]);
  });

  it('drops a list item that would keep only an empty bullet', () => {
    const blocks = parseMarkdownBlocks('- `x`');

    const kept = takeWithinRenderBudget(blocks, 2);

    expect(kept).toEqual([]);
  });

  describe('code fences', () => {
    const fenceOf = (lineCount: number) => `\`\`\`\n${'x\n'.repeat(lineCount)}\`\`\``;

    it('charges each line of a fence in the budget', () => {
      const blocks = parseMarkdownBlocks(fenceOf(3000));

      expect(countRenderCost(blocks)).toBe(3001);
    });

    it('keeps only the first lines of a fence that exceeds the budget', () => {
      const blocks = parseMarkdownBlocks(fenceOf(3000));

      const kept = takeWithinRenderBudget(blocks, 2000);

      expect(kept).toMatchObject([{ type: 'code' }]);
      expect(kept[0]).toMatchObject({ text: 'x\n'.repeat(1998) + 'x' });
      expect(countRenderCost(kept)).toBe(2000);
    });

    it('a single-line fence costs two nodes however long the line is', () => {
      const blocks = parseMarkdownBlocks(`\`\`\`\n${'x'.repeat(1_000_000)}\n\`\`\``);

      expect(countRenderCost(blocks)).toBe(2);
    });

    it('drops a fence whose first line does not fit', () => {
      const kept = takeWithinRenderBudget(parseMarkdownBlocks(fenceOf(3)), 1);

      expect(kept).toEqual([]);
    });

    it('an empty fence costs one node', () => {
      expect(countRenderCost(parseMarkdownBlocks('```\n```'))).toBe(1);
    });
  });
});
