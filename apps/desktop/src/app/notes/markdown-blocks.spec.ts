import { describe, expect, it } from 'vitest';
import { countRenderCost, parseMarkdownBlocks, takeWithinRenderBudget, type MarkdownBlock } from './markdown-blocks';

const text = (value: string) => ({ text: value, isCode: false, isBold: false });
const code = (value: string) => ({ text: value, isCode: true, isBold: false });
const bold = (value: string) => ({ text: value, isCode: false, isBold: true });

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
    { name: 'bold inside a paragraph', markdown: 'a **b** c', expected: [{ type: 'paragraph', segments: [text('a '), bold('b'), text(' c')] }] },
    { name: 'bold inside a heading', markdown: '# **Title** now', expected: [{ type: 'heading', level: 1, segments: [bold('Title'), text(' now')] }] },
    { name: 'bold inside a bullet item', markdown: '- **b** x', expected: [{ type: 'list', items: [[bold('b'), text(' x')]] }] },
    { name: 'bold inside a numbered item', markdown: '1. **b** x', expected: [{ type: 'ordered-list', start: 1, items: [[bold('b'), text(' x')]] }] },
    { name: 'an unclosed bold marker stays text', markdown: 'a **b', expected: [{ type: 'paragraph', segments: [text('a **b')] }] },
    { name: 'a third bold marker stays text', markdown: 'a **b** c ** d', expected: [{ type: 'paragraph', segments: [text('a '), bold('b'), text(' c ** d')] }] },
    { name: 'an empty bold pair between words stays literal', markdown: 'a****b', expected: [{ type: 'paragraph', segments: [text('a****b')] }] },
    { name: 'an empty bold pair alone stays literal', markdown: '****', expected: [{ type: 'paragraph', segments: [text('****')] }] },
    { name: 'a bold pair holding only a space stays literal', markdown: '** **', expected: [{ type: 'paragraph', segments: [text('** **')] }] },
    { name: 'an empty bold pair next to real bold stays literal', markdown: '****a**b**', expected: [{ type: 'paragraph', segments: [text('****a'), bold('b')] }] },
    { name: 'bold markers inside inline code stay literal', markdown: '`**x**`', expected: [{ type: 'paragraph', segments: [code('**x**')] }] },
    { name: 'a numbered list', markdown: '1. one\n2. two', expected: [{ type: 'ordered-list', start: 1, items: [[text('one')], [text('two')]] }] },
    { name: 'a numbered list keeps its first number', markdown: '3. c\n4. d', expected: [{ type: 'ordered-list', start: 3, items: [[text('c')], [text('d')]] }] },
    { name: 'a numbered list whose items all repeat one number', markdown: '1. a\n1. b', expected: [{ type: 'ordered-list', start: 1, items: [[text('a')], [text('b')]] }] },
    { name: 'a parenthesis after the number is a paragraph', markdown: '1) one', expected: [{ type: 'paragraph', segments: [text('1) one')] }] },
    { name: 'a number without a space after the dot is a paragraph', markdown: '1.one', expected: [{ type: 'paragraph', segments: [text('1.one')] }] },
    { name: 'a number of ten digits is a paragraph', markdown: '1234567890. one', expected: [{ type: 'paragraph', segments: [text('1234567890. one')] }] },
    { name: 'a bullet list followed by a numbered list', markdown: '- a\n1. b', expected: [
      { type: 'list', items: [[text('a')]] },
      { type: 'ordered-list', start: 1, items: [[text('b')]] },
    ] },
    { name: 'a quote over several lines', markdown: '> hello\n> world', expected: [{ type: 'quote', blocks: [{ type: 'paragraph', segments: [text('hello world')] }] }] },
    { name: 'a quote marker without a space', markdown: '>hello', expected: [{ type: 'quote', blocks: [{ type: 'paragraph', segments: [text('hello')] }] }] },
    { name: 'an empty quote line separates two paragraphs of a quote', markdown: '> a\n>\n> b', expected: [
      { type: 'quote', blocks: [{ type: 'paragraph', segments: [text('a')] }, { type: 'paragraph', segments: [text('b')] }] },
    ] },
    { name: 'a list inside a quote', markdown: '> - a\n> - b', expected: [{ type: 'quote', blocks: [{ type: 'list', items: [[text('a')], [text('b')]] }] }] },
    { name: 'a numbered list inside a quote', markdown: '> 2. a', expected: [{ type: 'quote', blocks: [{ type: 'ordered-list', start: 2, items: [[text('a')]] }] }] },
    { name: 'a quote inside a quote', markdown: '> > deep', expected: [{ type: 'quote', blocks: [{ type: 'quote', blocks: [{ type: 'paragraph', segments: [text('deep')] }] }] }] },
    { name: 'quotes nested deeper than three levels keep their markers as text', markdown: '> > > > x', expected: [
      { type: 'quote', blocks: [{ type: 'quote', blocks: [{ type: 'quote', blocks: [{ type: 'paragraph', segments: [text('> x')] }] }] }] },
    ] },
    { name: 'a quote interrupts a paragraph', markdown: 'a\n> b', expected: [
      { type: 'paragraph', segments: [text('a')] },
      { type: 'quote', blocks: [{ type: 'paragraph', segments: [text('b')] }] },
    ] },
    { name: 'a line after a quote is not part of the quote', markdown: '> a\nb', expected: [
      { type: 'quote', blocks: [{ type: 'paragraph', segments: [text('a')] }] },
      { type: 'paragraph', segments: [text('b')] },
    ] },
    { name: 'a link stays literal text', markdown: '[a](https://x.test)', expected: [{ type: 'paragraph', segments: [text('[a](https://x.test)')] }] },
    { name: 'glob patterns in prose stay plain text', markdown: 'src/**/*.ts and docs/**/*.md', expected: [{ type: 'paragraph', segments: [text('src/**/*.ts and docs/**/*.md')] }] },
    { name: 'bold glued to the following word', markdown: '**bold**text', expected: [{ type: 'paragraph', segments: [bold('bold'), text('text')] }] },
    { name: 'bold inside a word, as CommonMark allows for double asterisks', markdown: 'snake**case**x', expected: [{ type: 'paragraph', segments: [text('snake'), bold('case'), text('x')] }] },
    { name: 'a power operator spaced on both sides stays literal', markdown: '2 ** 3 ** 4', expected: [{ type: 'paragraph', segments: [text('2 ** 3 ** 4')] }] },
    { name: 'a marker followed by a space cannot open bold', markdown: 'a ** b** c', expected: [{ type: 'paragraph', segments: [text('a ** b** c')] }] },
    { name: 'bold wrapped in parentheses', markdown: '(**b**)', expected: [{ type: 'paragraph', segments: [text('('), bold('b'), text(')')] }] },
    { name: 'a numbered list starting at 9 keeps 9', markdown: '9. a\n10. b', expected: [{ type: 'ordered-list', start: 9, items: [[text('a')], [text('b')]] }] },
    { name: 'a numbered list starting at 10 keeps 10', markdown: '10. x', expected: [{ type: 'ordered-list', start: 10, items: [[text('x')]] }] },
    { name: 'a quote marker strips a single space after a nested marker', markdown: '> >  x', expected: [
      { type: 'quote', blocks: [{ type: 'quote', blocks: [{ type: 'paragraph', segments: [text(' x')] }] }] },
    ] },
    { name: 'a quote marker strips one space and keeps the rest of the indentation', markdown: '>    x', expected: [
      { type: 'quote', blocks: [{ type: 'paragraph', segments: [text('   x')] }] },
    ] },
    { name: 'a numbered item interrupts a paragraph', markdown: 'a\n2. b', expected: [
      { type: 'paragraph', segments: [text('a')] },
      { type: 'ordered-list', start: 2, items: [[text('b')]] },
    ] },
    { name: 'a bullet interrupts a paragraph', markdown: 'a\n- b', expected: [
      { type: 'paragraph', segments: [text('a')] },
      { type: 'list', items: [[text('b')]] },
    ] },
    { name: 'a blank line splits two numbered lists', markdown: '1. a\n\n2. b', expected: [
      { type: 'ordered-list', start: 1, items: [[text('a')]] },
      { type: 'ordered-list', start: 2, items: [[text('b')]] },
    ] },
    { name: 'a blank line splits two bullet lists', markdown: '- a\n\n- b', expected: [
      { type: 'list', items: [[text('a')]] },
      { type: 'list', items: [[text('b')]] },
    ] },
    // Documented ceiling: no nested lists; an indented sub-bullet falls out of the list as a plain paragraph.
    { name: 'an indented sub-bullet is flattened into a paragraph', markdown: '- a\n  - b', expected: [
      { type: 'list', items: [[text('a')]] },
      { type: 'paragraph', segments: [text('  - b')] },
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

  it('keeps 500k empty bold pairs as one literal text segment', () => {
    const oneMillionBytesOfBoldMarkers = '**'.repeat(500_000);

    const [block] = parseMarkdownBlocks(oneMillionBytesOfBoldMarkers);

    expect(block).toEqual({ type: 'paragraph', segments: [text(oneMillionBytesOfBoldMarkers)] });
  });

  it.each([
    { name: 'zero-width space', codePoint: 0x200b },
    { name: 'zero-width non-joiner', codePoint: 0x200c },
    { name: 'zero-width joiner', codePoint: 0x200d },
    { name: 'word joiner', codePoint: 0x2060 },
    { name: 'byte order mark', codePoint: 0xfeff },
  ])('keeps a bold pair holding only a $name literal', ({ codePoint }) => {
    const invisible = String.fromCodePoint(codePoint);

    const [block] = parseMarkdownBlocks(`a **${invisible}${invisible}** b`);

    expect(block).toEqual({ type: 'paragraph', segments: [text(`a **${invisible}${invisible}** b`)] });
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

  // A quadratic scan on these one-mebibyte bodies takes minutes; the generous bound only fails on a super-linear parser.
  describe.each<{ name: string; markdown: string; blockType: MarkdownBlock['type'] }>([
    { name: 'a numbered marker followed by 200k spaces', markdown: `1.${' '.repeat(200_000)} x`, blockType: 'ordered-list' },
    { name: 'a quote marker followed by 200k spaces', markdown: `>${' '.repeat(200_000)} x`, blockType: 'quote' },
    { name: '200k quote lines', markdown: '> \n'.repeat(200_000), blockType: 'quote' },
    { name: '200k numbered items', markdown: '1. \n'.repeat(200_000), blockType: 'ordered-list' },
    { name: '500k bold markers', markdown: '**'.repeat(500_000), blockType: 'paragraph' },
    { name: 'a bold marker opened and never closed 250k times', markdown: 'a **b '.repeat(150_000), blockType: 'paragraph' },
    { name: '200k bold markers each followed by a lone asterisk', markdown: '**a*'.repeat(200_000), blockType: 'paragraph' },
    { name: '300k runs of three asterisks', markdown: '***'.repeat(300_000), blockType: 'paragraph' },
    { name: '100k runs of four asterisks around a letter', markdown: '****a****'.repeat(100_000), blockType: 'paragraph' },
    { name: '500k nested quote markers', markdown: '> '.repeat(500_000), blockType: 'quote' },
    { name: '200k quoted numbered items', markdown: '> 1. x\n'.repeat(150_000), blockType: 'quote' },
  ])('hostile body: $name', ({ markdown, blockType }) => {
    it('is parsed in linear time', () => {
      const startedAt = performance.now();

      const blocks = parseMarkdownBlocks(markdown);

      expect(performance.now() - startedAt).toBeLessThan(3000);
      expect(blocks.some((block) => block.type === blockType)).toBe(true);
    });
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

  describe('new node kinds', () => {
    it('a numbered list costs its element plus one node per item', () => {
      expect(countRenderCost(parseMarkdownBlocks('1. a\n2. b\n3. c'))).toBe(4);
    });

    it('each bold run costs one node', () => {
      expect(countRenderCost(parseMarkdownBlocks('a **b** c **d**'))).toBe(3);
    });

    it('a quote costs its element plus everything inside it', () => {
      expect(countRenderCost(parseMarkdownBlocks('> a **b**\n>\n> - c'))).toBe(1 + 2 + 2);
    });

    it('keeps the first bold runs of a paragraph that exceeds the budget', () => {
      const [paragraph] = takeWithinRenderBudget(parseMarkdownBlocks('a**b**'.repeat(10)), 4);

      expect(paragraph).toMatchObject({ type: 'paragraph' });
      expect(countRenderCost([paragraph!])).toBe(4);
    });

    it('keeps the first items of a numbered list and its start number', () => {
      const kept = takeWithinRenderBudget(parseMarkdownBlocks('5. a\n6. b\n7. c'), 3);

      expect(kept).toEqual([{ type: 'ordered-list', start: 5, items: [[text('a')], [text('b')]] }]);
    });

    it('a bullet holding a bold run and a code chip costs its list, its item and both styled runs', () => {
      expect(countRenderCost(parseMarkdownBlocks('- **a** `b`'))).toBe(4);
    });

    it('keeps only the bullets whose bold runs fit the budget', () => {
      const kept = takeWithinRenderBudget(parseMarkdownBlocks('- **a**\n- **b**\n- **c**'), 5);

      expect(kept).toMatchObject([{ type: 'list', items: [expect.anything(), expect.anything()] }]);
      expect(countRenderCost(kept)).toBeLessThanOrEqual(5);
    });

    it('keeps an empty quote within the budget', () => {
      const kept = takeWithinRenderBudget(parseMarkdownBlocks('>'), 5);

      expect(kept).toEqual([{ type: 'quote', blocks: [] }]);
      expect(countRenderCost(kept)).toBe(1);
    });

    it('keeps a heading that has no text', () => {
      const kept = takeWithinRenderBudget(parseMarkdownBlocks('# '), 5);

      expect(kept).toEqual([{ type: 'heading', level: 1, segments: [] }]);
    });

    it('cuts inside a quote and drops a quote that would keep nothing', () => {
      const blocks = parseMarkdownBlocks('> a\n>\n> b\n>\n> c');

      expect(takeWithinRenderBudget(blocks, 3)).toMatchObject([{ type: 'quote', blocks: [expect.anything(), expect.anything()] }]);
      expect(takeWithinRenderBudget(blocks, 1)).toEqual([]);
    });
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
