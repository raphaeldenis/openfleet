import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writeCrashFile } from './crashFile.js';

const FILE_MODE_MASK = 0o777;
const isRoot = process.getuid?.() === 0;

describe('writeCrashFile', () => {
  let home: string;
  let crashDir: string;
  let nowMs: number;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'of-crash-'));
    crashDir = join(home, 'crashes');
    nowMs = Date.parse('2026-09-30T10:00:00.000Z');
  });
  afterEach(() => {
    chmodSync(home, 0o700);
    rmSync(home, { recursive: true, force: true });
  });

  const crash = (overrides: Partial<Parameters<typeof writeCrashFile>[0]> = {}) => writeCrashFile({
    dir: crashDir, reason: 'uncaught_exception', ref: 'ab12cd34', issues: [], logLines: [], now: () => nowMs, ...overrides,
  });
  const filesInCrashDir = () => readdirSync(crashDir).sort();

  it('writes one json file named after the time and the ref, readable by the owner only', () => {
    const path = crash();

    expect(filesInCrashDir()).toEqual(['2026-09-30T10-00-00.000Z-ab12cd34.json']);
    expect(statSync(path).mode & FILE_MODE_MASK).toBe(0o600);
    expect(statSync(crashDir).mode & FILE_MODE_MASK).toBe(0o700);
  });

  it('records when, why, which ref, what state the daemon was in and the recent log', () => {
    const issues = [{ code: 'db_stuck' as const, since: '2026-09-30T09:59:00.000Z', message: 'the database is not accepting writes.', id: 'deadbeef', count: 2 }];
    const path = crash({ issues, logLines: [JSON.stringify({ level: 'error', msg: 'boom' }), 'not json'] });

    const document = JSON.parse(readFileSync(path, 'utf8'));

    expect(document).toMatchObject({
      generatedAt: '2026-09-30T10:00:00.000Z', reason: 'uncaught_exception', ref: 'ab12cd34',
      version: { node: process.version, platform: process.platform },
      health: { status: 'degraded', issues },
      log: [{ level: 'error', msg: 'boom' }, 'not json'],
    });
  });

  it('keeps only the five newest files: the sixth crash evicts the oldest', () => {
    for (let crashNumber = 1; crashNumber <= 6; crashNumber += 1) {
      nowMs += 1000;
      crash({ ref: `0000000${crashNumber}` });
    }

    const names = filesInCrashDir();
    expect(names).toHaveLength(5);
    expect(names.some((name) => name.endsWith('-00000001.json'))).toBe(false);
    expect(names.at(-1)).toMatch(/-00000006\.json$/);
  });

  it('leaves files it did not write alone when it evicts', () => {
    crash();
    writeFileSync(join(crashDir, 'notes.txt'), 'mine');
    for (let crashNumber = 1; crashNumber <= 6; crashNumber += 1) {
      nowMs += 1000;
      crash({ ref: `0000000${crashNumber}` });
    }

    expect(filesInCrashDir()).toContain('notes.txt');
  });

  it('caps the file at 1 MiB by dropping the oldest log lines', () => {
    const logLines = Array.from({ length: 2000 }, (_, lineNumber) => JSON.stringify({ msg: `line ${lineNumber} ${'x'.repeat(2000)}` }));

    const path = crash({ logLines });

    expect(statSync(path).size).toBeLessThanOrEqual(1024 * 1024);
    const { log } = JSON.parse(readFileSync(path, 'utf8')) as { log: { msg: string }[] };
    expect(log.length).toBeGreaterThan(0);
    expect(log.at(-1)!.msg).toMatch(/^line 1999 /);
  });

  it.skipIf(isRoot)('throws when the directory cannot be written, so the caller decides', () => {
    chmodSync(home, 0o500);

    expect(() => crash()).toThrow();
  });
});
