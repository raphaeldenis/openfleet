import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { createDegradedRegistry, type DegradedRegistry } from './degradedRegistry.js';
import { EXIT_CODES } from './exitCodes.js';
import { installProcessGuards } from './processGuards.js';

const SECOND_MS = 1000;
const FILE_MODE_MASK = 0o777;
const isRoot = process.getuid?.() === 0;
const REF_PATTERN = /^[0-9a-f]{8}$/;

// The guards listen on the real process (the only way to see that a listener ran instead of Node's fatal default);
// the exit is injected, so a crash loop is observable without the test process dying.
describe('the process guards policy', () => {
  let home: string;
  let crashDir: string;
  let nowMs: number;
  let exit: Mock<(code: number) => void>;
  let degraded: DegradedRegistry;
  const listenersBefore = { rejection: process.listeners('unhandledRejection'), exception: process.listeners('uncaughtException') };

  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    home = mkdtempSync(join(tmpdir(), 'of-guards-'));
    crashDir = join(home, 'crashes');
    nowMs = Date.parse('2026-09-30T10:00:00.000Z');
    exit = vi.fn<(code: number) => void>();
    degraded = createDegradedRegistry({ clock: () => nowMs });
    process.removeAllListeners('unhandledRejection');
    process.removeAllListeners('uncaughtException');
    installProcessGuards(process, { degraded, crashDir, clock: () => nowMs, exit });
  });
  afterEach(() => {
    process.removeAllListeners('unhandledRejection');
    process.removeAllListeners('uncaughtException');
    for (const listener of listenersBefore.rejection) process.on('unhandledRejection', listener);
    for (const listener of listenersBefore.exception) process.on('uncaughtException', listener);
    chmodSync(home, 0o700);
    rmSync(home, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  const escapeException = (error: unknown = new Error('boom')) => process.emit('uncaughtException', error as Error);
  const escapeRejection = (error: unknown = new Error('boom')) => process.emit('unhandledRejection', error, Promise.resolve());
  const crashFiles = () => readdirSync(crashDir).sort();

  it('marks uncaught_exception with a ref, and keeps running, on the first escaped exception', () => {
    escapeException();

    expect(degraded.list()).toMatchObject([{ code: 'uncaught_exception', count: 1, id: expect.stringMatching(REF_PATTERN) }]);
    expect(exit).not.toHaveBeenCalled();
  });

  it('marks uncaught_exception on an unhandled rejection too', () => {
    escapeRejection();

    expect(degraded.list().map((issue) => issue.code)).toEqual(['uncaught_exception']);
    expect(exit).not.toHaveBeenCalled();
  });

  it('logs the crash under the same ref the issue carries', () => {
    const errorLog = vi.spyOn(console, 'error');
    escapeException();

    const [issue] = degraded.list();
    const loggedRecords = errorLog.mock.calls.map(([line]) => JSON.parse(String(line)) as { id?: string });
    expect(loggedRecords.map((record) => record.id)).toContain(issue!.id);
  });

  it('exits 2 on a second uncaught exception within 60 seconds: two escapes in a minute is a loop', () => {
    escapeException();
    nowMs += 59 * SECOND_MS;

    escapeException();

    expect(exit).toHaveBeenCalledExactlyOnceWith(EXIT_CODES.runtimeFatal);
  });

  it('keeps running when the second uncaught exception comes 60 seconds after the first', () => {
    escapeException();
    nowMs += 60 * SECOND_MS;

    escapeException();

    expect(exit).not.toHaveBeenCalled();
    expect(degraded.list()).toMatchObject([{ code: 'uncaught_exception', count: 2 }]);
  });

  it('measures the minute from the latest escape: one every 50 seconds is a loop from the second on', () => {
    escapeException();
    nowMs += 50 * SECOND_MS;
    escapeException();

    expect(exit).toHaveBeenCalledWith(EXIT_CODES.runtimeFatal);
  });

  it('does not count unhandled rejections toward the loop: they mark and continue', () => {
    for (let rejection = 0; rejection < 5; rejection += 1) escapeRejection();

    expect(exit).not.toHaveBeenCalled();
  });

  it('does not count a rejection and an exception together as a loop', () => {
    escapeRejection();
    escapeException();

    expect(exit).not.toHaveBeenCalled();
  });

  it('writes one crash file per escape, owner-only, and the loop exit leaves the file of the crash that caused it', () => {
    escapeException();
    nowMs += 1000;
    escapeException();

    const names = crashFiles();
    expect(names).toHaveLength(2);
    expect(statSync(join(crashDir, names[0]!)).mode & FILE_MODE_MASK).toBe(0o600);
    expect(JSON.parse(readFileSync(join(crashDir, names.at(-1)!), 'utf8'))).toMatchObject({ reason: 'uncaught_exception', health: { status: 'degraded' } });
  });

  it('names an unhandled rejection as such in its crash file', () => {
    escapeRejection();

    const [name] = crashFiles();
    expect(JSON.parse(readFileSync(join(crashDir, name!), 'utf8'))).toMatchObject({ reason: 'unhandled_rejection' });
  });

  it('keeps the five newest crash files', () => {
    for (let escape = 0; escape < 7; escape += 1) {
      nowMs += 120 * SECOND_MS;
      escapeRejection();
    }

    expect(crashFiles()).toHaveLength(5);
  });

  it('writes no secret and no full home path to the crash file', () => {
    const token = 'abcdefghijklmnopqrstuvwxyz0123456789';
    escapeException(new Error(`request to /hooks/${token} failed with Bearer ${token} at ${home}/secret.txt`));

    const content = readFileSync(join(crashDir, crashFiles()[0]!), 'utf8');

    expect(content).not.toContain(token);
  });

  it('survives an error that cannot be printed', () => {
    const hostile = { get message(): string { throw new Error('getter'); }, get stack(): string { throw new Error('getter'); } };

    expect(() => escapeException(hostile)).not.toThrow();

    expect(degraded.list()).toHaveLength(1);
  });

  it('survives a thrown undefined', () => {
    expect(() => process.emit('uncaughtException', undefined as unknown as Error)).not.toThrow();

    expect(degraded.list()).toHaveLength(1);
  });

  it('hostile 7: exits 2 anyway when the crash file cannot be written (the crash directory is a file)', () => {
    writeFileSync(crashDir, 'not a directory');
    escapeException();
    nowMs += SECOND_MS;

    expect(() => escapeException()).not.toThrow();

    expect(exit).toHaveBeenCalledExactlyOnceWith(EXIT_CODES.runtimeFatal);
  });

  it.skipIf(isRoot)('hostile 7: exits 2 anyway on a full or read-only disk (the home is not writable)', () => {
    chmodSync(home, 0o500);
    escapeException();
    nowMs += SECOND_MS;

    escapeException();

    expect(exit).toHaveBeenCalledExactlyOnceWith(EXIT_CODES.runtimeFatal);
  });

  it('exits 2 even when the exit itself is the first thing a broken registry would stop', () => {
    const throwingRegistry = { ...degraded, mark: () => { throw new Error('registry bug'); } } as DegradedRegistry;
    process.removeAllListeners('uncaughtException');
    installProcessGuards(process, { degraded: throwingRegistry, crashDir, clock: () => nowMs, exit });
    escapeException();
    nowMs += SECOND_MS;

    escapeException();

    expect(exit).toHaveBeenCalledExactlyOnceWith(EXIT_CODES.runtimeFatal);
  });
});
