import { realpathSync, statSync } from 'node:fs';

/** Reads the stored JSON array of paths; anything that is not an array of strings reads as no directory. */
export function parseStoredReadDirectories(stored: string | null): string[] {
  if (stored === null) return [];
  try {
    const parsed: unknown = JSON.parse(stored);
    return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === 'string') : [];
  } catch {
    return [];
  }
}

function isUnchangedExistingDirectory(storedPath: string): boolean {
  try {
    const isItsOwnRealPath = realpathSync.native(storedPath) === storedPath;
    return isItsOwnRealPath && statSync(storedPath).isDirectory();
  } catch {
    return false;
  }
}

/** Keeps the stored paths that are still directories reached without a symlink; a path that moved or changed kind is dropped, never followed. */
export function stillReadableDirectories(storedPaths: string[]): string[] {
  return storedPaths.filter(isUnchangedExistingDirectory);
}
