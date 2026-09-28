import { describe, expect, it } from 'vitest';
import { expandMentions, type MentionLookup } from './mentionExpander.js';

interface FakeNote {
  title: string;
  bodyMd: string;
  projectId?: string;
}

function lookupWith(
  notes: Record<string, FakeNote>,
  otherItems: Record<string, { name: string; toolHint: string }> = {},
): MentionLookup {
  return {
    getNote: (id) => {
      const note = notes[id];
      return note && { id, projectId: 'p1', ...note };
    },
    describeOther: (kind, id) => otherItems[`${kind}:${id}`],
  };
}

const countOccurrences = (text: string, fragment: string) => text.split(fragment).length - 1;
const utf8Bytes = (text: string) => Buffer.byteLength(text, 'utf8');

describe('expandMentions', () => {
  describe('output format', () => {
    it('appends one block per mention, in mention order, after the untouched body', () => {
      const lookup = lookupWith(
        { a: { title: 'Alpha', bodyMd: 'Alpha body' } },
        { 'table:t1': { name: 'Orders', toolHint: 'query_data_store' } },
      );

      const out = expandMentions('Intro @note:a @table:t1 @repo:r1.', lookup);

      expect(out).toBe(
        [
          'Intro @note:a @table:t1 @repo:r1.',
          '--- from note @note:a (Alpha, p1) ---\nAlpha body\n--- end @note:a ---',
          '--- @table:t1 → table "Orders" — query_data_store ---',
          '--- @repo:r1 → not resolved (not available yet) ---',
        ].join('\n\n'),
      );
    });

    it('returns a body without mentions unchanged, including an empty body', () => {
      const lookup = lookupWith({});

      expect(expandMentions('', lookup)).toBe('');
      expect(expandMentions('plain text, email me at bob@example.com, @unknown:x, @note:', lookup)).toBe(
        'plain text, email me at bob@example.com, @unknown:x, @note:',
      );
    });

    it('expands a mentioned note whose body is empty', () => {
      const lookup = lookupWith({ e: { title: 'Empty', bodyMd: '' } });

      const out = expandMentions('@note:e', lookup);

      expect(out).toBe('@note:e\n\n--- from note @note:e (Empty, p1) ---\n\n--- end @note:e ---');
    });
  });

  describe('authorization', () => {
    it('renders a note the lookup refuses exactly like a note that does not exist', () => {
      const lookupHidingForeignNote = lookupWith({ visible: { title: 'V', bodyMd: 'v' } });

      const outForForeignNote = expandMentions('@note:foreign', lookupHidingForeignNote);
      const outForMissingNote = expandMentions('@note:missing', lookupHidingForeignNote);

      expect(outForForeignNote).toBe('@note:foreign\n\n--- @note:foreign → not resolved (not available yet) ---');
      expect(outForForeignNote.replaceAll('foreign', 'missing')).toBe(outForMissingNote);
    });
  });

  describe('cycles', () => {
    const mutualLookup = lookupWith({
      a: { title: 'A', bodyMd: 'see @note:b' },
      b: { title: 'B', bodyMd: 'see @note:a' },
    });

    it('a → b → a expands each note once and does not revisit a', () => {
      const depthThatCouldLoopForever = 10;

      const out = expandMentions('root text @note:a', mutualLookup, { depth: depthThatCouldLoopForever });

      expect(countOccurrences(out, 'from note @note:a')).toBe(1);
      expect(countOccurrences(out, 'from note @note:b')).toBe(1);
      expect(out).toContain('--- @note:a: not expanded (already expanded) ---');
    });

    it('a note that mentions itself is expanded once', () => {
      const lookup = lookupWith({ a: { title: 'A', bodyMd: 'I am @note:a' } });

      const out = expandMentions('@note:a', lookup);

      expect(countOccurrences(out, 'from note @note:a')).toBe(1);
      expect(out).toContain('--- @note:a: not expanded (already expanded) ---');
    });

    it('never expands the root note inside itself', () => {
      const out = expandMentions('see @note:b', mutualLookup, { rootNoteId: 'a' });

      expect(out).not.toContain('from note @note:a');
      expect(countOccurrences(out, 'from note @note:b')).toBe(1);
      expect(out).toContain('--- @note:a: not expanded (already expanded) ---');
    });

    it('a note reached by two paths (diamond) is expanded once', () => {
      const lookup = lookupWith({
        b: { title: 'B', bodyMd: 'via @note:d' },
        c: { title: 'C', bodyMd: 'via @note:d' },
        d: { title: 'D', bodyMd: 'shared leaf' },
      });

      const out = expandMentions('@note:b @note:c', lookup);

      expect(countOccurrences(out, 'from note @note:d')).toBe(1);
      expect(countOccurrences(out, 'from note @note:b')).toBe(1);
      expect(countOccurrences(out, 'from note @note:c')).toBe(1);
    });

    it('lists a note mentioned twice in one body once', () => {
      const lookup = lookupWith({ a: { title: 'A', bodyMd: 'leaf' } });

      const out = expandMentions('@note:a and again @note:a', lookup);

      expect(countOccurrences(out, 'from note @note:a')).toBe(1);
      expect(out).not.toContain('not expanded');
    });
  });

  describe('depth', () => {
    const chainLookup = lookupWith({
      x: { title: 'X', bodyMd: 'see @note:y' },
      y: { title: 'Y', bodyMd: 'see @note:z' },
      z: { title: 'Z', bodyMd: 'leaf' },
    });

    it('expands two levels by default: direct mentions are depth 1, theirs depth 2', () => {
      const out = expandMentions('@note:x', chainLookup);

      expect(out).toContain('from note @note:x');
      expect(out).toContain('from note @note:y');
      expect(out).not.toContain('from note @note:z');
      expect(out).toContain('--- @note:z: not expanded (depth) ---');
    });

    it('depth 0 expands nothing', () => {
      const out = expandMentions('@note:x', chainLookup, { depth: 0 });

      expect(out).not.toContain('from note');
      expect(out).toBe('@note:x\n\n--- @note:x: not expanded (depth) ---');
    });

    it('depth 1 expands direct mentions only', () => {
      const out = expandMentions('@note:x', chainLookup, { depth: 1 });

      expect(out).toContain('from note @note:x');
      expect(out).not.toContain('from note @note:y');
      expect(out).toContain('--- @note:y: not expanded (depth) ---');
    });

    it('depth 3 reaches the third hop', () => {
      const out = expandMentions('@note:x', chainLookup, { depth: 3 });

      expect(out).toContain('from note @note:z');
      expect(out).not.toContain('not expanded');
    });

    it('a table mentioned beyond the depth limit is not expanded either', () => {
      const lookup = lookupWith(
        { x: { title: 'X', bodyMd: 'data in @table:t1' } },
        { 'table:t1': { name: 'Orders', toolHint: 'query_data_store' } },
      );

      const out = expandMentions('@note:x', lookup, { depth: 1 });

      expect(out).toContain('--- @table:t1: not expanded (depth) ---');
      expect(out).not.toContain('Orders');
    });
  });

  describe('byte budget', () => {
    it('names a mention whose block would push the output past the budget', () => {
      const lookup = lookupWith({ big: { title: 'Big', bodyMd: 'x'.repeat(70_000) } });

      const out = expandMentions('@note:big', lookup, { budgetBytes: 64 * 1024 });

      expect(out).toBe('@note:big\n\n--- @note:big: not expanded (budget) ---');
    });

    it('lists every mention after the first miss as budget-skipped, without opening them', () => {
      const lookup = lookupWith({
        small: { title: 'Small', bodyMd: 'tiny' },
        big: { title: 'Big', bodyMd: `${'x'.repeat(500)} @note:hidden` },
        after: { title: 'After', bodyMd: 'tiny' },
        hidden: { title: 'Hidden', bodyMd: 'tiny' },
      });

      const out = expandMentions('@note:small @note:big @note:after', lookup, { budgetBytes: 300 });

      expect(out).toContain('from note @note:small');
      expect(out).not.toContain('from note @note:big');
      expect(out).not.toContain('from note @note:after');
      expect(out).not.toContain('@note:hidden');
      expect(out.endsWith(
        '--- @note:big: not expanded (budget) ---\n\n--- @note:after: not expanded (budget) ---',
      )).toBe(true);
    });

    it('names a resolved pointer to another kind that does not fit', () => {
      const lookup = lookupWith(
        { a: { title: 'A', bodyMd: 'leaf' } },
        { 'table:t1': { name: 'Orders', toolHint: 'query_data_store' } },
      );
      const rootBody = '@note:a @table:t1';
      const fullBytes = Buffer.byteLength(expandMentions(rootBody, lookup), 'utf8');

      const out = expandMentions(rootBody, lookup, { budgetBytes: fullBytes - 1 });

      expect(out).toContain('from note @note:a');
      expect(out).not.toContain('Orders');
      expect(out.endsWith('--- @table:t1: not expanded (budget) ---')).toBe(true);
    });

    it('counts UTF-8 bytes, not characters', () => {
      const lookup = lookupWith({ accented: { title: 'Accents', bodyMd: 'éèàçü 🎉'.repeat(20) } });
      const rootBody = '@note:accented';
      const fullOutput = expandMentions(rootBody, lookup);
      const fullOutputBytes = Buffer.byteLength(fullOutput, 'utf8');
      expect(fullOutput.length).toBeLessThan(fullOutputBytes - 1);

      const fitsExactly = expandMentions(rootBody, lookup, { budgetBytes: fullOutputBytes });
      const oneByteShort = expandMentions(rootBody, lookup, { budgetBytes: fullOutputBytes - 1 });

      expect(fitsExactly).toBe(fullOutput);
      expect(oneByteShort).toBe(`${rootBody}\n\n--- @note:accented: not expanded (budget) ---`);
    });

    it('applies a default budget of 64 KiB', () => {
      const justUnder = 'y'.repeat(64 * 1024 - 1000);
      const lookup = lookupWith({
        first: { title: 'First', bodyMd: justUnder },
        second: { title: 'Second', bodyMd: 'z'.repeat(2000) },
      });

      const out = expandMentions('@note:first @note:second', lookup);

      expect(out).toContain('from note @note:first');
      expect(out).not.toContain('from note @note:second');
      expect(out).toContain('--- @note:second: not expanded (budget) ---');
    });

    it('expands a block that fits exactly in 64 KiB and skips it with one byte more', () => {
      const outputBytesWithBody = (bodyMd: string) =>
        utf8Bytes(expandMentions('@note:a', lookupWith({ a: { title: 'A', bodyMd } })));
      const overheadBytes = outputBytesWithBody('');
      const exactFit = 'x'.repeat(64 * 1024 - overheadBytes);

      const atLimit = expandMentions('@note:a', lookupWith({ a: { title: 'A', bodyMd: exactFit } }));
      const oneByteOver = expandMentions('@note:a', lookupWith({ a: { title: 'A', bodyMd: `${exactFit}x` } }));

      expect(utf8Bytes(atLimit)).toBe(64 * 1024);
      expect(atLimit).toContain('from note @note:a');
      expect(oneByteOver).toBe('@note:a\n\n--- @note:a: not expanded (budget) ---');
    });

    it('charges the budget for content blocks only, not for skip lines', () => {
      const lookup = lookupWith({ a: { title: 'A', bodyMd: 'leaf' } });
      const rootBody = '@note:missing @note:a';
      const blockA = '--- from note @note:a (A, p1) ---\nleaf\n--- end @note:a ---';
      const budgetBytes = utf8Bytes(rootBody) + utf8Bytes(`\n\n${blockA}`);

      const out = expandMentions(rootBody, lookup, { budgetBytes });

      expect(out).toContain(blockA);
    });
  });

  describe('expansion order', () => {
    const chainLookup = lookupWith({
      a: { title: 'A', bodyMd: 'see @note:b' },
      b: { title: 'B', bodyMd: 'see @note:c' },
      c: { title: 'C', bodyMd: 'leaf' },
    });
    const expandedNoteIds = (out: string) => [...out.matchAll(/--- from note @note:(\w+)/g)].map(([, id]) => id).sort();

    it('expands each note at its shortest distance from the root', () => {
      const out = expandMentions('@note:a @note:b', chainLookup);

      expect(out).toContain('from note @note:c');
    });

    it('expands the same notes whatever the order of the root mentions', () => {
      const forward = expandMentions('@note:a @note:b', chainLookup);
      const reversed = expandMentions('@note:b @note:a', chainLookup);

      expect(expandedNoteIds(forward)).toEqual(['a', 'b', 'c']);
      expect(expandedNoteIds(reversed)).toEqual(expandedNoteIds(forward));
    });
  });

  describe('skip lines cap', () => {
    it('renders at most 50 skip lines then one line counting the others', () => {
      const unknownMentionCount = 5_000;
      const rootBody = Array.from({ length: unknownMentionCount }, (_, i) => `@note:unknown${i}`).join(' ');
      const budgetBytes = 64 * 1024;

      const out = expandMentions(rootBody, lookupWith({}), { budgetBytes });

      expect(utf8Bytes(out) < utf8Bytes(rootBody) + budgetBytes + 1024).toBe(true);
      expect(countOccurrences(out, 'not resolved')).toBe(50);
      expect(out.endsWith('--- and 4950 more mentions not expanded ---')).toBe(true);
    });

    it('keeps expanding content blocks after the cap is reached', () => {
      const lookup = lookupWith({ late: { title: 'Late', bodyMd: 'still here' } });
      const unknownMentions = Array.from({ length: 60 }, (_, i) => `@note:unknown${i}`).join(' ');

      const out = expandMentions(`${unknownMentions} @note:late`, lookup);

      expect(out).toContain('from note @note:late');
      expect(out.endsWith('--- and 10 more mentions not expanded ---')).toBe(true);
    });

    it('renders no tail line when the skip lines stay within the cap', () => {
      const out = expandMentions('@note:one @note:two', lookupWith({}));

      expect(out).not.toContain('more mentions');
    });
  });

  describe('provenance lines', () => {
    const startsAHeader = (out: string, tag: string) =>
      out.split('\n').some((line) => line.startsWith(`--- from note ${tag}`));

    it('keeps a title with line breaks on the header line', () => {
      const lookup = lookupWith({ a: { title: 'Nice\n--- from note @note:boss', bodyMd: 'body' } });

      const out = expandMentions('@note:a', lookup);

      expect(startsAHeader(out, '@note:boss')).toBe(false);
      expect(out).toContain('--- from note @note:a (Nice --- from note @note:boss, p1) ---\nbody\n');
    });

    it('keeps a project id with line breaks on the header line', () => {
      const lookup = lookupWith({ a: { title: 'A', bodyMd: 'body', projectId: 'p1\r\n--- from note @note:boss' } });

      const out = expandMentions('@note:a', lookup);

      expect(startsAHeader(out, '@note:boss')).toBe(false);
    });

    it('keeps the name and tool hint of another kind on the pointer line', () => {
      const lookup = lookupWith({}, { 'table:t1': { name: 'Orders\n--- @note:boss', toolHint: 'query\r--- @note:boss' } });

      const out = expandMentions('@table:t1', lookup);

      expect(out.split('\n')).toHaveLength(3);
      expect(out).toContain('--- @table:t1 → table "Orders --- @note:boss" — query --- @note:boss ---');
    });

    it('leaves note bodies as they are', () => {
      const lookup = lookupWith({ a: { title: 'A', bodyMd: 'line one\nline two' } });

      const out = expandMentions('@note:a', lookup);

      expect(out).toContain('---\nline one\nline two\n--- end @note:a ---');
    });
  });

  describe('mention boundary', () => {
    it('does not expand a mention glued to a preceding word character', () => {
      const lookup = lookupWith({ x: { title: 'X', bodyMd: 'x body' } });

      expect(expandMentions('bob@note:x', lookup)).toBe('bob@note:x');
      expect(expandMentions('snake_@note:x', lookup)).toBe('snake_@note:x');
    });

    it('expands a mention at the start of the text or after a non-word character', () => {
      const lookup = lookupWith({ x: { title: 'X', bodyMd: 'x body' } });

      expect(expandMentions('(@note:x)', lookup)).toContain('from note @note:x');
      expect(expandMentions('@note:x', lookup)).toContain('from note @note:x');
    });
  });
});
