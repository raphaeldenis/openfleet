import { chmodSync, lstatSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function isMissingEntry(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT';
}

// An entry that disappears while the tree is walked (a background process deleting its own file) has nothing left to open up.
function makeDirectoryWritableAndListEntries(path: string): string[] {
  try {
    if (!lstatSync(path).isDirectory()) return [];
    chmodSync(path, 0o700);
    return readdirSync(path);
  } catch (error) {
    if (isMissingEntry(error)) return [];
    throw error;
  }
}

function makeTreeWritable(path: string): void {
  for (const entry of makeDirectoryWritableAndListEntries(path)) makeTreeWritable(join(path, entry));
}

// Creates temp directories and removes them all afterwards, even those a test left at mode 0500.
export function createTempDirTracker() {
  const created: string[] = [];
  return {
    make(prefix: string): string {
      const directory = mkdtempSync(join(tmpdir(), prefix));
      created.push(directory);
      return directory;
    },
    removeAll(): void {
      for (const directory of created.splice(0)) {
        makeTreeWritable(directory);
        rmSync(directory, { recursive: true, force: true });
      }
    },
  };
}
