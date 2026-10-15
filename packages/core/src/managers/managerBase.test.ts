import { describe, expect, it } from 'vitest';
import { parseManagerBase } from './managerBase.js';

const SOURCE = ['---', 'version: 3', '---', '', '## §1 Precedence [invariant]', '', 'Hook first.', '', '## §2 Pulse loop [default]', '', 'Status first.', ''].join('\n');

describe('parseManagerBase', () => {
  it('reads the version from the frontmatter and the sections from the headings', () => {
    const base = parseManagerBase(SOURCE);

    expect(base.version).toBe(3);
    expect(base.sections.map(({ id, title, type }) => ({ id, title, type }))).toEqual([
      { id: '§1', title: 'Precedence', type: 'invariant' },
      { id: '§2', title: 'Pulse loop', type: 'default' },
    ]);
  });

  it('counts the bytes of the body and of each section in UTF-8', () => {
    const base = parseManagerBase(SOURCE);

    expect(base.bytes).toBe(Buffer.byteLength(base.body, 'utf8'));
    expect(base.sections[0]!.bytes).toBe(Buffer.byteLength('## §1 Precedence [invariant]\n\nHook first.', 'utf8'));
  });

  it('gives the same sha to a file with Windows line ends and trailing spaces', () => {
    const untidy = SOURCE.replaceAll('\n', '  \r\n');

    expect(parseManagerBase(untidy).sha).toBe(parseManagerBase(SOURCE).sha);
  });

  it('gives another sha to another body', () => {
    expect(parseManagerBase(SOURCE.replace('Hook first.', 'Hook second.')).sha).not.toBe(parseManagerBase(SOURCE).sha);
  });

  it('refuses a file without a version', () => {
    expect(() => parseManagerBase(SOURCE.replace('version: 3', 'edition: 3'))).toThrow(/version/);
  });

  it('refuses a file with text before the first section', () => {
    expect(() => parseManagerBase(SOURCE.replace('## §1', 'Stray line.\n\n## §1'))).toThrow(/before the first section/);
  });

  it('refuses a heading without its invariant or default marker', () => {
    expect(() => parseManagerBase(SOURCE.replace(' [invariant]', ''))).toThrow(/§1/);
  });
});
