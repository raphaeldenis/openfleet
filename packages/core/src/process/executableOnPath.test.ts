import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { findExecutable, pathDirectoriesOf } from './executableOnPath.js';

const originalWorkingDirectory = process.cwd();
let scratchDirectory: string;

beforeEach(() => {
  scratchDirectory = realpathSync(mkdtempSync(join(tmpdir(), 'of-executable-on-path-')));
});
afterEach(() => {
  process.chdir(originalWorkingDirectory);
  rmSync(scratchDirectory, { recursive: true, force: true });
});

function makeDirectory(...segments: string[]): string {
  const directory = join(scratchDirectory, ...segments);
  mkdirSync(directory, { recursive: true });
  return directory;
}

function writeFileWithMode(directory: string, name: string, mode: number): string {
  const file = join(directory, name);
  writeFileSync(file, '#!/bin/sh\n');
  chmodSync(file, mode);
  return file;
}

describe('findExecutable', () => {
  it('returns the path of an executable regular file', () => {
    const bin = makeDirectory('bin');
    const claude = writeFileWithMode(bin, 'claude', 0o755);

    expect(findExecutable('claude', [bin])).toBe(claude);
  });

  it('finds nothing in a directory that does not hold the command', () => {
    const bin = makeDirectory('bin');

    expect(findExecutable('claude', [bin])).toBeUndefined();
  });

  it('finds nothing in a directory that does not exist', () => {
    expect(findExecutable('claude', [join(scratchDirectory, 'missing')])).toBeUndefined();
  });

  it('finds a symlink that points to an executable file, reporting the link path', () => {
    const realBin = makeDirectory('real');
    const linkBin = makeDirectory('links');
    const target = writeFileWithMode(realBin, 'claude-real', 0o755);
    symlinkSync(target, join(linkBin, 'claude'));

    expect(findExecutable('claude', [linkBin])).toBe(join(linkBin, 'claude'));
  });

  it('does not find a dangling symlink', () => {
    const bin = makeDirectory('bin');
    symlinkSync(join(scratchDirectory, 'gone'), join(bin, 'claude'));

    expect(findExecutable('claude', [bin])).toBeUndefined();
  });

  it('does not find a directory named like the command, although a directory is searchable', () => {
    const bin = makeDirectory('bin');
    makeDirectory('bin', 'claude');

    expect(findExecutable('claude', [bin])).toBeUndefined();
  });

  it('does not find a symlink to a directory named like the command', () => {
    const bin = makeDirectory('bin');
    const targetDirectory = makeDirectory('target');
    symlinkSync(targetDirectory, join(bin, 'claude'));

    expect(findExecutable('claude', [bin])).toBeUndefined();
  });

  it('does not find a non-executable file (mode 0644)', () => {
    const bin = makeDirectory('bin');
    writeFileWithMode(bin, 'claude', 0o644);

    expect(findExecutable('claude', [bin])).toBeUndefined();
  });

  it('does not find a symlink to a non-executable file', () => {
    const bin = makeDirectory('bin');
    const target = writeFileWithMode(makeDirectory('target'), 'claude-real', 0o644);
    symlinkSync(target, join(bin, 'claude'));

    expect(findExecutable('claude', [bin])).toBeUndefined();
  });

  it('finds the command in a directory whose name contains spaces', () => {
    const bin = makeDirectory('my tools', 'bin dir');
    const claude = writeFileWithMode(bin, 'claude', 0o755);

    expect(findExecutable('claude', [bin])).toBe(claude);
  });

  it('lets the first directory win when two directories hold an executable', () => {
    const first = makeDirectory('first');
    const second = makeDirectory('second');
    const firstClaude = writeFileWithMode(first, 'claude', 0o755);
    writeFileWithMode(second, 'claude', 0o755);

    expect(findExecutable('claude', [first, second])).toBe(firstClaude);
  });

  it('skips an earlier directory whose claude is not executable and returns the later executable one', () => {
    const first = makeDirectory('first');
    const second = makeDirectory('second');
    writeFileWithMode(first, 'claude', 0o644);
    const secondClaude = writeFileWithMode(second, 'claude', 0o755);

    expect(findExecutable('claude', [first, second])).toBe(secondClaude);
  });

  it('resolves a relative entry against the daemon working directory, not against any session directory', () => {
    const daemonDirectory = makeDirectory('daemon');
    writeFileWithMode(makeDirectory('daemon', 'node_modules', '.bin'), 'claude', 0o755);
    process.chdir(daemonDirectory);

    expect(findExecutable('claude', ['node_modules/.bin'])).toBe(join('node_modules/.bin', 'claude'));
  });

  it('does not find a relative entry that holds nothing in the daemon working directory', () => {
    writeFileWithMode(makeDirectory('session', 'node_modules', '.bin'), 'claude', 0o755);
    process.chdir(makeDirectory('daemon'));

    expect(findExecutable('claude', ['node_modules/.bin'])).toBeUndefined();
  });

  it('completes in well under a second when 10 000 directories precede the one holding the command', () => {
    const bin = makeDirectory('bin');
    const claude = writeFileWithMode(bin, 'claude', 0o755);
    const missingDirectories = Array.from({ length: 10_000 }, (_, index) => join(scratchDirectory, `missing-${index}`));
    const startedAt = performance.now();

    const found = findExecutable('claude', [...missingDirectories, bin]);

    expect({ found, fast: performance.now() - startedAt < 1000 }).toEqual({ found: claude, fast: true });
  });
});

describe('pathDirectoriesOf', () => {
  it('splits PATH on the platform delimiter, keeping order', () => {
    expect(pathDirectoriesOf({ PATH: ['/a', '/b', '/c'].join(delimiter) })).toEqual(['/a', '/b', '/c']);
  });

  it('keeps spaces inside an entry and does not trim it, as execvp does', () => {
    expect(pathDirectoriesOf({ PATH: ['/my tools/bin', ' /padded '].join(delimiter) })).toEqual(['/my tools/bin', ' /padded ']);
  });

  it('ignores empty entries (leading, doubled, trailing): deliberately unlike execvp, which reads an empty entry as the current directory, because the daemon PATH comes from launchd or a login shell where an empty entry is an accident', () => {
    const emptyEntries = ['', '/a', '', '/b', ''].join(delimiter);

    expect(pathDirectoriesOf({ PATH: emptyEntries })).toEqual(['/a', '/b']);
  });

  it('never searches the working directory for an empty entry (documented policy, differs from execvp)', () => {
    const daemonDirectory = makeDirectory('daemon');
    writeFileWithMode(daemonDirectory, 'claude', 0o755);
    process.chdir(daemonDirectory);

    const directories = pathDirectoriesOf({ PATH: `${delimiter}${makeDirectory('empty-bin')}` });

    expect(findExecutable('claude', directories)).toBeUndefined();
  });

  it('keeps relative entries as written (documented policy: resolved later against the daemon working directory)', () => {
    expect(pathDirectoriesOf({ PATH: ['node_modules/.bin', './tools'].join(delimiter) })).toEqual(['node_modules/.bin', './tools']);
  });

  it('returns no directory when PATH is unset (documented policy, differs from execvp, which falls back to a default path)', () => {
    expect(pathDirectoriesOf({})).toEqual([]);
  });

  it('returns no directory when PATH is empty, so nothing is found even with claude in the working directory', () => {
    const daemonDirectory = makeDirectory('daemon');
    writeFileWithMode(daemonDirectory, 'claude', 0o755);
    process.chdir(daemonDirectory);

    expect(findExecutable('claude', pathDirectoriesOf({ PATH: '' }))).toBeUndefined();
  });
});
