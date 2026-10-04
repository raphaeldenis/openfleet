import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readUtf8Prefix } from './boundedUtf8File.js';

describe('readUtf8Prefix', () => {
  let folder: string;

  beforeEach(() => {
    folder = mkdtempSync(join(tmpdir(), 'of-bounded-read-'));
  });
  afterEach(() => rmSync(folder, { recursive: true, force: true }));

  const fileWith = (content: string) => {
    const path = join(folder, 'file.md');
    writeFileSync(path, content);
    return path;
  };

  it('returns a file within the limit whole and not truncated', () => {
    expect(readUtf8Prefix({ path: fileWith('abc'), maxBytes: 10 })).toMatchObject({ text: 'abc', isTruncated: false });
  });

  it('returns a file of exactly the limit whole and not truncated', () => {
    expect(readUtf8Prefix({ path: fileWith('abcd'), maxBytes: 4 })).toMatchObject({ text: 'abcd', isTruncated: false });
  });

  it('cuts a longer file at the limit and says so', () => {
    expect(readUtf8Prefix({ path: fileWith('abcdef'), maxBytes: 4 })).toMatchObject({ text: 'abcd', isTruncated: true });
  });

  it('never cuts a character in two: a limit in the middle of an emoji drops the whole emoji', () => {
    const result = readUtf8Prefix({ path: fileWith('ab😀cd'), maxBytes: 4 });

    expect(result).toMatchObject({ text: 'ab', isTruncated: true });
  });

  it('tells the modification time of the file', () => {
    expect(readUtf8Prefix({ path: fileWith('abc'), maxBytes: 10 }).modifiedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('refuses a link, even to a regular file', () => {
    const target = fileWith('abc');
    const link = join(folder, 'link.md');
    symlinkSync(target, link);

    expect(() => readUtf8Prefix({ path: link, maxBytes: 10 })).toThrow();
  });

  it('refuses a folder', () => {
    expect(() => readUtf8Prefix({ path: folder, maxBytes: 10 })).toThrow();
  });
});
