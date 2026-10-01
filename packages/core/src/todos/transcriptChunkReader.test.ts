import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { readTranscriptChunk, type ChunkRead } from './transcriptChunkReader.js';

const BIG = 1024 * 1024;
let directory: string;
let path: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'of-chunk-reader-'));
  path = join(directory, 'transcript.jsonl');
});

const firstRead = (maxBytes = BIG, windowBytes = BIG) => readTranscriptChunk(path, { offset: 0, maxBytes, windowBytes });
const chunkOf = (read: ChunkRead) => {
  if (read.kind !== 'chunk') throw new Error(`expected a chunk, got ${read.kind}`);
  return read;
};

describe('reading a transcript by position', () => {
  it('reads every complete line of a file from the start', () => {
    writeFileSync(path, 'one\ntwo\n');

    const chunk = chunkOf(firstRead());

    expect(chunk.text).toBe('one\ntwo\n');
    expect(chunk.nextOffset).toBe(8);
  });

  it('keeps a line that starts exactly at the start of the window of a file larger than the window', () => {
    writeFileSync(path, 'dropped\nkept-1\nkept-2\n');
    const windowBytes = 'kept-1\nkept-2\n'.length;

    const chunk = chunkOf(firstRead(BIG, windowBytes));

    expect(chunk.text).toBe('kept-1\nkept-2\n');
  });

  it('leaves a partial last line for the next read', () => {
    writeFileSync(path, 'one\ntw');

    const first = chunkOf(firstRead());
    appendFileSync(path, 'o\n');
    const second = chunkOf(readTranscriptChunk(path, { offset: first.nextOffset, inode: first.inode, maxBytes: BIG, windowBytes: BIG }));

    expect(first.text).toBe('one\n');
    expect(second.text).toBe('two\n');
  });

  it('reads only what was appended since the offset', () => {
    writeFileSync(path, 'one\n');
    const first = chunkOf(firstRead());
    appendFileSync(path, 'two\n');

    const second = chunkOf(readTranscriptChunk(path, { offset: first.nextOffset, inode: first.inode, maxBytes: BIG, windowBytes: BIG }));

    expect(second.text).toBe('two\n');
  });

  it('reads a long file in chunks of complete lines, none lost and none read twice', () => {
    const lines = Array.from({ length: 100 }, (_, index) => `line-${index}`);
    writeFileSync(path, `${lines.join('\n')}\n`);

    let read = chunkOf(firstRead(64));
    const texts = [read.text];
    while (read.nextOffset < read.size) {
      read = chunkOf(readTranscriptChunk(path, { offset: read.nextOffset, inode: read.inode, maxBytes: 64, windowBytes: BIG }));
      texts.push(read.text);
    }

    expect(texts.join('')).toBe(`${lines.join('\n')}\n`);
    expect(texts.every((text) => text === '' || text.endsWith('\n'))).toBe(true);
  });

  it('starts a first read of a file larger than the window at the first whole line inside the window', () => {
    const lines = Array.from({ length: 50 }, (_, index) => `line-${String(index).padStart(3, '0')}`);
    writeFileSync(path, `${lines.join('\n')}\n`);

    const chunk = chunkOf(firstRead(BIG, 100));

    const readLines = chunk.text.split('\n').filter(Boolean);
    expect(readLines.length).toBeGreaterThan(0);
    expect(readLines.length).toBeLessThanOrEqual(13);
    expect(readLines.every((line) => lines.includes(line))).toBe(true);
    expect(readLines.at(-1)).toBe('line-049');
  });

  it('skips a line longer than the chunk instead of stalling on it', () => {
    writeFileSync(path, `${'x'.repeat(200)}\nshort\n`);

    const reads: string[] = [];
    let read = chunkOf(firstRead(64));
    reads.push(read.text);
    for (let attempts = 0; attempts < 10 && read.nextOffset < read.size; attempts += 1) {
      read = chunkOf(readTranscriptChunk(path, { offset: read.nextOffset, inode: read.inode, maxBytes: 64, windowBytes: BIG }));
      reads.push(read.text);
    }

    expect(read.nextOffset).toBe(read.size);
    expect(reads.join('')).toContain('short\n');
  });

  it('reports a reset when the file is shorter than the offset', () => {
    writeFileSync(path, 'one\ntwo\nthree\n');
    const first = chunkOf(firstRead());
    writeFileSync(path, 'a\n');

    expect(readTranscriptChunk(path, { offset: first.nextOffset, inode: first.inode, maxBytes: BIG, windowBytes: BIG })).toEqual({ kind: 'reset' });
  });

  it('reports a reset when the file was replaced by one of the same length or longer (another inode)', () => {
    writeFileSync(path, 'one\n');
    const first = chunkOf(firstRead());
    writeFileSync(join(directory, 'next.jsonl'), 'two\nthree\n');
    execFileSync('mv', [join(directory, 'next.jsonl'), path]);

    expect(readTranscriptChunk(path, { offset: first.nextOffset, inode: first.inode, maxBytes: BIG, windowBytes: BIG })).toEqual({ kind: 'reset' });
  });

  it('reads a missing file as nothing, without throwing', () => {
    expect(firstRead()).toEqual({ kind: 'nothing' });
  });

  it('reads a named pipe as nothing, without blocking', () => {
    execFileSync('mkfifo', [path]);

    expect(firstRead()).toEqual({ kind: 'nothing' });
  });

  it('refuses to follow a symbolic link', () => {
    writeFileSync(join(directory, 'real.jsonl'), 'one\n');
    symlinkSync(join(directory, 'real.jsonl'), path);

    expect(() => firstRead()).toThrow();
  });
});
