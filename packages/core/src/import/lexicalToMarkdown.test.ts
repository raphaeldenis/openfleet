import { describe, expect, it } from 'vitest';
import { convertLexicalToMarkdown } from './lexicalToMarkdown.js';

type Node = { type: string; [key: string]: unknown };

const FORMAT = { bold: 1, italic: 2, strikethrough: 4, code: 16 } as const;

const text = (value: string, format = 0): Node => ({ type: 'text', text: value, format });
const paragraph = (...children: Node[]): Node => ({ type: 'paragraph', children });
const heading = (tag: string, ...children: Node[]): Node => ({ type: 'heading', tag, children });
const listItem = (...children: Node[]): Node => ({ type: 'listitem', children });
const collapsibleListItem = (...children: Node[]): Node => ({ type: 'collapsible-listitem', collapsed: false, children });
const bulletList = (...items: Node[]): Node => ({ type: 'list', listType: 'bullet', tag: 'ul', start: 1, children: items });
const numberedList = (start: number, ...items: Node[]): Node => ({ type: 'list', listType: 'number', tag: 'ol', start, children: items });
const missionBody = (section: string, ...children: Node[]): Node => ({ type: 'mission-body', section, children });
const mention = (fields: { mentionKind: string; mentionNoteID?: string; mentionId?: string; text: string }): Node => ({
  type: 'mention',
  ...fields,
});
const tableCell = (...children: Node[]): Node => ({ type: 'tablecell', children });
const tableRow = (...cells: Node[]): Node => ({ type: 'tablerow', children: cells });

const documentOf = (...blocks: Node[]) => ({ root: { type: 'root', children: blocks } });
const markdownOf = (...blocks: Node[]) => convertLexicalToMarkdown(documentOf(...blocks)).markdown;

describe('convertLexicalToMarkdown', () => {
  describe('input', () => {
    it('accepts the lexical document as a JSON string', () => {
      const json = JSON.stringify(documentOf(paragraph(text('hello'))));

      expect(convertLexicalToMarkdown(json).markdown).toBe('hello');
    });

    it('returns an empty markdown and no unconverted type for an empty document', () => {
      expect(convertLexicalToMarkdown(documentOf())).toEqual({ markdown: '', unconvertedTypes: [] });
    });
  });

  describe('paragraphs and headings', () => {
    it('separates blocks with a blank line and drops empty paragraphs', () => {
      const markdown = markdownOf(heading('h1', text('Title')), paragraph(), paragraph(text('One')), heading('h3', text('Deep')));

      expect(markdown).toBe('# Title\n\nOne\n\n### Deep');
    });

    it('renders a linebreak as a markdown hard break', () => {
      const markdown = markdownOf(paragraph(text('a'), { type: 'linebreak' }, text('b')));

      expect(markdown).toBe('a  \nb');
    });
  });

  describe('text formatting', () => {
    it('wraps bold, italic, strikethrough and code runs', () => {
      const markdown = markdownOf(
        paragraph(
          text('b', FORMAT.bold),
          text(' '),
          text('i', FORMAT.italic),
          text(' '),
          text('s', FORMAT.strikethrough),
          text(' '),
          text('c', FORMAT.code),
        ),
      );

      expect(markdown).toBe('**b** *i* ~~s~~ `c`');
    });

    it('combines bold and code on one run', () => {
      expect(markdownOf(paragraph(text('x', FORMAT.bold | FORMAT.code)))).toBe('**`x`**');
    });

    it('keeps the whitespace around a formatted run outside its markers', () => {
      expect(markdownOf(paragraph(text(' pad ', FORMAT.bold), text('end')))).toBe(' **pad** end');
    });
  });

  describe('lists', () => {
    it('renders bullet items, collapsible items included', () => {
      const markdown = markdownOf(bulletList(listItem(text('plain')), collapsibleListItem(text('folded'))));

      expect(markdown).toBe('- plain\n- folded');
    });

    it('numbers an ordered list from its start', () => {
      const markdown = markdownOf(numberedList(3, listItem(text('c')), listItem(text('d'))));

      expect(markdown).toBe('3. c\n4. d');
    });

    it('indents a nested list under its parent item', () => {
      const markdown = markdownOf(bulletList(listItem(text('parent')), listItem(bulletList(listItem(text('child'))))));

      expect(markdown).toBe('- parent\n  - child');
    });
  });

  describe('quote', () => {
    it('prefixes every quoted line and keeps the hard break between them', () => {
      const markdown = markdownOf({ type: 'quote', children: [text('a'), { type: 'linebreak' }, text('b')] });

      expect(markdown).toBe('> a  \n> b');
    });
  });

  describe('code', () => {
    it('renders a fenced block carrying its language', () => {
      const markdown = markdownOf({
        type: 'code',
        language: 'ts',
        children: [text('const a = 1;'), { type: 'linebreak' }, text('a++;')],
      });

      expect(markdown).toBe('```ts\nconst a = 1;\na++;\n```');
    });

    it('renders a fence without language when none is set', () => {
      expect(markdownOf({ type: 'code', children: [text('x')] })).toBe('```\nx\n```');
    });
  });

  describe('table', () => {
    it('renders the first row as the header and escapes pipes inside cells', () => {
      const markdown = markdownOf({
        type: 'table',
        children: [
          tableRow(tableCell(paragraph(text('Name'))), tableCell(paragraph(text('Value')))),
          tableRow(tableCell(paragraph(text('a|b'))), tableCell(paragraph(text('1')), paragraph(text('2')))),
        ],
      });

      expect(markdown).toBe('| Name | Value |\n| --- | --- |\n| a\\|b | 1<br>2 |');
    });
  });

  describe('mention', () => {
    it('renders a note mention as the OpenFleet @note:<id> reference', () => {
      const markdown = markdownOf(
        paragraph(text('see '), mention({ mentionKind: 'note', mentionNoteID: 'A1B2-C3', text: '@House rules' })),
      );

      expect(markdown).toBe('see @note:A1B2-C3');
    });

    it('renders a dataStore mention as @table:<id> and a playbook mention as @playbook:<id>', () => {
      const markdown = markdownOf(
        paragraph(
          mention({ mentionKind: 'dataStore', mentionId: 'D4', text: '@backlog' }),
          text(' '),
          mention({ mentionKind: 'playbook', mentionId: 'P9', text: '@verify' }),
        ),
      );

      expect(markdown).toBe('@table:D4 @playbook:P9');
    });

    it('reports a mention of an unsupported kind instead of dropping it', () => {
      const result = convertLexicalToMarkdown(
        documentOf(paragraph(mention({ mentionKind: 'calendar', mentionId: 'C1', text: '@cal' }))),
      );

      expect(result).toEqual({ markdown: '[non converti: mention:calendar]', unconvertedTypes: ['mention:calendar'] });
    });

    it('reports a mention whose id the OpenFleet syntax cannot carry', () => {
      const result = convertLexicalToMarkdown(
        documentOf(paragraph(mention({ mentionKind: 'note', mentionNoteID: 'has space', text: '@x' }))),
      );

      expect(result.unconvertedTypes).toEqual(['mention:note']);
    });
  });

  describe('mission-law-bound', () => {
    it('renders scope / condition / exclusions as a Permission line under its list item', () => {
      const lawBound = { type: 'mission-law-bound', scope: 'repo openfleet', condition: 'CI green', exclusions: 'main branch' };

      const markdown = markdownOf(bulletList(listItem(text('Push branches'), lawBound)));

      expect(markdown).toBe('- Push branches\n  Permission: repo openfleet / CI green / main branch');
    });

    it('shows a dash for each empty part so the three positions stay readable', () => {
      const lawBound = { type: 'mission-law-bound', scope: 'repo openfleet', condition: '', exclusions: '' };

      expect(markdownOf(paragraph(lawBound))).toBe('Permission: repo openfleet / — / —');
    });
  });

  describe('mission nodes', () => {
    it('renders the mission sections under named headings', () => {
      const markdown = markdownOf(
        { type: 'mission-profile' },
        missionBody('mission-profile-expertise', paragraph(text('Ships code'))),
        missionBody('mission-profile-mission', paragraph(text('Deliver'))),
        { type: 'mission-pulse-actions' },
        missionBody('mission-pulse-actions', paragraph(text('Check PRs'))),
        { type: 'mission-laws' },
        missionBody('mission-laws', bulletList(listItem(text('Never force push')))),
        { type: 'mission-resources' },
      );

      expect(markdown).toBe(
        [
          '## Mission profile',
          '### Expertise\n\nShips code',
          '### Mission\n\nDeliver',
          '## Pulse actions',
          'Check PRs',
          '## Laws',
          '- Never force push',
          '## Resources',
        ].join('\n\n'),
      );
    });

    it('renders the children of a mission body with an unknown section without a heading', () => {
      expect(markdownOf(missionBody('mission-other', paragraph(text('kept'))))).toBe('kept');
    });

    it('converts the mission nodes without reporting any unconverted type', () => {
      const result = convertLexicalToMarkdown(
        documentOf({ type: 'mission-profile' }, { type: 'mission-pulse-actions' }, { type: 'mission-laws' }, { type: 'mission-resources' }),
      );

      expect(result.unconvertedTypes).toEqual([]);
    });
  });

  describe('unknown nodes', () => {
    it('replaces an unknown block by a marker and reports its type once', () => {
      const result = convertLexicalToMarkdown(documentOf({ type: 'widget' }, paragraph(text('ok')), { type: 'widget' }));

      expect(result).toEqual({ markdown: '[non converti: widget]\n\nok\n\n[non converti: widget]', unconvertedTypes: ['widget'] });
    });

    it('marks an unknown inline node in place and keeps the reported types in first-seen order', () => {
      const result = convertLexicalToMarkdown(
        documentOf(paragraph(text('a '), { type: 'sticker' }, text(' b')), { type: 'gizmo' }),
      );

      expect(result).toEqual({
        markdown: 'a [non converti: sticker] b\n\n[non converti: gizmo]',
        unconvertedTypes: ['sticker', 'gizmo'],
      });
    });
  });
});
