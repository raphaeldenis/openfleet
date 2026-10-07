import { closeSync, constants, fstatSync, openSync } from 'node:fs';
import type { TranscriptCursor } from '../harness/harness.js';

/** Returns only the identity and byte count of a trusted regular transcript. */
export function transcriptProgress(path: string | undefined): TranscriptCursor | undefined {
  if (path === undefined) return undefined;
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stats = fstatSync(descriptor);
    if (!stats.isFile()) return undefined;
    return { identity: `${stats.dev}:${stats.ino}:${stats.birthtimeMs}`, offset: stats.size };
  } catch {
    return undefined;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}
