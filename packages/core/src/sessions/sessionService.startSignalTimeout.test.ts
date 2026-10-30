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

function bootDaemon({ harness = new FakeHarness(), firstStartTimeoutMs = START_SIGNAL_TIMEOUT_MS }: { harness?: FakeHarness; firstStartTimeoutMs?: number } = {}) {
  const bus = new EventBus();
  const events: ServerEvent[] = [];
  bus.subscribe((event) => events.push(event));
  const service = new SessionService({ db: openDatabase(':memory:'), bus, harnesses: [harness], baseUrl: 'http://127.0.0.1:0', worktreesRoot: '/tmp/of-wt', describeError, firstStartTimeoutMs, launchOutputTimeoutMs: 600_000 });
  return { service, harness, events };
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

  it('does not count the failed session against the children cap, even before its process is gone', async () => {
    const { service, harness } = bootDaemon();
    const session = await service.create(spec);
    harness.handles[0]!.ignoresGracefulKill = true;

    await vi.advanceTimersByTimeAsync(START_SIGNAL_TIMEOUT_MS);

    const failed = service.get(session.id)!;
    expect(failed.state).not.toBe('closed');
    expect(countsAgainstChildrenCap(failed)).toBe(false);
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
