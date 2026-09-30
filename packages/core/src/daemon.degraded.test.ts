import type { DaemonIssue } from '@openfleet/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from './config.js';
import { startDaemon, type Daemon } from './daemon.js';
import { inTransaction } from './db/transaction.js';
import { createDegradedRegistry } from './process/degradedRegistry.js';
import { createTempDirTracker } from './tempDirTracker.js';

const tempDirs = createTempDirTracker();
const MINUTE_MS = 60_000;
const HEALTH_SWEEP_MS = 30_000;
const cannotOpenTheDatabase = () => Object.assign(new Error('unable to open database file'), { code: 'ERR_SQLITE_ERROR', errcode: 14 });
let daemon: Daemon | undefined;

const boot = (options?: Parameters<typeof startDaemon>[1]) => startDaemon(loadConfig({ OPENFLEET_HOME: tempDirs.make('of-daemon-degraded-'), OPENFLEET_PORT: '0' }), options);
const health = async () => (await fetch(`${daemon!.server.url}/health`)).json() as Promise<{ ok: boolean; status: string; issues: number }>;

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(async () => {
  await daemon?.close();
  daemon = undefined;
  tempDirs.removeAll();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('the daemon and its degraded registry', () => {
  it('runs with a registry of its own when none is handed over, and /health reports what is marked on it', async () => {
    daemon = await boot();
    expect(await health()).toMatchObject({ ok: true, status: 'ok', issues: 0 });

    daemon.degraded.mark('ws_broadcast_failed', 'a client did not receive an event.');

    expect(await health()).toMatchObject({ ok: true, status: 'degraded', issues: 1 });
  });

  it('uses the registry the process handed over: the guards and the daemon speak about one state', async () => {
    const degraded = createDegradedRegistry();
    daemon = await boot({ degraded });

    degraded.mark('uncaught_exception', 'an unexpected error escaped the daemon.');

    expect(daemon.degraded).toBe(degraded);
    expect(await health()).toMatchObject({ status: 'degraded' });
  });

  it('marks db_stuck when a transaction on the daemon db meets an unavailable database, and clears it on the next commit', async () => {
    daemon = await boot();
    expect(() => inTransaction(daemon!.db, 'probe_fail', () => { throw cannotOpenTheDatabase(); })).toThrow();
    expect(daemon.degraded.list().map((issue) => issue.code)).toEqual(['db_stuck']);

    inTransaction(daemon.db, 'probe_ok', () => 1);

    expect(daemon.degraded.list()).toEqual([]);
  });

  it('stops watching the database once closed', async () => {
    const degraded = createDegradedRegistry();
    daemon = await boot({ degraded });
    const db = daemon.db;
    await daemon.close();
    daemon = undefined;

    const afterClose = () => inTransaction(db, 'probe_after_close', () => { throw cannotOpenTheDatabase(); });

    expect(afterClose).toThrow();
    expect(degraded.list()).toEqual([]);
  });

  it('announces a hook_fail_open that expired without anyone asking: a sweep runs every 30 seconds', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    let nowMs = Date.parse('2026-09-30T10:00:00.000Z');
    const degraded = createDegradedRegistry({ clock: () => nowMs });
    daemon = await boot({ degraded });
    const announced: DaemonIssue[][] = [];
    degraded.onChange((issues) => announced.push(issues));
    for (let failure = 0; failure < 3; failure += 1) degraded.recordHookFailOpen();

    nowMs += 5 * MINUTE_MS;
    await vi.advanceTimersByTimeAsync(HEALTH_SWEEP_MS);

    expect(announced.map((issues) => issues.length)).toEqual([1, 0]);
  });

  it('leaves no sweep running after close', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    daemon = await boot();
    await daemon.close();
    daemon = undefined;

    expect(vi.getTimerCount()).toBe(0);
  });
});
