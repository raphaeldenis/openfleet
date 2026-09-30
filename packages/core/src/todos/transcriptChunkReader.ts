import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs';

const NEWLINE_BYTE = 0x0a;

export interface ChunkRequest {
  /** Where the previous chunk ended: a line boundary, or 0 for the first read. */
  offset: number;
  /** The inode the previous chunk was read from. A different inode means the file was replaced. */
  inode?: number;
  maxBytes: number;
  /** A first read (offset 0) of a file larger than this starts at the last line boundary inside its final `windowBytes`. */
  windowBytes: number;
}

export type ChunkRead =
  | { kind: 'nothing' }
  | { kind: 'reset' }
  | { kind: 'chunk'; text: string; nextOffset: number; inode: number; size: number };

const openWithoutFollowingOrBlocking = (path: string): number | undefined => {
  try {
    return openSync(path, constants.O_RDONLY | constants.O_NONBLOCK | (constants.O_NOFOLLOW ?? 0));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
};

const readBytes = (descriptor: number, from: number, length: number): Buffer => {
  const buffer = Buffer.alloc(length);
  const bytesRead = readSync(descriptor, buffer, 0, length, from);
  return buffer.subarray(0, bytesRead);
};

/**
 * Reads the complete lines of a transcript written since `offset`, at most `maxBytes` of them. A partial last line stays for the next read.
 * A missing file or anything that is not a regular file (a named pipe, a directory) reads as nothing; the open never blocks on a pipe without a writer.
 * A file shorter than `offset`, or with another inode, reads as a reset: the caller starts over from offset 0.
 * A line longer than `maxBytes` is skipped. Any other read error throws.
 */
export function readTranscriptChunk(path: string, request: ChunkRequest): ChunkRead {
  const descriptor = openWithoutFollowingOrBlocking(path);
  if (descriptor === undefined) return { kind: 'nothing' };
  try {
    const stats = fstatSync(descriptor);
    if (!stats.isFile()) return { kind: 'nothing' };
    const { offset, inode, maxBytes, windowBytes } = request;
    const wasReplaced = inode !== undefined && stats.ino !== inode;
    if (wasReplaced || stats.size < offset) return { kind: 'reset' };

    const startsInsideALine = offset === 0 && stats.size > windowBytes;
    const readStart = startsInsideALine ? stats.size - windowBytes - 1 : offset;
    const bytes = readBytes(descriptor, readStart, Math.min(maxBytes, stats.size - readStart));
    const firstWholeLine = startsInsideALine ? bytes.indexOf(NEWLINE_BYTE) + 1 : 0;
    const hasNoWholeLine = startsInsideALine && firstWholeLine === 0;
    const lineStart = readStart + firstWholeLine;
    if (hasNoWholeLine) return { kind: 'chunk', text: '', nextOffset: readStart + bytes.length, inode: stats.ino, size: stats.size };

    const wholeLines = bytes.subarray(firstWholeLine);
    const lastLineBreak = wholeLines.lastIndexOf(NEWLINE_BYTE);
    const isLineLongerThanTheChunk = lastLineBreak === -1 && wholeLines.length >= maxBytes;
    if (isLineLongerThanTheChunk) return { kind: 'chunk', text: '', nextOffset: lineStart + wholeLines.length, inode: stats.ino, size: stats.size };
    const text = wholeLines.subarray(0, lastLineBreak + 1).toString('utf8');
    return { kind: 'chunk', text, nextOffset: lineStart + lastLineBreak + 1, inode: stats.ino, size: stats.size };
  } finally {
    closeSync(descriptor);
  }
}
