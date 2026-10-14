import { chmodSync, existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTempDirTracker } from '../tempDirTracker.js';
import { CommandPolicyFileReadOnlyError } from './commandPolicyErrors.js';
import { createFileCommandPolicyFile } from './fileCommandPolicyFile.js';

const renames = vi.hoisted(() => ({ beforeRename: undefined as undefined | ((from: string, to: string) => void) }));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, renameSync: (from: string, to: string) => { renames.beforeRename?.(from, to); actual.renameSync(from, to); } };
});

const tempDirs = createTempDirTracker();
afterEach(() => { renames.beforeRename = undefined; tempDirs.removeAll(); });

const newPolicyPath = () => join(tempDirs.make('of-policy-file-'), 'command-policy.json');

describe('the command policy file', () => {
  it('reads nothing when the file does not exist', () => {
    const file = createFileCommandPolicyFile(newPolicyPath());

    expect(file.read()).toBeUndefined();
  });

  it('writes the contents, reads them back and keeps them for the owner only', () => {
    const path = newPolicyPath();
    const file = createFileCommandPolicyFile(path);

    file.write('{"version":1}\n');

    expect(file.read()).toBe('{"version":1}\n');
    expect(readFileSync(path, 'utf8')).toBe('{"version":1}\n');
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it('swaps the new contents in by renaming a temporary file: the old contents are whole until the rename', () => {
    const path = newPolicyPath();
    writeFileSync(path, 'old-contents');
    const file = createFileCommandPolicyFile(path);
    const seenBeforeRename: { target?: string; temporary?: string } = {};
    renames.beforeRename = (from, to) => {
      seenBeforeRename.target = readFileSync(to, 'utf8');
      seenBeforeRename.temporary = readFileSync(from, 'utf8');
    };

    file.write('new-contents');

    expect(seenBeforeRename).toEqual({ target: 'old-contents', temporary: 'new-contents' });
    expect(readFileSync(path, 'utf8')).toBe('new-contents');
  });

  it('keeps the old contents and leaves no temporary file when the swap fails', () => {
    const path = newPolicyPath();
    writeFileSync(path, 'old-contents');
    const file = createFileCommandPolicyFile(path);
    renames.beforeRename = () => { throw new Error('disk gone'); };

    expect(() => file.write('new-contents')).toThrow('disk gone');

    expect(readFileSync(path, 'utf8')).toBe('old-contents');
    expect(readdirSync(join(path, '..'))).toEqual(['command-policy.json']);
  });

  it('refuses to write a read-only file and leaves it alone', () => {
    const path = newPolicyPath();
    writeFileSync(path, 'old-contents');
    chmodSync(path, 0o444);
    const file = createFileCommandPolicyFile(path);

    expect(() => file.write('new-contents')).toThrow(CommandPolicyFileReadOnlyError);

    expect(readFileSync(path, 'utf8')).toBe('old-contents');
    expect(existsSync(`${path}.tmp`)).toBe(false);
  });
});
