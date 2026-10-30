import type { ServerEvent } from '@openfleet/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openDatabase } from '../db/database.js';
import { describeError } from '../errors/describeError.js';
import { EventBus } from '../events/eventBus.js';
import { FakeHarness } from '../harness/fakeHarness.js';
import { countsAgainstChildrenCap } from '../managers/managerView.js';
import { SessionService } from './sessionService.js';

const START_SIGNAL_TIMEOUT_MS = 60_000;
const ESCALATION_GRACE_MS = 30_000;
const spec = { name: 'worker', emoji: '🤖', directory: '/tmp', harness: 'fake' } as const;

class HarnessWithOwnStartDelay extends FakeHarness {
  constructor(readonly startSignalTimeoutMs: number) { super(); }
}

type Database = ReturnType<typeof openDatabase>;
interface DaemonOptions { harness?: FakeHarness; firstStartTimeoutMs?: number; launchOutputTimeoutMs?: number; db?: Database }

function bootDaemon({ harness = new FakeHarness(), firstStartTimeoutMs, launchOutputTimeoutMs = 600_000, db = openDatabase(':memory:') }: DaemonOptions = {}) {
  const bus = new EventBus();
  const events: ServerEvent[] = [];
  bus.subscribe((event) => events.push(event));
  const service = new SessionService({ db, bus, harnesses: [harness], baseUrl: 'http://127.0.0.1:0', worktreesRoot: '/tmp/of-wt', describeError, firstStartTimeoutMs, launchOutputTimeoutMs });
  return { service, harness, events, db };
}

const reportSessionStart = (service: SessionService, sessionId: string) =>
  service.applyInput(sessionId, { kind: 'hook', event: { hook_event_name: 'SessionStart', session_id: sessionId, source: 'startup' } });

describe('the start signal timeout of a new session', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('fails the readiness with no_start_signal and the masked, escape-free tail of the harness output', async () => {
    const { service, harness } = bootDaemon();
    const session = await service.create(spec);
    harness.handles[0]!.emitData('\u001b[31mSessionStart:startup hook failed\u001b[0m: Authorization: Bearer abcdef0123456789abcdef');

    await vi.advanceTimersByTimeAsync(START_SIGNAL_TIMEOUT_MS);

    const failed = service.get(session.id)!;
    expect(failed).toMatchObject({ readiness: 'failed', readinessReason: 'no_start_signal', state: 'closed', closeReason: 'resume_timeout' });
    expect(failed.readinessDetail).toContain('SessionStart:startup hook failed');
    expect(failed.readinessDetail).not.toContain('\u001b');
    expect(failed.readinessDetail).not.toContain('abcdef0123456789abcdef');
  });

  it('keeps only the last 2 KiB of the output', async () => {
    const { service, harness } = bootDaemon();
    const session = await service.create(spec);
    harness.handles[0]!.emitData(`${'x'.repeat(10_000)}THE-END`);

    await vi.advanceTimersByTimeAsync(START_SIGNAL_TIMEOUT_MS);

    const detail = service.get(session.id)!.readinessDetail!;
    expect(detail.length).toBeLessThanOrEqual(2048);
    expect(detail.endsWith('THE-END')).toBe(true);
  });

  it('announces session.failed with the reason and the detail', async () => {
    const { service, harness, events } = bootDaemon();
    const session = await service.create(spec);
    harness.handles[0]!.emitData('hook failed: boom');

    await vi.advanceTimersByTimeAsync(START_SIGNAL_TIMEOUT_MS);

    expect(events).toContainEqual({ type: 'session.failed', sessionId: session.id, reason: 'no_start_signal', detail: 'hook failed: boom' });
  });

  it('fails a session that already counted as ready on a PTY byte', async () => {
    const { service, harness } = bootDaemon();
    const session = await service.create(spec);
    harness.handles[0]!.emitData('Welcome');
    expect(service.get(session.id)?.readiness).toBe('ready');

    await vi.advanceTimersByTimeAsync(START_SIGNAL_TIMEOUT_MS);

    expect(service.get(session.id)?.readiness).toBe('failed');
  });

  it('counts the failed session against the children cap until its process is gone, then stops counting it', async () => {
    const { service, harness } = bootDaemon();
    const session = await service.create(spec);
    harness.handles[0]!.ignoresGracefulKill = true;

    await vi.advanceTimersByTimeAsync(START_SIGNAL_TIMEOUT_MS);
    const whileProcessIsStopping = service.get(session.id)!;
    await vi.advanceTimersByTimeAsync(ESCALATION_GRACE_MS);
    const afterClose = service.get(session.id)!;

    expect(whileProcessIsStopping).toMatchObject({ state: 'starting', readiness: 'failed' });
    expect(countsAgainstChildrenCap(whileProcessIsStopping)).toBe(true);
    expect(countsAgainstChildrenCap(afterClose)).toBe(false);
  });

  it('keeps counting a live session whose launch produced no output, with no retry left', async () => {
    const { service } = bootDaemon({ launchOutputTimeoutMs: 30_000, firstStartTimeoutMs: 600_000 });
    const session = await service.create(spec);

    await vi.advanceTimersByTimeAsync(60_000);

    const stalled = service.get(session.id)!;
    expect(stalled).toMatchObject({ state: 'starting', readiness: 'failed', readinessReason: 'no_output_at_launch' });
    expect(countsAgainstChildrenCap(stalled)).toBe(true);
  });

  it('masks the output before cutting it, so a token across the 2 KiB cut leaves no readable part', async () => {
    const { service, harness } = bootDaemon();
    const session = await service.create(spec);
    const runtimeToken = `sk-${'a'.repeat(40)}`;
    const charactersOfTheTokenBeforeTheCut = 20;
    const separatorLength = 1;
    const textAfterTheToken = 'y'.repeat(2048 - (runtimeToken.length - charactersOfTheTokenBeforeTheCut) - separatorLength);
    harness.handles[0]!.emitData(`${'x'.repeat(5_000)} ${runtimeToken} ${textAfterTheToken}`);

    await vi.advanceTimersByTimeAsync(START_SIGNAL_TIMEOUT_MS);

    expect(service.get(session.id)!.readinessDetail).not.toContain('aaaaa');
  });

  it('prefers the daemon\'s explicit start delay over the one its harness declares', async () => {
    const { service } = bootDaemon({ harness: new HarnessWithOwnStartDelay(5_000), firstStartTimeoutMs: 20_000 });
    const session = await service.create(spec);

    await vi.advanceTimersByTimeAsync(19_999);
    expect(service.get(session.id)?.readiness).not.toBe('failed');
    await vi.advanceTimersByTimeAsync(1);

    expect(service.get(session.id)?.readiness).toBe('failed');
  });

  it('closes with the reason of a close requested while the process is being stopped, not resume_timeout', async () => {
    const { service, harness } = bootDaemon();
    const session = await service.create(spec);
    harness.handles[0]!.ignoresGracefulKill = true;
    await vi.advanceTimersByTimeAsync(START_SIGNAL_TIMEOUT_MS);

    void service.close(session.id);
    await vi.advanceTimersByTimeAsync(ESCALATION_GRACE_MS);

    expect(service.get(session.id)).toMatchObject({ state: 'closed', closeReason: 'closed_by_user' });
  });

  describe('a process that survives the force kill', () => {
    const FORCE_KILL_GRACE_MS = 2_000;
    const GRACEFUL_KILL_WAIT_MS = 5_000;

    const bootWithUndyingProcess = async () => {
      const harness = new FakeHarness();
      const bus = new EventBus();
      const service = new SessionService({ db: openDatabase(':memory:'), bus, harnesses: [harness], baseUrl: 'http://127.0.0.1:0', worktreesRoot: '/tmp/of-wt', describeError, forceKillGraceMs: FORCE_KILL_GRACE_MS });
      const session = await service.create(spec);
      harness.handles[0]!.neverDies = true;
      return { service, session, handle: harness.handles[0]! };
    };

    it('closes the session once the grace after the force kill has passed, and frees its slot', async () => {
      const { service, session, handle } = await bootWithUndyingProcess();

      await vi.advanceTimersByTimeAsync(START_SIGNAL_TIMEOUT_MS + GRACEFUL_KILL_WAIT_MS + FORCE_KILL_GRACE_MS - 1);
      expect(service.get(session.id)?.state).toBe('starting');
      await vi.advanceTimersByTimeAsync(1);

      const closed = service.get(session.id)!;
      expect(handle.forceKilled).toBe(true);
      expect(closed).toMatchObject({ state: 'closed', closeReason: 'resume_timeout' });
      expect(countsAgainstChildrenCap(closed)).toBe(false);
    });

    it('closes a session its user closed, with the reason of that close', async () => {
      const { service, session } = await bootWithUndyingProcess();

      void service.close(session.id);
      await vi.advanceTimersByTimeAsync(GRACEFUL_KILL_WAIT_MS + FORCE_KILL_GRACE_MS);

      expect(service.get(session.id)).toMatchObject({ state: 'closed', closeReason: 'closed_by_user' });
    });
  });

  describe('a session found failed by a daemon that did not fail it', () => {
    // The first service is never stopped: its kill escalation stays armed on fake timers that no test here advances before the assertions,
    // and its stale handle is ignored by the resumed session (the active handle map is global to the module).
    const failedInADaemonThatDiesDuringTheEscalation = async () => {
      const first = bootDaemon();
      const session = await first.service.create(spec);
      first.harness.handles[0]!.ignoresGracefulKill = true;
      await vi.advanceTimersByTimeAsync(START_SIGNAL_TIMEOUT_MS);
      return { db: first.db, sessionId: session.id };
    };

    it('clears the failed readiness when a new daemon resumes it at boot, so the child counts against the cap again', async () => {
      const { db, sessionId } = await failedInADaemonThatDiesDuringTheEscalation();
      const restarted = bootDaemon({ db });

      await restarted.service.resumeAll();

      const resumed = restarted.service.get(sessionId)!;
      expect(resumed.readiness).toBeUndefined();
      expect(countsAgainstChildrenCap(resumed)).toBe(true);
    });

    it('clears the failed readiness when a new daemon reopens the closed session', async () => {
      const { db, sessionId } = await failedInADaemonThatDiesDuringTheEscalation();
      await vi.advanceTimersByTimeAsync(ESCALATION_GRACE_MS);
      const restarted = bootDaemon({ db });

      restarted.service.reopen(sessionId);

      const reopened = restarted.service.get(sessionId)!;
      expect(reopened.readiness).toBeUndefined();
      expect(countsAgainstChildrenCap(reopened)).toBe(true);
    });
  });

  it('touches nothing when the harness signals its start in time', async () => {
    const { service, events } = bootDaemon();
    const session = await service.create(spec);
    await vi.advanceTimersByTimeAsync(START_SIGNAL_TIMEOUT_MS - 1);
    reportSessionStart(service, session.id);

    await vi.advanceTimersByTimeAsync(START_SIGNAL_TIMEOUT_MS * 3);

    expect(service.get(session.id)).toMatchObject({ state: 'idle' });
    expect(service.get(session.id)?.readiness).not.toBe('failed');
    expect(events.some((event) => event.type === 'session.failed')).toBe(false);
  });

  it('waits for the delay its own harness declares', async () => {
    const { service } = bootDaemon({ harness: new HarnessWithOwnStartDelay(5_000) });
    const session = await service.create(spec);

    await vi.advanceTimersByTimeAsync(4_999);
    expect(service.get(session.id)?.readiness).not.toBe('failed');
    await vi.advanceTimersByTimeAsync(1);

    expect(service.get(session.id)?.readiness).toBe('failed');
  });

  it('is not resurrected by a late SessionStart or a late PTY byte while the process is being stopped', async () => {
    const { service, harness } = bootDaemon();
    const session = await service.create(spec);
    const handle = harness.handles[0]!;
    handle.ignoresGracefulKill = true;
    await vi.advanceTimersByTimeAsync(START_SIGNAL_TIMEOUT_MS);

    reportSessionStart(service, session.id);
    handle.emitData('late byte');

    expect(service.get(session.id)).toMatchObject({ state: 'starting', readiness: 'failed' });
    await vi.advanceTimersByTimeAsync(ESCALATION_GRACE_MS);
    expect(service.get(session.id)).toMatchObject({ state: 'closed', readiness: 'failed', readinessReason: 'no_start_signal' });
    expect(handle.killed).toBe(true);
  });

  it('stays failed when a PTY byte arrives after the close', async () => {
    const { service, harness } = bootDaemon();
    const session = await service.create(spec);
    await vi.advanceTimersByTimeAsync(START_SIGNAL_TIMEOUT_MS);

    harness.handles[0]!.emitData('late byte');

    expect(service.get(session.id)).toMatchObject({ state: 'closed', readiness: 'failed' });
  });

  it('leaves no timer behind once the session is closed', async () => {
    const { service } = bootDaemon();
    const session = await service.create(spec);

    await service.close(session.id);

    expect(vi.getTimerCount()).toBe(0);
  });

  it('leaves no timer behind once the start signal arrived and the session is closed', async () => {
    const { service } = bootDaemon();
    const session = await service.create(spec);
    reportSessionStart(service, session.id);

    await service.close(session.id);

    expect(vi.getTimerCount()).toBe(0);
  });
});
