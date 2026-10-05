import { describe, expect, it } from 'vitest';
import { countRenderCost, parseMarkdownBlocks, takeWithinRenderBudget, type InlineSegment, type MarkdownBlock } from './markdown-blocks';

const text = (value: string): InlineSegment => ({ text: value, isCode: false, isBold: false });
const code = (value: string): InlineSegment => ({ text: value, isCode: true, isBold: false });
const bold = (value: string): InlineSegment => ({ text: value, isCode: false, isBold: true });
const singleLineCell = (...segments: InlineSegment[]) => [segments];
const textCell = (value: string) => singleLineCell(text(value));
const emptyCell = [[]];

describe('parseMarkdownBlocks tables', () => {
  it.each<{ name: string; markdown: string; expected: MarkdownBlock[] }>([
    {
      name: 'a simple table',
      markdown: '| Name | Role |\n| --- | --- |\n| Ada | Dev |\n| Bob | Ops |',
      expected: [{
        type: 'table',
        alignments: [null, null],
        header: [textCell('Name'), textCell('Role')],
        rows: [[textCell('Ada'), textCell('Dev')], [textCell('Bob'), textCell('Ops')]],
      }],
    },
    {
      name: 'a table written without outer pipes',
      markdown: 'a | b\n--- | ---\n1 | 2',
      expected: [{ type: 'table', alignments: [null, null], header: [textCell('a'), textCell('b')], rows: [[textCell('1'), textCell('2')]] }],
    },
    {
      name: 'column alignments from the delimiter row',
      markdown: '| a | b | c | d |\n| :--- | ---: | :---: | --- |\n| 1 | 2 | 3 | 4 |',
      expected: [{
        type: 'table',
        alignments: ['left', 'right', 'center', null],
        header: [textCell('a'), textCell('b'), textCell('c'), textCell('d')],
        rows: [[textCell('1'), textCell('2'), textCell('3'), textCell('4')]],
      }],
    },
    {
      name: 'escaped pipes inside cells',
      markdown: '| a | b |\n| --- | --- |\n| x \\| y | `p \\| q` |',
      expected: [{
        type: 'table',
        alignments: [null, null],
        header: [textCell('a'), textCell('b')],
        rows: [[textCell('x | y'), singleLineCell(code('p | q'))]],
      }],
    },
    {
      name: 'line breaks inside a cell',
      markdown: '| a | b |\n| --- | --- |\n| one<br>two<br/>three<BR />four | x |',
      expected: [{
        type: 'table',
        alignments: [null, null],
        header: [textCell('a'), textCell('b')],
        rows: [[[[text('one')], [text('two')], [text('three')], [text('four')]], textCell('x')]],
      }],
    },
    {
      name: 'short rows padded and long rows cut to the header width',
      markdown: '| a | b | c |\n| --- | --- | --- |\n| 1 |\n| 1 | 2 | 3 | 4 | 5 |',
      expected: [{
        type: 'table',
        alignments: [null, null, null],
        header: [textCell('a'), textCell('b'), textCell('c')],
        rows: [[textCell('1'), emptyCell, emptyCell], [textCell('1'), textCell('2'), textCell('3')]],
      }],
    },
    {
      name: 'inline code and bold inside cells',
      markdown: '| a |\n| --- |\n| **x** and `y` |',
      expected: [{ type: 'table', alignments: [null], header: [textCell('a')], rows: [[singleLineCell(bold('x'), text(' and '), code('y'))]] }],
    },
    {
      name: 'a header-only table',
      markdown: '| a | b |\n| --- | --- |',
      expected: [{ type: 'table', alignments: [null, null], header: [textCell('a'), textCell('b')], rows: [] }],
    },
    {
      name: 'a table directly after a paragraph, with no blank line',
      markdown: 'Intro line\n| a | b |\n| --- | --- |\n| 1 | 2 |',
      expected: [
        { type: 'paragraph', segments: [text('Intro line')] },
        { type: 'table', alignments: [null, null], header: [textCell('a'), textCell('b')], rows: [[textCell('1'), textCell('2')]] },
      ],
    },
    {
      name: 'a paragraph after a table separated by a blank line',
      markdown: '| a |\n| --- |\n| 1 |\n\nAfter',
      expected: [
        { type: 'table', alignments: [null], header: [textCell('a')], rows: [[textCell('1')]] },
        { type: 'paragraph', segments: [text('After')] },
      ],
    },
    {
      name: 'a table inside a quote',
      markdown: '> | a |\n> | --- |\n> | 1 |',
      expected: [{ type: 'quote', blocks: [{ type: 'table', alignments: [null], header: [textCell('a')], rows: [[textCell('1')]] }] }],
    },
    {
      name: 'a table-looking text inside a fenced code block',
      markdown: '```\n| a | b |\n| --- | --- |\n| 1 | 2 |\n```',
      expected: [{ type: 'code', text: '| a | b |\n| --- | --- |\n| 1 | 2 |' }],
    },
    {
      name: 'hostile html inside cells as plain text',
      markdown: '| a |\n| --- |\n| <script>alert(1)</script><br><img src=x onerror="alert(1)"> |',
      expected: [{
        type: 'table',
        alignments: [null],
        header: [textCell('a')],
        rows: [[[[text('<script>alert(1)</script>')], [text('<img src=x onerror="alert(1)">')]]]],
      }],
    },
    {
      name: 'a header row whose delimiter row has another column count as a paragraph',
      markdown: '| a | b |\n| --- |\n| 1 | 2 |',
      expected: [{ type: 'paragraph', segments: [text('| a | b | | --- | | 1 | 2 |')] }],
    },
    {
      name: 'a pipe line with no delimiter row as a paragraph',
      markdown: '| a | b |\n| 1 | 2 |',
      expected: [{ type: 'paragraph', segments: [text('| a | b | | 1 | 2 |')] }],
    },
    {
      name: 'a thematic dash line under a plain line as a paragraph',
      markdown: 'title\n---',
      expected: [{ type: 'paragraph', segments: [text('title ---')] }],
    },
  ])('parses $name', ({ markdown, expected }) => {
    expect(parseMarkdownBlocks(markdown)).toEqual(expected);
  });
});

describe('render budget of tables', () => {
  const tableOfRows = (rowCount: number) => {
    const rows = Array.from({ length: rowCount }, (_, row) => `| r${row} | v${row} |`);
    return parseMarkdownBlocks(['| a | b |', '| --- | --- |', ...rows].join('\n'));
  };

  it('counts more for a larger table', () => {
    expect(countRenderCost(tableOfRows(10))).toBeGreaterThan(countRenderCost(tableOfRows(2)));
  });

  it('keeps the header and the first rows that fit', () => {
    const [kept] = takeWithinRenderBudget(tableOfRows(10), 12);

    expect(kept).toMatchObject({ type: 'table', header: [textCell('a'), textCell('b')] });
    const keptRows = kept?.type === 'table' ? kept.rows.length : -1;
    expect(keptRows).toBeGreaterThan(0);
    expect(keptRows).toBeLessThan(10);
  });

  it('shows the whole table when the budget is large', () => {
    const blocks = tableOfRows(10);

    expect(takeWithinRenderBudget(blocks, 10_000)).toEqual(blocks);
  });
});
