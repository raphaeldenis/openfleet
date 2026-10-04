import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs';

const CONTINUATION_BYTE_MASK = 0xc0;
const CONTINUATION_BYTE_PREFIX = 0x80;

export interface Utf8Prefix {
  text: string;
  /** The file holds more bytes than the limit: `text` ends before them. */
  isTruncated: boolean;
  modifiedAt: string;
}

/** The end of the text to keep: the limit, moved back before a character that the limit cuts in two. */
function endBeforeCutCharacter(buffer: Buffer, limit: number): number {
  let end = limit;
  while (end > 0 && (buffer[end]! & CONTINUATION_BYTE_MASK) === CONTINUATION_BYTE_PREFIX) end -= 1;
  return end;
}

/**
 * Reads at most `maxBytes` bytes of a regular file through one descriptor, so that the size is bounded before anything is allocated
 * for the content, and returns them as UTF-8 text that never ends inside a character. A link or anything but a regular file throws.
 */
export function readUtf8Prefix({ path, maxBytes }: { path: string; maxBytes: number }): Utf8Prefix {
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stats = fstatSync(descriptor);
    if (!stats.isFile()) throw new Error(`${path} is not a regular file`);
    const buffer = Buffer.alloc(maxBytes + 1);
    let filled = 0;
    while (filled < buffer.length) {
      const readCount = readSync(descriptor, buffer, filled, buffer.length - filled, null);
      if (readCount === 0) break;
      filled += readCount;
    }
    const isTruncated = filled > maxBytes;
    const end = isTruncated ? endBeforeCutCharacter(buffer, maxBytes) : filled;
    return { text: buffer.toString('utf8', 0, end), isTruncated, modifiedAt: stats.mtime.toISOString() };
  } finally {
    closeSync(descriptor);
  }
}
