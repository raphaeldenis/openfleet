import { statSync } from 'node:fs';
import { isAbsolute } from 'node:path';

/**
 * Names the directory a path leads to: two paths share an identity when they reach the same directory,
 * whatever the symbolic links on the way or the letter case the filesystem ignores. Null when no directory is there.
 */
export type DocsFolderIdentity = (path: string) => string | null;

export const nodeDocsFolderIdentity: DocsFolderIdentity = (path) => {
  if (!isAbsolute(path)) return null;
  try {
    const stats = statSync(path);
    return stats.isDirectory() ? `${stats.dev}:${stats.ino}` : null;
  } catch {
    return null;
  }
};
