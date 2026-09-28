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
  });
});
