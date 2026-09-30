import { chmodSync, lstatSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function makeTreeWritable(path: string): void {
  if (!lstatSync(path).isDirectory()) return;
  chmodSync(path, 0o700);
  for (const entry of readdirSync(path)) makeTreeWritable(join(path, entry));
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
