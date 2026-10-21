import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTempDirTracker } from './tempDirTracker.js';

type AfterListingHook = (directory: string, entries: string[]) => void;

const hooks = vi.hoisted(() => ({ afterListing: undefined as undefined | AfterListingHook }));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    readdirSync: ((directory: string) => {
      const entries = actual.readdirSync(directory);
      hooks.afterListing?.(directory, entries);
      return entries;
    }) as typeof actual.readdirSync,
  };
});

const tempDirs = createTempDirTracker();

afterEach(() => {
  hooks.afterListing = undefined;
});

function makeReadOnlyDirectoryWithFile(parent: string, name: string): string {
  const directory = join(parent, name);
  mkdirSync(directory);
  writeFileSync(join(directory, 'file.txt'), 'x');
  chmodSync(directory, 0o500);
  return directory;
}

describe('createTempDirTracker', () => {
  describe('removeAll', () => {
    it('removes a tree that contains a read-only directory', () => {
      const root = tempDirs.make('of-tracker-');
      makeReadOnlyDirectoryWithFile(root, 'locked');

      tempDirs.removeAll();

      expect(existsSync(root)).toBe(false);
    });

    it('skips an entry that vanishes after the listing and still frees the other entries', () => {
      const root = tempDirs.make('of-tracker-');
      makeReadOnlyDirectoryWithFile(root, 'first');
      makeReadOnlyDirectoryWithFile(root, 'second');
      hooks.afterListing = (directory, entries) => {
        const isRoot = directory === root;
        if (!isRoot) return;
        const [vanishingEntry] = entries;
        chmodSync(join(root, vanishingEntry!), 0o700);
        rmSync(join(root, vanishingEntry!), { recursive: true, force: true });
      };

      expect(() => tempDirs.removeAll()).not.toThrow();

      expect(existsSync(root)).toBe(false);
    });

    it('rethrows an error that is not a missing entry', () => {
      const root = tempDirs.make('of-tracker-');
      const permissionDenied = Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
      hooks.afterListing = () => {
        throw permissionDenied;
      };

      expect(() => tempDirs.removeAll()).toThrow(permissionDenied);

      hooks.afterListing = undefined;
      rmSync(root, { recursive: true, force: true });
    });
  });
});
