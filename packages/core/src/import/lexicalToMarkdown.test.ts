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

    it('keeps heading linebreaks inside one heading line', () => {
      const markdown = markdownOf(heading('h2', text('First'), { type: 'linebreak' }, text('second')));

      expect(markdown).toBe('## First second');
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

    it('keeps a leading nested list under an empty parent item', () => {
      const markdown = markdownOf(bulletList(listItem(bulletList(listItem(text('child')))), listItem(text('next'))));

      expect(markdown).toBe('- \n  - child\n- next');
    });

    it('counts a leading empty numbered parent but does not count nested wrappers after it', () => {
      const markdown = markdownOf(numberedList(9,
        listItem(bulletList(listItem(text('first child')))),
        listItem(bulletList(listItem(text('second child')))),
        listItem(text('next')),
      ));

      expect(markdown).toBe('9. \n   - first child\n   - second child\n10. next');
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

    it('pads every row and the separator to the widest source row without discarding cells', () => {
      const markdown = markdownOf({ type: 'table', children: [
        tableRow(tableCell(paragraph(text('Header')))),
        tableRow(tableCell(paragraph(text('one'))), tableCell(paragraph(text('two'))), tableCell(paragraph(text('three')))),
        tableRow(tableCell(paragraph(text('short')))),
      ] });

      expect(markdown).toBe('| Header |  |  |\n| --- | --- | --- |\n| one | two | three |\n| short |  |  |');
    });

    it('does not double escape an escaped pipe and protects a pipe after an even backslash run', () => {
      const markdown = markdownOf({ type: 'table', children: [
        tableRow(tableCell(paragraph(text(String.raw`a\|b`))), tableCell(paragraph(text(String.raw`c\\|d`)))),
      ] });

      expect(markdown).toBe(String.raw`| a\|b | c\\\|d |` + '\n| --- | --- |');
    });

    it('flattens block content into cells while keeping code as inline code and escaping its pipes', () => {
      const markdown = markdownOf({ type: 'table', children: [tableRow(tableCell(
        heading('h2', text('Title')),
        paragraph(text('a'), { type: 'linebreak' }, text('b')),
        bulletList(listItem(text('item'))),
        { type: 'code', children: [text('left|right'), { type: 'linebreak' }, text('last')] },
      ))] });

      expect(markdown).toBe('| Title<br>a<br>b<br>- item<br>`left\\|right`<br>`last` |\n| --- |');
    });

    it('renders a table with no cells as nothing', () => {
      expect(markdownOf({ type: 'table', children: [tableRow(), tableRow()] })).toBe('');
    });
  });

  describe('authored Markdown policy', () => {
    it('keeps authored Markdown in ordinary text and applies only the explicit Lexical formatting wrappers', () => {
      const markdown = markdownOf(paragraph(text('[docs](https://example.test) *literal* #tag'), text(' **authored** ', FORMAT.bold)));

      expect(markdown).toBe('[docs](https://example.test) *literal* #tag ****authored**** ');
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

      expect(markdown).toBe('- Push branches  \n  Permission: repo openfleet / CI green / main branch');
    });

    it('omits a bound whose three parts are all empty', () => {
      const emptyBound = { type: 'mission-law-bound', scope: '', condition: '', exclusions: '' };

      expect(markdownOf(bulletList(listItem(text('Push branches'), emptyBound)))).toBe('- Push branches');
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

  describe('real shapes', () => {
    it('renders a mention and a law bound inside a collapsible list item', () => {
      const lawBound = { type: 'mission-law-bound', scope: 'repo', condition: 'CI green', exclusions: 'main' };
      const item = collapsibleListItem(text('Follow '), mention({ mentionKind: 'note', mentionNoteID: 'N1', text: '@Rules' }), lawBound);

      expect(markdownOf(bulletList(item))).toBe('- Follow @note:N1  \n  Permission: repo / CI green / main');
    });
  });

  describe('defaults', () => {
    it('renders a heading without tag at level 1', () => {
      expect(markdownOf({ type: 'heading', children: [text('Untagged')] })).toBe('# Untagged');
    });

    it('numbers an ordered list from 1 when it has no start', () => {
      const markdown = markdownOf({ type: 'list', listType: 'number', children: [listItem(text('a')), listItem(text('b'))] });

      expect(markdown).toBe('1. a\n2. b');
    });

    it('renders an empty table as nothing', () => {
      expect(markdownOf({ type: 'table', children: [] }, paragraph(text('after')))).toBe('after');
    });

    it('falls back to mentionId for a note mention without mentionNoteID', () => {
      const markdown = markdownOf(paragraph(mention({ mentionKind: 'note', mentionId: 'N7', text: '@x' })));

      expect(markdown).toBe('@note:N7');
    });
  });

  describe('inline code delimiters', () => {
    it('uses a delimiter longer than the longest backtick run of the code', () => {
      expect(markdownOf(paragraph(text('a`b', FORMAT.code)))).toBe('``a`b``');
    });

    it('pads the code with spaces when it starts or ends with a backtick', () => {
      expect(markdownOf(paragraph(text('`x', FORMAT.code)))).toBe('`` `x ``');
      expect(markdownOf(paragraph(text('x`', FORMAT.code)))).toBe('`` x` ``');
    });
  });

  describe('fenced code delimiters', () => {
    it('uses a fence longer than the longest backtick run of the code', () => {
      const markdown = markdownOf({ type: 'code', children: [text('before'), { type: 'linebreak' }, text('```'), { type: 'linebreak' }, text('after')] });

      expect(markdown).toBe('````\nbefore\n```\nafter\n````');
    });
  });

  describe('unknown text format bits', () => {
    it('marks a run carrying a format bit it cannot render and reports it', () => {
      const underline = 8;

      const result = convertLexicalToMarkdown(documentOf(paragraph(text('u', underline))));

      expect(result).toEqual({ markdown: 'u[non converti: text-format:8]', unconvertedTypes: ['text-format:8'] });
    });

    it('still applies the known bits of a run that also carries an unknown one', () => {
      const result = convertLexicalToMarkdown(documentOf(paragraph(text('u', FORMAT.bold | 32))));

      expect(result.markdown).toBe('**u**[non converti: text-format:32]');
    });
  });

  describe('prototype-named keys', () => {
    it('treats a node type named like an Object.prototype key as unknown', () => {
      const result = convertLexicalToMarkdown(documentOf({ type: 'constructor' }));

      expect(result).toEqual({ markdown: '[non converti: constructor]', unconvertedTypes: ['constructor'] });
    });

    it('renders a mission body whose section is named like an Object.prototype key without heading', () => {
      expect(markdownOf(missionBody('toString', paragraph(text('kept'))))).toBe('kept');
    });
  });

  describe('document shape', () => {
    it('throws when the root node is not a root', () => {
      expect(() => convertLexicalToMarkdown({ root: { type: 'paragraph', children: [] } })).toThrow();
    });

    it('throws when the root has no children array', () => {
      expect(() => convertLexicalToMarkdown({ root: { type: 'root' } })).toThrow();
      expect(() => convertLexicalToMarkdown({ root: { type: 'root', children: 'x' } })).toThrow();
    });
  });

  describe('mention neighbours', () => {
    it('separates a mention from a word character that precedes it', () => {
      const markdown = markdownOf(paragraph(text('voir'), mention({ mentionKind: 'note', mentionNoteID: 'N1', text: '@x' })));

      expect(markdown).toBe('voir @note:N1');
    });

    it('separates a mention from a word character that follows it', () => {
      const markdown = markdownOf(paragraph(mention({ mentionKind: 'note', mentionNoteID: 'N1', text: '@x' }), text('suite')));

      expect(markdown).toBe('@note:N1 suite');
    });

    it('leaves a mention next to whitespace or punctuation untouched', () => {
      const markdown = markdownOf(paragraph(text('('), mention({ mentionKind: 'note', mentionNoteID: 'N1', text: '@x' }), text('), ok')));

      expect(markdown).toBe('(@note:N1), ok');
    });
  });

  describe('links, rules, tabs and checklists', () => {
    const link = (type: string, url: string, ...children: Node[]): Node => ({ type, url, children });

    it('converts a link to a markdown link', () => {
      const result = convertLexicalToMarkdown(documentOf(paragraph(text('see '), link('link', 'https://example.test/a', text('docs')))));

      expect(result).toEqual({ markdown: 'see [docs](https://example.test/a)', unconvertedTypes: [] });
    });

    it('converts an autolink and a mailto link', () => {
      const markdown = markdownOf(paragraph(link('autolink', 'https://example.test', text('example')), text(' '), link('link', 'mailto:a@example.test', text('mail'))));

      expect(markdown).toBe('[example](https://example.test) [mail](mailto:a@example.test)');
    });

    it.each(['javascript:alert(1)', 'javascript:void0','https://example.test/a b', 'https://example.test/a)b', '', 'relative/path'])('keeps the marker and the text of a link to %j', (url) => {
      const result = convertLexicalToMarkdown(documentOf(paragraph(link('link', url, text('docs')))));

      expect(result).toEqual({ markdown: '[non converti: link]docs', unconvertedTypes: ['link'] });
    });

    it('keeps the marker and the text of a link whose text would break the markdown link', () => {
      const result = convertLexicalToMarkdown(documentOf(paragraph(link('link', 'https://example.test', text('a]b')))));

      expect(result.unconvertedTypes).toEqual(['link']);
      expect(result.markdown).toContain('a]b');
    });

    it('converts a horizontal rule to a markdown rule', () => {
      const result = convertLexicalToMarkdown(documentOf(paragraph(text('a')), { type: 'horizontalrule' }, paragraph(text('b'))));

      expect(result).toEqual({ markdown: 'a\n\n---\n\nb', unconvertedTypes: [] });
    });

    it('converts a tab node to a tab', () => {
      const result = convertLexicalToMarkdown(documentOf(paragraph(text('a'), { type: 'tab', text: '\t' }, text('b'))));

      expect(result).toEqual({ markdown: 'a\tb', unconvertedTypes: [] });
    });

    it('renders the checked state of a checklist item', () => {
      const checklist: Node = { type: 'list', listType: 'check', children: [
        { type: 'listitem', checked: true, children: [text('done')] },
        { type: 'listitem', checked: false, children: [text('todo')] },
        { type: 'listitem', children: [text('unset')] },
      ] };

      expect(markdownOf(checklist)).toBe('- [x] done\n- [ ] todo\n- [ ] unset');
    });

    it('escapes an exclamation mark right before a link so it cannot become an image', () => {
      const markdown = markdownOf(paragraph(text('Hi!'), link('link', 'https://example.test/x.png', text('texte'))));

      expect(markdown).not.toMatch(/(?<!\\)!\[/);
      expect(markdown).toBe('Hi\\![texte](https://example.test/x.png)');
    });

    it('turns a tab node into one tab whatever its text field holds', () => {
      const result = convertLexicalToMarkdown(documentOf(paragraph(text('a'), { type: 'tab', text: '\n# H' }, text('b'))));

      expect(result.markdown).toBe('a\tb');
    });

    it.each([
      ['a backslash at the end', 'https://a.test/x\\'],
      ['a closing bracket', 'https://a.test/x]'],
      ['an opening bracket', 'https://a.test/[x'],
      ['a backtick', 'https://a.test/`x'],
      ['a double quote', 'https://a.test/"x'],
      ['a bidirectional control', `https://a.test/${String.fromCodePoint(0x202e)}x`],
      ['a zero-width space', `https://a.test/${String.fromCodePoint(0x200b)}x`],
      ['a control character', 'https://a.test/\u0007x'],
      ['an uppercase javascript scheme', 'JAVASCRIPT:void0'],
      ['a 64 KiB length', `https://a.test/${'a'.repeat(64 * 1024)}`],
    ])('keeps the marker of a link to a URL with %s', (_reason, url) => {
      const startedAt = performance.now();

      const result = convertLexicalToMarkdown(documentOf(paragraph(link('link', url, text('t')))));

      expect(result).toEqual({ markdown: '[non converti: link]t', unconvertedTypes: ['link'] });
      expect(performance.now() - startedAt).toBeLessThan(500);
    });

    it('converts a link whose scheme is in uppercase', () => {
      expect(markdownOf(paragraph(link('link', 'HTTP://A.TEST/x', text('t'))))).toBe('[t](HTTP://A.TEST/x)');
    });

    it('keeps the URL of a safe link whose text holds an unconverted marker', () => {
      const underlined = convertLexicalToMarkdown(documentOf(paragraph(link('link', 'https://example.test', text('u', 8)))));
      const withUnknownMention = convertLexicalToMarkdown(documentOf(paragraph(link('link', 'https://example.test', mention({ mentionKind: 'calendar', text: '@x' })))));

      expect(underlined).toEqual({ markdown: '[u[non converti: text-format:8]](https://example.test)', unconvertedTypes: ['text-format:8'] });
      expect(withUnknownMention.markdown).toBe('[[non converti: mention:calendar]](https://example.test)');
    });

    it('keeps the marker of a link whose text holds a line break', () => {
      const result = convertLexicalToMarkdown(documentOf(paragraph(link('link', 'https://example.test', text('a'), { type: 'linebreak' }, text('b')))));

      expect(result.unconvertedTypes).toEqual(['link']);
    });

    it.each([
      ['a trailing backslash', 'C:\\'],
      ['a lone backtick', 'a`b'],
      ['an escaped bracket that leaves another one open', '[a\\]'],
      ['a text imitating a marker with an inner bracket', '[non converti: a[b]'],
    ])('keeps the marker and the text of a link whose text has %s', (_reason, linkText) => {
      const result = convertLexicalToMarkdown(documentOf(paragraph(link('link', 'https://example.test', text(linkText)))));

      expect(result.unconvertedTypes).toEqual(['link']);
      expect(result.markdown).toBe(`[non converti: link]${linkText}`);
    });

    it.each([
      ['an even run of backslashes', 'C:\\\\', '[C:\\\\](https://example.test)'],
      ['a balanced pair of backticks', 'a`b`c', '[a`b`c](https://example.test)'],
      ['balanced brackets', 'a[b]c', '[a[b]c](https://example.test)'],
      ['escaped brackets', 'a\\[b', '[a\\[b](https://example.test)'],
    ])('converts a link whose text has %s', (_reason, linkText, expectedMarkdown) => {
      expect(markdownOf(paragraph(link('link', 'https://example.test', text(linkText))))).toBe(expectedMarkdown);
    });

    it('converts a link whose text is formatted as code', () => {
      expect(markdownOf(paragraph(link('link', 'https://example.test', text('x', FORMAT.code))))).toBe('[`x`](https://example.test)');
    });

    it('keeps the brackets of a node type out of its marker', () => {
      const result = convertLexicalToMarkdown(documentOf(paragraph({ type: 'a[b]c\nd' } as Node)));

      expect(result.markdown).toBe('[non converti: a(b)c d]');
    });

    it('keeps a safe link whose text holds the marker of a node type with brackets', () => {
      const result = convertLexicalToMarkdown(documentOf(paragraph(link('link', 'https://example.test', { type: 'a[b' } as Node))));

      expect(result.markdown).toBe('[[non converti: a(b]](https://example.test)');
    });

    it('leaves an already escaped exclamation mark before a link as it is', () => {
      const markdown = markdownOf(paragraph(text('Hi\\!'), link('link', 'https://example.test/x.png', text('texte'))));

      expect(markdown).toBe('Hi\\![texte](https://example.test/x.png)');
    });

    it('escapes a bare exclamation mark that follows an escaped backslash before a link', () => {
      const markdown = markdownOf(paragraph(text('Hi\\\\!'), link('link', 'https://example.test/x.png', text('texte'))));

      expect(markdown).toBe('Hi\\\\\\![texte](https://example.test/x.png)');
    });
  });

  describe('node types that are not strings', () => {
    it('labels a numeric type with its digits', () => {
      const result = convertLexicalToMarkdown(documentOf({ type: 5 } as unknown as Node));

      expect(result).toEqual({ markdown: '[non converti: 5]', unconvertedTypes: ['5'] });
    });

    it.each([[{}], [{ type: '' }], [{ type: null }], [{ type: { nested: true } }]])('labels the node %j as having no type', (node) => {
      const result = convertLexicalToMarkdown(documentOf(node as Node));

      expect(result).toEqual({ markdown: '[non converti: (sans type)]', unconvertedTypes: ['(sans type)'] });
    });
  });

  describe('children that are not nodes', () => {
    const NOT_NODES: [string, unknown][] = [['null', null], ['a number', 5], ['a string', 'x'], ['an array', []]];
    const CONTAINERS: [string, (child: unknown) => Node][] = [
      ['a paragraph', (child) => ({ type: 'paragraph', children: [child] } as Node)],
      ['a heading', (child) => ({ type: 'heading', tag: 'h2', children: [child] } as Node)],
      ['a quote', (child) => ({ type: 'quote', children: [child] } as Node)],
      ['a link', (child) => paragraph({ type: 'link', url: 'https://example.test', children: [child] } as Node)],
      ['a list item', (child) => ({ type: 'list', listType: 'bullet', children: [{ type: 'listitem', children: [child] }] } as Node)],
      ['a table cell', (child) => ({ type: 'table', children: [{ type: 'tablerow', children: [{ type: 'tablecell', children: [child] }] }] } as Node)],
      ['an unknown block', (child) => ({ type: 'callout', children: [child] } as Node)],
    ];

    describe.each(CONTAINERS)('in %s', (_container, containerOf) => {
      it.each(NOT_NODES)('names %s as a node without type and does not fail', (_notNode, notNode) => {
        const result = convertLexicalToMarkdown(documentOf(containerOf(notNode)));

        expect(result.unconvertedTypes).toContain('(sans type)');
        expect(result.markdown).toContain('[non converti: (sans type)]');
      });
    });

    it.each(NOT_NODES)('names %s at the root as a node without type', (_notNode, notNode) => {
      const result = convertLexicalToMarkdown({ root: { type: 'root', children: [notNode] } });

      expect(result).toEqual({ markdown: '[non converti: (sans type)]', unconvertedTypes: ['(sans type)'] });
    });

    it('reads a children field that is not an array as no children', () => {
      const result = convertLexicalToMarkdown(documentOf({ type: 'paragraph', children: 'text' } as unknown as Node));

      expect(result).toEqual({ markdown: '', unconvertedTypes: [] });
    });
  });

  describe('deeply nested documents', () => {
    const NESTING_DEPTH = 10_000;
    const nest = (wrap: (inner: Node) => Node): Node => {
      let node: Node = text('core');
      for (let level = 0; level < NESTING_DEPTH; level++) node = wrap(node);
      return node;
    };

    const nestUnknownBlocks = (levels: number): Node => {
      let node: Node = text('core');
      for (let level = 0; level < levels; level++) node = { type: 'callout', children: [node] };
      return node;
    };

    it('renders the text of a node at the 100th level', () => {
      const result = convertLexicalToMarkdown(documentOf(nestUnknownBlocks(99)));

      expect(result.unconvertedTypes).toEqual(['callout']);
      expect(result.markdown).toContain('core');
    });

    it('cuts the node below the 100th level with the nesting marker', () => {
      const result = convertLexicalToMarkdown(documentOf(nestUnknownBlocks(100)));

      expect(result.unconvertedTypes).toEqual(['callout', 'nesting-too-deep']);
      expect(result.markdown).not.toContain('core');
    });

    it.each([
      ['unknown blocks', (inner: Node): Node => ({ type: 'callout', children: [inner] })],
      ['quotes', (inner: Node): Node => ({ type: 'quote', children: [inner] })],
      ['lists', (inner: Node): Node => ({ type: 'list', listType: 'bullet', children: [{ type: 'listitem', children: [inner] }] })],
      ['links', (inner: Node): Node => ({ type: 'link', url: 'https://example.test', children: [inner] })],
    ])('marks the nesting limit instead of failing on %s', (_kind, wrap) => {
      const result = convertLexicalToMarkdown(documentOf(nest(wrap)));

      expect(result.unconvertedTypes).toContain('nesting-too-deep');
      expect(result.markdown).toContain('[non converti: nesting-too-deep]');
    });
  });

  describe('unknown nodes', () => {
    it('keeps the inline children of an unknown node after its marker', () => {
      const badge = { type: 'badge', children: [text('docs')] };

      const result = convertLexicalToMarkdown(documentOf(paragraph(text('see '), badge)));

      expect(result).toEqual({ markdown: 'see [non converti: badge]docs', unconvertedTypes: ['badge'] });
    });

    it('keeps the text of an unknown leaf node after its marker', () => {
      const result = convertLexicalToMarkdown(documentOf(paragraph({ type: 'sticker', text: 'kept words' })));

      expect(result).toEqual({ markdown: '[non converti: sticker]kept words', unconvertedTypes: ['sticker'] });
    });

    it('keeps the block children of an unknown node after its marker', () => {
      const callout = { type: 'callout', children: [paragraph(text('inside'))] };

      const result = convertLexicalToMarkdown(documentOf(callout));

      expect(result).toEqual({ markdown: '[non converti: callout]\n\ninside', unconvertedTypes: ['callout'] });
    });

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
