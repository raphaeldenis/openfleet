import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { openDatabase } from '../db/database.js';
import { FakeHandle, FakeHarness } from '../harness/fakeHarness.js';
import type { Harness, HarnessHandle, HarnessLaunch } from '../harness/harness.js';
import { EventBus } from '../events/eventBus.js';
import { DEFAULT_CLOSE_ESCALATE_MS, DELIVERY_RETRY_MS, MAX_DELIVERY_RETRIES, PARKED_RETRY_MS, RESUME_LAUNCH_FAILED_EXIT_CODE, RESUME_TIMEOUT_EXIT_CODE, SessionService, SUBMIT_KEYSTROKE_DELAY_MS, TURN_START_TIMEOUT_MS } from './sessionService.js';
import { MessageQueue } from './messageQueue.js';
import { SessionRepository } from './sessionRepository.js';
import type { ServerEvent } from '@openfleet/shared';

function setup() {
  const db = openDatabase(':memory:');
  const harness = new FakeHarness();
  const bus = new EventBus();
  const events: ServerEvent[] = [];
  bus.subscribe((e) => events.push(e));
  const service = new SessionService({ db, bus, harnesses: [harness], baseUrl: 'http://127.0.0.1:7331', worktreesRoot: '/tmp/of-wt' });
  return { db, harness, bus, events, service };
}
const hook = (session_id: string, event: object) => ({ kind: 'hook' as const, event: { session_id, ...event } as never });

// A handful of tests below opt into fake timers to advance past SUBMIT_KEYSTROKE_DELAY_MS; reset to real
// timers after every test so that doesn't leak into a test that didn't ask for it.
afterEach(() => vi.useRealTimers());

describe('SessionService', () => {
  it('creates a session in starting state and launches the harness with hook/mcp urls', async () => {
    const { service, harness } = setup();
    const session = await service.create({ directory: '/tmp', name: 'Gimli', harness: 'fake', emoji: '⚔️' });
    expect(session.state).toBe('starting');
    expect(harness.launches[0]!.hookUrl).toMatch(/^http:\/\/127\.0\.0\.1:7331\/hooks\/[A-Za-z0-9_-]+$/);
    expect(harness.launches[0]!.displayName).toBe('⚔️ Gimli');
  });

  it('delivers a message immediately when idle, writing the body then the submit keystroke as a separate write after the delay', async () => {
    vi.useFakeTimers();
    const { service, harness } = setup();
    const session = await service.create({ directory: '/tmp', name: 'G', harness: 'fake', emoji: '🤖' });
    service.applyInput(session.id, hook(session.id, { hook_event_name: 'SessionStart' }));
    const result = service.sendMessage({ sessionId: session.id, body: 'do X' });
    expect(result.status).toBe('delivered');
    expect(harness.handles[0]!.written).toEqual(['do X']);
    await vi.advanceTimersByTimeAsync(SUBMIT_KEYSTROKE_DELAY_MS);
    expect(harness.handles[0]!.written).toEqual(['do X', '\r']);
  });

  it('queues while waiting_permission and flushes on idle', async () => {
    vi.useFakeTimers();
    const { service, harness, events } = setup();
    const session = await service.create({ directory: '/tmp', name: 'G', harness: 'fake', emoji: '🤖' });
    service.applyInput(session.id, hook(session.id, { hook_event_name: 'SessionStart' }));
    service.applyInput(session.id, hook(session.id, { hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: {} }));
    const result = service.sendMessage({ sessionId: session.id, body: 'later' });
    expect(result.status).toBe('queued');
    expect(harness.handles[0]!.written).toEqual([]);
    service.applyInput(session.id, { kind: 'permission_resolved' });
    service.applyInput(session.id, hook(session.id, { hook_event_name: 'Stop' }));
    expect(harness.handles[0]!.written).toEqual(['later']);
    await vi.advanceTimersByTimeAsync(SUBMIT_KEYSTROKE_DELAY_MS);
    expect(harness.handles[0]!.written).toEqual(['later', '\r']);
    expect(events.some((e) => e.type === 'message.delivered')).toBe(true);
  });

  it('does not interleave two sends on an idle session: the second queues until the first submit keystroke lands and the session goes idle again', async () => {
    vi.useFakeTimers();
    const { service, harness } = setup();
    const session = await service.create({ directory: '/tmp', name: 'G', harness: 'fake', emoji: '🤖' });
    service.applyInput(session.id, hook(session.id, { hook_event_name: 'SessionStart' }));

    const first = service.sendMessage({ sessionId: session.id, body: 'first' });
    const second = service.sendMessage({ sessionId: session.id, body: 'second' });
    expect(first.status).toBe('delivered');
    expect(second.status).toBe('queued');
    expect(harness.handles[0]!.written).toEqual(['first']);

    await vi.advanceTimersByTimeAsync(SUBMIT_KEYSTROKE_DELAY_MS);
    expect(harness.handles[0]!.written).toEqual(['first', '\r']); // 'second' must not appear before 'first's \r

    // The real Claude Code CLI now processes 'first': generating, then idle again — that's what flushes 'second'.
    service.applyInput(session.id, hook(session.id, { hook_event_name: 'UserPromptSubmit' }));
    service.applyInput(session.id, hook(session.id, { hook_event_name: 'Stop' }));
    expect(harness.handles[0]!.written).toEqual(['first', '\r', 'second']);

    await vi.advanceTimersByTimeAsync(SUBMIT_KEYSTROKE_DELAY_MS);
    expect(harness.handles[0]!.written).toEqual(['first', '\r', 'second', '\r']);
  });

  it('drops the pending submit keystroke silently if the session closes during the delay, without leaking the timer', async () => {
    vi.useFakeTimers();
    const { service, harness } = setup();
    const session = await service.create({ directory: '/tmp', name: 'G', harness: 'fake', emoji: '🤖' });
    service.applyInput(session.id, hook(session.id, { hook_event_name: 'SessionStart' }));

    service.sendMessage({ sessionId: session.id, body: 'do X' });
    expect(harness.handles[0]!.written).toEqual(['do X']);

    expect(() => harness.handles[0]!.emitExit(0)).not.toThrow();
    expect(service.get(session.id)?.state).toBe('closed');
    expect(vi.getTimerCount()).toBe(0);

    await vi.advanceTimersByTimeAsync(SUBMIT_KEYSTROKE_DELAY_MS);
    expect(harness.handles[0]!.written).toEqual(['do X']); // '\r' never gets written to the dead handle
  });

  it('marks session closed on harness exit and keeps the queue', async () => {
    const { service, harness } = setup();
    const session = await service.create({ directory: '/tmp', name: 'G', harness: 'fake', emoji: '🤖' });
    service.sendMessage({ sessionId: session.id, body: 'pending' });
    harness.handles[0]!.emitExit(1);
    expect(service.get(session.id)?.state).toBe('closed');
    expect(service.get(session.id)?.exitCode).toBe(1);
  });

  it('kills the harness on SessionEnd even if the process has not exited on its own', async () => {
    const { service, harness } = setup();
    const session = await service.create({ directory: '/tmp', name: 'G', harness: 'fake', emoji: '🤖' });
    harness.handles[0]!.ignoresGracefulKill = true;
    service.applyInput(session.id, hook(session.id, { hook_event_name: 'SessionEnd' }));
    expect(harness.handles[0]!.killed).toBe(true);
  });

  it('emits session.output for pty data', async () => {
    const { service, harness, events } = setup();
    const session = await service.create({ directory: '/tmp', name: 'G', harness: 'fake', emoji: '🤖' });
    harness.handles[0]!.emitData('hi');
    expect(events).toContainEqual({ type: 'session.output', sessionId: session.id, data: 'hi' });
  });

  it('keeps a ring buffer of recent output for a terminal attaching late', async () => {
    const { service, harness } = setup();
    const session = await service.create({ directory: '/tmp', name: 'G', harness: 'fake', emoji: '🤖' });
    harness.handles[0]!.emitData('hello ');
    harness.handles[0]!.emitData('world');
    expect(service.recentOutput(session.id)).toBe('hello world');
  });

  it('caps the recent output buffer at 200 KB, keeping the tail', async () => {
    const { service, harness } = setup();
    const session = await service.create({ directory: '/tmp', name: 'G', harness: 'fake', emoji: '🤖' });
    harness.handles[0]!.emitData('a'.repeat(200 * 1024));
    harness.handles[0]!.emitData('b'.repeat(10));
    const buffer = service.recentOutput(session.id);
    expect(buffer.length).toBe(200 * 1024);
    expect(buffer.endsWith('b'.repeat(10))).toBe(true);
  });

  it('drops a whole surrogate pair rather than splitting it when trimming the ring buffer', async () => {
    const { service, harness } = setup();
    const session = await service.create({ directory: '/tmp', name: 'G', harness: 'fake', emoji: '🤖' });
    const emoji = '😀'; // U+1F600 — a high + low UTF-16 surrogate pair
    harness.handles[0]!.emitData(emoji);
    harness.handles[0]!.emitData('b'.repeat(200 * 1024 - 1));
    const buffer = service.recentOutput(session.id);
    expect(buffer).not.toMatch(/^[\uDC00-\uDFFF]/);
    expect(buffer).toBe('b'.repeat(200 * 1024 - 1));
  });

  it('close awaits the harness exiting before resolving, without escalating when it exits promptly', async () => {
    const { service, harness } = setup();
    const session = await service.create({ directory: '/tmp', name: 'G', harness: 'fake', emoji: '🤖' });
    await service.close(session.id);
    expect(harness.handles[0]!.forceKilled).toBe(false);
    expect(service.get(session.id)?.state).toBe('closed');
  });

  it('close escalates to a force kill when the harness ignores the first signal', async () => {
    const { service, harness } = setup();
    const session = await service.create({ directory: '/tmp', name: 'G', harness: 'fake', emoji: '🤖' });
    harness.handles[0]!.ignoresGracefulKill = true;
    await service.close(session.id, { escalateAfterMs: 10 });
    expect(harness.handles[0]!.forceKilled).toBe(true);
    expect(service.get(session.id)?.state).toBe('closed');
  });

  it('closeAll kills every live handle and waits for them to exit', async () => {
    const { service, harness } = setup();
    await service.create({ directory: '/tmp', name: 'A', harness: 'fake', emoji: '🤖' });
    await service.create({ directory: '/tmp', name: 'B', harness: 'fake', emoji: '🤖' });
    await service.closeAll();
    expect(harness.handles.every((h) => h.killed)).toBe(true);
    expect(service.list().every((s) => s.state === 'closed')).toBe(true);
  });
});

describe('SessionService resume', () => {
  // Every test here arms a resume timeout (default 15s, or a small resumeTimeoutMs). Fake timers ensure
  // an un-advanced timer is discarded at teardown instead of firing for real seconds after the test ends,
  // against an in-memory db the test has already moved on from.
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('relaunches every non-closed session with --resume, fresh tokens matching the rotated DB row, and marks it starting', async () => {
    const db = openDatabase(':memory:');
    const bus = new EventBus();
    const firstRunHarness = new FakeHarness();
    const original = new SessionService({ db, bus, harnesses: [firstRunHarness], baseUrl: 'http://127.0.0.1:7331', worktreesRoot: '/tmp/of-wt' });
    const session = await original.create({ directory: '/tmp', name: 'Lead', harness: 'fake', emoji: '🧭' });
    const originalTokens = firstRunHarness.launches[0]!;

    // A daemon restart constructs a fresh SessionService over the same, already-populated database.
    const restartHarness = new FakeHarness();
    const restarted = new SessionService({ db, bus, harnesses: [restartHarness], baseUrl: 'http://127.0.0.1:7331', worktreesRoot: '/tmp/of-wt', resumeTimeoutMs: 50 });
    await restarted.resumeAll();

    const rotated = restarted.tokens(session.id)!;
    expect(restartHarness.launches[0]!.resuming).toBe(true);
    expect(restartHarness.launches[0]!.sessionId).toBe(session.id);
    expect(restartHarness.launches[0]!.hookUrl).not.toBe(originalTokens.hookUrl);
    expect(restartHarness.launches[0]!.mcpToken).not.toBe(originalTokens.mcpToken);
    expect(restartHarness.launches[0]!.hookUrl).toBe(`http://127.0.0.1:7331/hooks/${rotated.hookToken}`);
    expect(restartHarness.launches[0]!.mcpToken).toBe(rotated.mcpToken);
    expect(restarted.get(session.id)!.state).toBe('starting');
  });

  it('never resumes a session that was already closed', async () => {
    const db = openDatabase(':memory:');
    const bus = new EventBus();
    const firstRunHarness = new FakeHarness();
    const original = new SessionService({ db, bus, harnesses: [firstRunHarness], baseUrl: 'http://127.0.0.1:7331', worktreesRoot: '/tmp/of-wt' });
    const session = await original.create({ directory: '/tmp', name: 'G', harness: 'fake', emoji: '🤖' });
    firstRunHarness.handles[0]!.emitExit(0);

    const restartHarness = new FakeHarness();
    const restarted = new SessionService({ db, bus, harnesses: [restartHarness], baseUrl: 'http://127.0.0.1:7331', worktreesRoot: '/tmp/of-wt' });
    await restarted.resumeAll();

    expect(restartHarness.launches).toHaveLength(0);
    expect(restarted.get(session.id)!.state).toBe('closed');
  });

  it('a stale process\'s late exit does not close the session resumed in its place', async () => {
    const db = openDatabase(':memory:');
    const bus = new EventBus();
    const firstRunHarness = new FakeHarness();
    const original = new SessionService({ db, bus, harnesses: [firstRunHarness], baseUrl: 'http://127.0.0.1:7331', worktreesRoot: '/tmp/of-wt' });
    const session = await original.create({ directory: '/tmp', name: 'G', harness: 'fake', emoji: '🤖' });
    const staleHandle = firstRunHarness.handles[0]!;

    const restartHarness = new FakeHarness();
    const restarted = new SessionService({ db, bus, harnesses: [restartHarness], baseUrl: 'http://127.0.0.1:7331', worktreesRoot: '/tmp/of-wt', resumeTimeoutMs: 50 });
    await restarted.resumeAll();

    // The pre-restart process's PTY (never actually killed by this test setup — a real daemon crash
    // leaves it running) finally reports its exit, racing the freshly resumed process.
    staleHandle.emitExit(1);

    expect(restarted.get(session.id)!.state).not.toBe('closed');
  });

  it('marks a session closed with RESUME_TIMEOUT_EXIT_CODE if no hook arrives before the resume times out', async () => {
    const db = openDatabase(':memory:');
    const bus = new EventBus();
    const firstRunHarness = new FakeHarness();
    const original = new SessionService({ db, bus, harnesses: [firstRunHarness], baseUrl: 'http://127.0.0.1:7331', worktreesRoot: '/tmp/of-wt' });
    const session = await original.create({ directory: '/tmp', name: 'G', harness: 'fake', emoji: '🤖' });

    const restartHarness = new FakeHarness();
    const restarted = new SessionService({ db, bus, harnesses: [restartHarness], baseUrl: 'http://127.0.0.1:7331', worktreesRoot: '/tmp/of-wt', resumeTimeoutMs: 50 });
    await restarted.resumeAll();

    // The timeout handler now awaits the same kill-with-escalation path close() uses, so advancing
    // must flush the microtasks that chain off it, not just fire the setTimeout callback.
    await vi.advanceTimersByTimeAsync(51);

    expect(restarted.get(session.id)!.state).toBe('closed');
    expect(restarted.get(session.id)!.exitCode).toBe(RESUME_TIMEOUT_EXIT_CODE);
  });

  it('a SessionStart hook after resume cancels the resume timeout, so the session is not later closed', async () => {
    const db = openDatabase(':memory:');
    const bus = new EventBus();
    const firstRunHarness = new FakeHarness();
    const original = new SessionService({ db, bus, harnesses: [firstRunHarness], baseUrl: 'http://127.0.0.1:7331', worktreesRoot: '/tmp/of-wt' });
    const session = await original.create({ directory: '/tmp', name: 'G', harness: 'fake', emoji: '🤖' });

    const restartHarness = new FakeHarness();
    const restarted = new SessionService({ db, bus, harnesses: [restartHarness], baseUrl: 'http://127.0.0.1:7331', worktreesRoot: '/tmp/of-wt', resumeTimeoutMs: 50 });
    await restarted.resumeAll();
    restarted.applyInput(session.id, hook(session.id, { hook_event_name: 'SessionStart' }));

    await vi.advanceTimersByTimeAsync(51);

    expect(restarted.get(session.id)!.state).toBe('idle');
  });

  it('a Notification hook with an unrecognized type does not cancel the resume timeout, since the session never left "starting"', async () => {
    const db = openDatabase(':memory:');
    const bus = new EventBus();
    const firstRunHarness = new FakeHarness();
    const original = new SessionService({ db, bus, harnesses: [firstRunHarness], baseUrl: 'http://127.0.0.1:7331', worktreesRoot: '/tmp/of-wt' });
    const session = await original.create({ directory: '/tmp', name: 'G', harness: 'fake', emoji: '🤖' });

    const restartHarness = new FakeHarness();
    const restarted = new SessionService({ db, bus, harnesses: [restartHarness], baseUrl: 'http://127.0.0.1:7331', worktreesRoot: '/tmp/of-wt', resumeTimeoutMs: 50 });
    await restarted.resumeAll();
    restarted.applyInput(session.id, hook(session.id, { hook_event_name: 'Notification', notification_type: 'some_unrecognized_type' }));

    await vi.advanceTimersByTimeAsync(51);

    expect(restarted.get(session.id)!.state).toBe('closed');
    expect(restarted.get(session.id)!.exitCode).toBe(RESUME_TIMEOUT_EXIT_CODE);
  });

  it('a resume timeout escalates to a force kill when the process ignores the graceful signal, before closing the session', async () => {
    const db = openDatabase(':memory:');
    const bus = new EventBus();
    const firstRunHarness = new FakeHarness();
    const original = new SessionService({ db, bus, harnesses: [firstRunHarness], baseUrl: 'http://127.0.0.1:7331', worktreesRoot: '/tmp/of-wt' });
    const session = await original.create({ directory: '/tmp', name: 'G', harness: 'fake', emoji: '🤖' });

    const restartHarness = new FakeHarness();
    const restarted = new SessionService({ db, bus, harnesses: [restartHarness], baseUrl: 'http://127.0.0.1:7331', worktreesRoot: '/tmp/of-wt', resumeTimeoutMs: 50 });
    await restarted.resumeAll();
    restartHarness.handles[0]!.ignoresGracefulKill = true;

    await vi.advanceTimersByTimeAsync(50 + DEFAULT_CLOSE_ESCALATE_MS + 1);

    expect(restartHarness.handles[0]!.forceKilled).toBe(true);
    expect(restarted.get(session.id)!.state).toBe('closed');
    expect(restarted.get(session.id)!.exitCode).toBe(RESUME_TIMEOUT_EXIT_CODE);
  });

  it('a session resumes with the model that was changed via SessionRepository.setModel after it was created', async () => {
    const db = openDatabase(':memory:');
    const bus = new EventBus();
    const firstRunHarness = new FakeHarness();
    const original = new SessionService({ db, bus, harnesses: [firstRunHarness], baseUrl: 'http://127.0.0.1:7331', worktreesRoot: '/tmp/of-wt' });
    const session = await original.create({ directory: '/tmp', name: 'G', harness: 'fake', emoji: '🤖', model: 'claude-sonnet-5' });
    new SessionRepository(db).setModel(session.id, 'claude-opus-5-5');

    const restartHarness = new FakeHarness();
    const restarted = new SessionService({ db, bus, harnesses: [restartHarness], baseUrl: 'http://127.0.0.1:7331', worktreesRoot: '/tmp/of-wt', resumeTimeoutMs: 50 });
    await restarted.resumeAll();

    expect(restartHarness.launches[0]!.model).toBe('claude-opus-5-5');
  });

  it('a harness.start failure while resuming one session does not stop the next session from resuming', async () => {
    const db = openDatabase(':memory:');
    const bus = new EventBus();
    const firstRunHarness = new FakeHarness();
    const original = new SessionService({ db, bus, harnesses: [firstRunHarness], baseUrl: 'http://127.0.0.1:7331', worktreesRoot: '/tmp/of-wt' });
    const badSession = await original.create({ directory: '/tmp', name: 'Bad', harness: 'fake', emoji: '💥' });
    const goodSession = await original.create({ directory: '/tmp', name: 'Good', harness: 'fake', emoji: '✅' });

    class ThrowingOnceHarness implements Harness {
      readonly id = 'fake' as const;
      readonly launches: HarnessLaunch[] = [];
      start(launch: HarnessLaunch): HarnessHandle {
        this.launches.push(launch);
        if (launch.sessionId === badSession.id) throw new Error('cannot resume without a valid session id');
        return new FakeHandle();
      }
    }
    const restartHarness = new ThrowingOnceHarness();
    const restarted = new SessionService({ db, bus, harnesses: [restartHarness], baseUrl: 'http://127.0.0.1:7331', worktreesRoot: '/tmp/of-wt', resumeTimeoutMs: 50 });
    await restarted.resumeAll();

    expect(restarted.get(badSession.id)!.state).toBe('closed');
    expect(restarted.get(goodSession.id)!.state).toBe('starting');
  });

  it('a repo.setState failure while resuming one session does not stop the next session from resuming', async () => {
    const db = openDatabase(':memory:');
    const bus = new EventBus();
    const firstRunHarness = new FakeHarness();
    const original = new SessionService({ db, bus, harnesses: [firstRunHarness], baseUrl: 'http://127.0.0.1:7331', worktreesRoot: '/tmp/of-wt' });
    const badSession = await original.create({ directory: '/tmp', name: 'Bad', harness: 'fake', emoji: '💥' });
    const goodSession = await original.create({ directory: '/tmp', name: 'Good', harness: 'fake', emoji: '✅' });

    const originalSetState = SessionRepository.prototype.setState;
    const setStateSpy = vi.spyOn(SessionRepository.prototype, 'setState').mockImplementation(function (this: SessionRepository, id, state, since) {
      if (id === badSession.id) throw new Error('setState boom');
      return originalSetState.call(this, id, state, since);
    });

    const restartHarness = new FakeHarness();
    const restarted = new SessionService({ db, bus, harnesses: [restartHarness], baseUrl: 'http://127.0.0.1:7331', worktreesRoot: '/tmp/of-wt', resumeTimeoutMs: 50 });
    await restarted.resumeAll();
    setStateSpy.mockRestore();

    expect(restartHarness.handles[0]!.killed).toBe(true);
    expect(restarted.get(badSession.id)!.state).toBe('closed');
    expect(restarted.get(badSession.id)!.exitCode).toBe(RESUME_LAUNCH_FAILED_EXIT_CODE);
    expect(restarted.get(goodSession.id)!.state).toBe('starting');
  });

  it('a repo.setState failure whose own cleanup (setClosed) also fails still lets the next session resume', async () => {
    const db = openDatabase(':memory:');
    const bus = new EventBus();
    const firstRunHarness = new FakeHarness();
    const original = new SessionService({ db, bus, harnesses: [firstRunHarness], baseUrl: 'http://127.0.0.1:7331', worktreesRoot: '/tmp/of-wt' });
    const badSession = await original.create({ directory: '/tmp', name: 'Bad', harness: 'fake', emoji: '💥' });
    const goodSession = await original.create({ directory: '/tmp', name: 'Good', harness: 'fake', emoji: '✅' });

    const originalSetState = SessionRepository.prototype.setState;
    const setStateSpy = vi.spyOn(SessionRepository.prototype, 'setState').mockImplementation(function (this: SessionRepository, id, state, since) {
      if (id === badSession.id) throw new Error('setState boom');
      return originalSetState.call(this, id, state, since);
    });
    const originalSetClosed = SessionRepository.prototype.setClosed;
    const setClosedSpy = vi.spyOn(SessionRepository.prototype, 'setClosed').mockImplementation(function (this: SessionRepository, id, exitCode, at) {
      if (id === badSession.id) throw new Error('setClosed boom');
      return originalSetClosed.call(this, id, exitCode, at);
    });
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const restartHarness = new FakeHarness();
    const restarted = new SessionService({ db, bus, harnesses: [restartHarness], baseUrl: 'http://127.0.0.1:7331', worktreesRoot: '/tmp/of-wt', resumeTimeoutMs: 50 });
    await restarted.resumeAll();
    setStateSpy.mockRestore();
    setClosedSpy.mockRestore();

    expect(restartHarness.handles[0]!.killed).toBe(true);
    expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
    expect(restarted.get(goodSession.id)!.state).toBe('starting');
    consoleErrorSpy.mockRestore();
  });

  it('resumes a legacy "default" permission_mode as manual', async () => {
    const db = openDatabase(':memory:');
    const bus = new EventBus();
    const firstRunHarness = new FakeHarness();
    const original = new SessionService({ db, bus, harnesses: [firstRunHarness], baseUrl: 'http://127.0.0.1:7331', worktreesRoot: '/tmp/of-wt' });
    await original.create({ directory: '/tmp', name: 'G', harness: 'fake', emoji: '🤖', permissionMode: 'default' });

    const restartHarness = new FakeHarness();
    const restarted = new SessionService({ db, bus, harnesses: [restartHarness], baseUrl: 'http://127.0.0.1:7331', worktreesRoot: '/tmp/of-wt', resumeTimeoutMs: 50 });
    await restarted.resumeAll();

    expect(restartHarness.launches[0]!.permissionMode).toBe('manual');
  });

  it('resumes with --permission-mode omitted and logs once when the stored permission_mode is unrecognized', async () => {
    const db = openDatabase(':memory:');
    const bus = new EventBus();
    const firstRunHarness = new FakeHarness();
    const original = new SessionService({ db, bus, harnesses: [firstRunHarness], baseUrl: 'http://127.0.0.1:7331', worktreesRoot: '/tmp/of-wt' });
    const session = await original.create({ directory: '/tmp', name: 'G', harness: 'fake', emoji: '🤖' });
    db.prepare('UPDATE sessions SET permission_mode = ? WHERE id = ?').run('garbage', session.id);

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const restartHarness = new FakeHarness();
    const restarted = new SessionService({ db, bus, harnesses: [restartHarness], baseUrl: 'http://127.0.0.1:7331', worktreesRoot: '/tmp/of-wt', resumeTimeoutMs: 50 });
    await restarted.resumeAll();

    expect(restartHarness.launches[0]!.permissionMode).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it('resumes an already-valid stored permission_mode unchanged (not just the legacy "default" alias)', async () => {
    const db = openDatabase(':memory:');
    const bus = new EventBus();
    const firstRunHarness = new FakeHarness();
    const original = new SessionService({ db, bus, harnesses: [firstRunHarness], baseUrl: 'http://127.0.0.1:7331', worktreesRoot: '/tmp/of-wt' });
    await original.create({ directory: '/tmp', name: 'G', harness: 'fake', emoji: '🤖', permissionMode: 'plan' });

    const restartHarness = new FakeHarness();
    const restarted = new SessionService({ db, bus, harnesses: [restartHarness], baseUrl: 'http://127.0.0.1:7331', worktreesRoot: '/tmp/of-wt', resumeTimeoutMs: 50 });
    await restarted.resumeAll();

    expect(restartHarness.launches[0]!.permissionMode).toBe('plan');
  });

  // PERMISSION_MODES (packages/shared/src/session.ts) does not include 'manual' yet (P2-T06b, Amendment
  // A1, has not landed on this branch). A row already carrying the literal 'manual' — which is exactly
  // what a session will look like the moment P2-T06b lands and writes 'manual' as the default — is
  // unreachable through the typed public API, so this reaches into the DB directly the way the
  // "unrecognized" test above already does.
  it('a stored "manual" permission_mode resumes as "manual"', async () => {
    const db = openDatabase(':memory:');
    const bus = new EventBus();
    const firstRunHarness = new FakeHarness();
    const original = new SessionService({ db, bus, harnesses: [firstRunHarness], baseUrl: 'http://127.0.0.1:7331', worktreesRoot: '/tmp/of-wt' });
    const session = await original.create({ directory: '/tmp', name: 'G', harness: 'fake', emoji: '🤖' });
    db.prepare('UPDATE sessions SET permission_mode = ? WHERE id = ?').run('manual', session.id);

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const restartHarness = new FakeHarness();
    const restarted = new SessionService({ db, bus, harnesses: [restartHarness], baseUrl: 'http://127.0.0.1:7331', worktreesRoot: '/tmp/of-wt', resumeTimeoutMs: 50 });
    await restarted.resumeAll();

    expect(restartHarness.launches[0]!.permissionMode).toBe('manual');
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('a non-SessionStart hook event after resume still cancels the resume timeout, since any hook proves the process is alive', async () => {
    const db = openDatabase(':memory:');
    const bus = new EventBus();
    const firstRunHarness = new FakeHarness();
    const original = new SessionService({ db, bus, harnesses: [firstRunHarness], baseUrl: 'http://127.0.0.1:7331', worktreesRoot: '/tmp/of-wt' });
    const session = await original.create({ directory: '/tmp', name: 'G', harness: 'fake', emoji: '🤖' });

    const restartHarness = new FakeHarness();
    const restarted = new SessionService({ db, bus, harnesses: [restartHarness], baseUrl: 'http://127.0.0.1:7331', worktreesRoot: '/tmp/of-wt', resumeTimeoutMs: 50 });
    await restarted.resumeAll();
    restarted.applyInput(session.id, hook(session.id, { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: {} }));

    await vi.advanceTimersByTimeAsync(51);

    expect(restarted.get(session.id)!.state).not.toBe('closed');
  });

  it('closeAll after a successful resume kills the resumed handle, not the stale pre-restart one', async () => {
    const db = openDatabase(':memory:');
    const bus = new EventBus();
    const firstRunHarness = new FakeHarness();
    const original = new SessionService({ db, bus, harnesses: [firstRunHarness], baseUrl: 'http://127.0.0.1:7331', worktreesRoot: '/tmp/of-wt' });
    await original.create({ directory: '/tmp', name: 'G', harness: 'fake', emoji: '🤖' });
    const staleHandle = firstRunHarness.handles[0]!;

    const restartHarness = new FakeHarness();
    const restarted = new SessionService({ db, bus, harnesses: [restartHarness], baseUrl: 'http://127.0.0.1:7331', worktreesRoot: '/tmp/of-wt' });
    await restarted.resumeAll();
    await restarted.closeAll();

    expect(restartHarness.handles[0]!.killed).toBe(true);
    expect(staleHandle.killed).toBe(false);
  });

  it('calling resumeAll twice launches each session once', async () => {
    const db = openDatabase(':memory:');
    const bus = new EventBus();
    const firstRunHarness = new FakeHarness();
    const original = new SessionService({ db, bus, harnesses: [firstRunHarness], baseUrl: 'http://127.0.0.1:7331', worktreesRoot: '/tmp/of-wt' });
    await original.create({ directory: '/tmp', name: 'G', harness: 'fake', emoji: '🤖' });

    const restartHarness = new FakeHarness();
    const restarted = new SessionService({ db, bus, harnesses: [restartHarness], baseUrl: 'http://127.0.0.1:7331', worktreesRoot: '/tmp/of-wt', resumeTimeoutMs: 50 });
    await restarted.resumeAll();
    await restarted.resumeAll();

    expect(restartHarness.launches).toHaveLength(1);
  });

  it('a message queued before the restart, while the session was not deliverable, is delivered to the resumed handle once it goes idle again', async () => {
    const db = openDatabase(':memory:');
    const bus = new EventBus();
    const firstRunHarness = new FakeHarness();
    const original = new SessionService({ db, bus, harnesses: [firstRunHarness], baseUrl: 'http://127.0.0.1:7331', worktreesRoot: '/tmp/of-wt' });
    const session = await original.create({ directory: '/tmp', name: 'G', harness: 'fake', emoji: '🤖' });
    original.applyInput(session.id, hook(session.id, { hook_event_name: 'SessionStart' }));
    original.applyInput(session.id, hook(session.id, { hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: {} }));
    const queued = original.sendMessage({ sessionId: session.id, body: 'queued before crash' });
    expect(queued.status).toBe('queued');

    const restartHarness = new FakeHarness();
    const restarted = new SessionService({ db, bus, harnesses: [restartHarness], baseUrl: 'http://127.0.0.1:7331', worktreesRoot: '/tmp/of-wt' });
    await restarted.resumeAll();
    restarted.applyInput(session.id, hook(session.id, { hook_event_name: 'SessionStart' }));

    expect(restartHarness.handles[0]!.written).toEqual(['queued before crash']);
    await vi.advanceTimersByTimeAsync(SUBMIT_KEYSTROKE_DELAY_MS);
    expect(restartHarness.handles[0]!.written).toEqual(['queued before crash', '\r']);
  });

  it('after close, a fresh session created on the same service is unaffected by the closed session and closeAll only kills the live one', async () => {
    const { service, harness } = setup();
    const closedSession = await service.create({ directory: '/tmp', name: 'Old', harness: 'fake', emoji: '🤖' });
    await service.close(closedSession.id);

    const freshSession = await service.create({ directory: '/tmp', name: 'New', harness: 'fake', emoji: '🤖' });
    await service.closeAll();

    expect(service.get(closedSession.id)!.state).toBe('closed');
    expect(harness.handles[1]!.killed).toBe(true);
    expect(service.get(freshSession.id)!.state).toBe('closed');
  });
});

describe('SessionService.updateModel', () => {
  it('relaunches an idle session with --resume and the new model instead of typing /model, rotating tokens', async () => {
    vi.useFakeTimers();
    const { service, harness, events } = setup();
    const session = await service.create({ directory: '/tmp', name: 'G', harness: 'fake', emoji: '🤖' });
    service.applyInput(session.id, hook(session.id, { hook_event_name: 'SessionStart' }));
    const originalTokens = service.tokens(session.id)!;

    const result = service.updateModel(session.id, 'claude-opus-5-5');
    await vi.advanceTimersByTimeAsync(0);

    expect(result.status).toBe('relaunching');
    expect(service.get(session.id)!.model).toBe('claude-opus-5-5');
    expect(events).toContainEqual({ type: 'session.model_changed', sessionId: session.id, model: 'claude-opus-5-5' });
    expect(harness.handles[0]!.written).toEqual([]); // never typed '/model' into the old handle
    expect(harness.handles[0]!.killed).toBe(true);
    expect(harness.launches[1]!.resuming).toBe(true);
    expect(harness.launches[1]!.sessionId).toBe(session.id);
    expect(harness.launches[1]!.model).toBe('claude-opus-5-5');
    const rotated = service.tokens(session.id)!;
    expect(rotated.hookToken).not.toBe(originalTokens.hookToken);
    expect(rotated.mcpToken).not.toBe(originalTokens.mcpToken);
    expect(service.get(session.id)!.state).toBe('starting');

    // The relaunched process reports SessionStart exactly like a fresh resume: same path, same landing state.
    service.applyInput(session.id, hook(session.id, { hook_event_name: 'SessionStart' }));
    expect(service.get(session.id)!.state).toBe('idle');
  });

  it('defers a model switch while generating, still records the target model, and relaunches only after Stop makes the session idle again', async () => {
    vi.useFakeTimers();
    const { service, harness } = setup();
    const session = await service.create({ directory: '/tmp', name: 'G', harness: 'fake', emoji: '🤖' });
    service.applyInput(session.id, hook(session.id, { hook_event_name: 'SessionStart' }));
    service.applyInput(session.id, hook(session.id, { hook_event_name: 'UserPromptSubmit' }));

    const result = service.updateModel(session.id, 'claude-opus-5-5');
    await vi.advanceTimersByTimeAsync(0);

    expect(result.status).toBe('deferred');
    expect(service.get(session.id)!.model).toBe('claude-opus-5-5');
    expect(harness.launches).toHaveLength(1); // no relaunch yet
    expect(harness.handles[0]!.written).toEqual([]);

    service.applyInput(session.id, hook(session.id, { hook_event_name: 'Stop' }));
    await vi.advanceTimersByTimeAsync(0);

    expect(harness.launches).toHaveLength(2);
    expect(harness.launches[1]!.resuming).toBe(true);
    expect(harness.launches[1]!.model).toBe('claude-opus-5-5');
    expect(harness.handles[0]!.written).toEqual([]);
  });

  it('defers a model switch while waiting on a permission prompt, relaunching only once resolved and idle again', async () => {
    vi.useFakeTimers();
    const { service, harness } = setup();
    const session = await service.create({ directory: '/tmp', name: 'G', harness: 'fake', emoji: '🤖' });
    service.applyInput(session.id, hook(session.id, { hook_event_name: 'SessionStart' }));
    service.applyInput(session.id, hook(session.id, { hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: {} }));

    const result = service.updateModel(session.id, 'claude-opus-5-5');
    await vi.advanceTimersByTimeAsync(0);

    expect(result.status).toBe('deferred');
    expect(harness.launches).toHaveLength(1);

    service.applyInput(session.id, { kind: 'permission_resolved' });
    await vi.advanceTimersByTimeAsync(0);
    expect(harness.launches).toHaveLength(1); // resolved goes to 'generating', still not deliverable

    service.applyInput(session.id, hook(session.id, { hook_event_name: 'Stop' }));
    await vi.advanceTimersByTimeAsync(0);

    expect(harness.launches).toHaveLength(2);
    expect(harness.launches[1]!.model).toBe('claude-opus-5-5');
  });

  it('delivers a message queued before a model switch exactly once, after the relaunch completes', async () => {
    vi.useFakeTimers();
    const { service, harness } = setup();
    const session = await service.create({ directory: '/tmp', name: 'G', harness: 'fake', emoji: '🤖' });
    service.applyInput(session.id, hook(session.id, { hook_event_name: 'SessionStart' }));
    service.applyInput(session.id, hook(session.id, { hook_event_name: 'UserPromptSubmit' }));

    const queued = service.sendMessage({ sessionId: session.id, body: 'do X' });
    expect(queued.status).toBe('queued');
    service.updateModel(session.id, 'claude-opus-5-5');
    await vi.advanceTimersByTimeAsync(0);

    service.applyInput(session.id, hook(session.id, { hook_event_name: 'Stop' }));
    await vi.advanceTimersByTimeAsync(0);

    // The relaunch fires first: the queued message is not typed into the old (now-dead) handle.
    expect(harness.launches).toHaveLength(2);
    expect(harness.handles[0]!.written).toEqual([]);
    expect(harness.handles[1]!.written).toEqual([]);

    // The resumed process reports SessionStart, going idle again — only now is the queued message delivered.
    service.applyInput(session.id, hook(session.id, { hook_event_name: 'SessionStart' }));
    expect(harness.handles[1]!.written).toEqual(['do X']);
    await vi.advanceTimersByTimeAsync(SUBMIT_KEYSTROKE_DELAY_MS);
    expect(harness.handles[1]!.written).toEqual(['do X', '\r']);

    // Exactly once: a further idle round must not retype it.
    service.applyInput(session.id, hook(session.id, { hook_event_name: 'UserPromptSubmit' }));
    service.applyInput(session.id, hook(session.id, { hook_event_name: 'Stop' }));
    expect(harness.handles[1]!.written).toEqual(['do X', '\r']);
  });

  it('rejects a model switch on a session that has already closed', async () => {
    const { service, harness } = setup();
    const session = await service.create({ directory: '/tmp', name: 'G', harness: 'fake', emoji: '🤖' });
    service.applyInput(session.id, hook(session.id, { hook_event_name: 'SessionStart' }));
    harness.handles[0]!.emitExit(0);
    expect(service.get(session.id)!.state).toBe('closed');

    expect(() => service.updateModel(session.id, 'claude-opus-5-5')).toThrow();
    expect(service.get(session.id)!.model).toBeUndefined();
    expect(harness.handles[0]!.written).toEqual([]);
  });
});

describe('SessionService.updateModel hostile cases', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('two model switches requested while generating produce exactly one relaunch, launched with the last model requested', async () => {
    vi.useFakeTimers();
    const { service, harness } = setup();
    const session = await service.create({ directory: '/tmp', name: 'G', harness: 'fake', emoji: '🤖' });
    service.applyInput(session.id, hook(session.id, { hook_event_name: 'SessionStart' }));
    service.applyInput(session.id, hook(session.id, { hook_event_name: 'UserPromptSubmit' }));

    const first = service.updateModel(session.id, 'claude-opus-5-5');
    const second = service.updateModel(session.id, 'claude-haiku-4-5');
    await vi.advanceTimersByTimeAsync(0);

    expect(first.status).toBe('deferred');
    expect(second.status).toBe('deferred');
    expect(service.get(session.id)!.model).toBe('claude-haiku-4-5');
    expect(harness.launches).toHaveLength(1); // still generating, no relaunch yet

    service.applyInput(session.id, hook(session.id, { hook_event_name: 'Stop' }));
    await vi.advanceTimersByTimeAsync(0);

    expect(harness.launches).toHaveLength(2); // exactly one relaunch, not two
    expect(harness.launches[1]!.model).toBe('claude-haiku-4-5'); // the second call's model wins, not the first
  });

  it('a model switch requested while already relaunching is deferred, and forces a second, redundant relaunch once the resumed session goes idle', async () => {
    vi.useFakeTimers();
    const { service, harness } = setup();
    const session = await service.create({ directory: '/tmp', name: 'G', harness: 'fake', emoji: '🤖' });
    service.applyInput(session.id, hook(session.id, { hook_event_name: 'SessionStart' }));
    harness.handles[0]!.ignoresGracefulKill = true; // keeps the first relaunch's kill escalation in flight

    const first = service.updateModel(session.id, 'claude-opus-5-5');
    expect(first.status).toBe('relaunching');
    expect(harness.launches).toHaveLength(1); // kill escalation hasn't resolved yet

    const second = service.updateModel(session.id, 'claude-haiku-4-5');
    expect(second.status).toBe('deferred'); // the 'relaunching' phase is never treated as 'ready'
    expect(service.get(session.id)!.model).toBe('claude-haiku-4-5');

    await vi.advanceTimersByTimeAsync(DEFAULT_CLOSE_ESCALATE_MS + 1); // force-kills the old process, first relaunch completes
    expect(harness.launches).toHaveLength(2);
    expect(harness.launches[1]!.model).toBe('claude-haiku-4-5'); // already picked up the second call's model
    expect(service.get(session.id)!.state).toBe('starting'); // not deliverable yet: the deferred second relaunch has not fired

    service.applyInput(session.id, hook(session.id, { hook_event_name: 'SessionStart' }));
    await vi.advanceTimersByTimeAsync(0);

    // Surprise: the second call landed on the same model the first relaunch already resumed under, but the
    // deferred flag survives the first relaunch's completion and fires a THIRD launch regardless, as soon as
    // the resumed session becomes deliverable again — a redundant CLI restart, not a correctness bug.
    expect(harness.launches).toHaveLength(3);
    expect(harness.launches[2]!.model).toBe('claude-haiku-4-5');
  });

  it('when the resumed process never reports back, the relaunch times out to closed, still recording the new model and leaving queued messages queued', async () => {
    vi.useFakeTimers();
    const db = openDatabase(':memory:');
    const bus = new EventBus();
    const harness = new FakeHarness();
    const service = new SessionService({ db, bus, harnesses: [harness], baseUrl: 'http://127.0.0.1:7331', worktreesRoot: '/tmp/of-wt', resumeTimeoutMs: 50 });
    const session = await service.create({ directory: '/tmp', name: 'G', harness: 'fake', emoji: '🤖' });
    service.applyInput(session.id, hook(session.id, { hook_event_name: 'SessionStart' }));
    service.applyInput(session.id, hook(session.id, { hook_event_name: 'UserPromptSubmit' }));
    service.sendMessage({ sessionId: session.id, body: 'still pending' });

    service.updateModel(session.id, 'claude-opus-5-5');
    service.applyInput(session.id, hook(session.id, { hook_event_name: 'Stop' }));
    await vi.advanceTimersByTimeAsync(0); // relaunch fires, second handle starts waiting for SessionStart

    expect(harness.launches).toHaveLength(2);

    // The resumed process never sends SessionStart (or any hook): the resume timeout fires and closes it.
    await vi.advanceTimersByTimeAsync(51);

    expect(service.get(session.id)!.state).toBe('closed');
    expect(service.get(session.id)!.exitCode).toBe(RESUME_TIMEOUT_EXIT_CODE);
    expect(service.get(session.id)!.model).toBe('claude-opus-5-5'); // recorded even though the process resumed under it never actually ran
    expect(service.hasQueuedMessage(session.id, 'still pending')).toBe(true); // the queue is untouched by markClosed
  });

  it('a relaunch escalates to a force kill when the old process ignores the graceful signal, leaving exactly one live handle', async () => {
    vi.useFakeTimers();
    const { service, harness } = setup();
    const session = await service.create({ directory: '/tmp', name: 'G', harness: 'fake', emoji: '🤖' });
    service.applyInput(session.id, hook(session.id, { hook_event_name: 'SessionStart' }));
    harness.handles[0]!.ignoresGracefulKill = true;

    service.updateModel(session.id, 'claude-opus-5-5');
    await vi.advanceTimersByTimeAsync(DEFAULT_CLOSE_ESCALATE_MS + 1);

    expect(harness.handles[0]!.forceKilled).toBe(true);
    expect(harness.launches).toHaveLength(2);
    expect(service.harnessHandle(session.id)).toBe(harness.handles[1]);

    // A stray, late exit event from the already force-killed old process must not affect the resumed session.
    harness.handles[0]!.emitExit(1);
    expect(service.get(session.id)!.state).not.toBe('closed');
  });

  it('a model switch requested while a message is mid-delivery (already typed into the composer) waits for that submit to complete before relaunching', async () => {
    vi.useFakeTimers();
    const { service, harness } = setup();
    const session = await service.create({ directory: '/tmp', name: 'G', harness: 'fake', emoji: '🤖' });
    service.applyInput(session.id, hook(session.id, { hook_event_name: 'SessionStart' }));

    service.sendMessage({ sessionId: session.id, body: 'do X' });
    expect(harness.handles[0]!.written).toEqual(['do X']); // typed, '\r' not sent yet

    const result = service.updateModel(session.id, 'claude-opus-5-5');
    await vi.advanceTimersByTimeAsync(0);

    expect(result.status).toBe('deferred');
    expect(harness.launches).toHaveLength(1); // no relaunch while the composer holds an unsent body

    await vi.advanceTimersByTimeAsync(SUBMIT_KEYSTROKE_DELAY_MS);
    expect(harness.handles[0]!.written).toEqual(['do X', '\r']); // the in-flight message still submits, untouched
    expect(harness.launches).toHaveLength(1); // still no relaunch: the session is now 'submitted', awaiting turn start

    service.applyInput(session.id, hook(session.id, { hook_event_name: 'UserPromptSubmit' }));
    service.applyInput(session.id, hook(session.id, { hook_event_name: 'Stop' }));
    await vi.advanceTimersByTimeAsync(0);

    expect(harness.launches).toHaveLength(2); // only now, once idle again, does the deferred relaunch fire
    expect(harness.launches[1]!.model).toBe('claude-opus-5-5');
  });
});

describe('SessionService submit-keystroke hostile cases', () => {
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  it('a send to a different session is not blocked by another session\'s pending submit keystroke', async () => {
    vi.useFakeTimers();
    const { service, harness } = setup();
    const sessionA = await service.create({ directory: '/tmp', name: 'A', harness: 'fake', emoji: '🅰️' });
    const sessionB = await service.create({ directory: '/tmp', name: 'B', harness: 'fake', emoji: '🅱️' });
    service.applyInput(sessionA.id, hook(sessionA.id, { hook_event_name: 'SessionStart' }));
    service.applyInput(sessionB.id, hook(sessionB.id, { hook_event_name: 'SessionStart' }));

    service.sendMessage({ sessionId: sessionA.id, body: 'first' }); // leaves A's submit keystroke pending
    const resultB = service.sendMessage({ sessionId: sessionB.id, body: 'second' });

    expect(resultB.status).toBe('delivered');
    expect(harness.handles[1]!.written).toEqual(['second']);
  });

  it('a raw write during the pending delay (e.g. an Escape interrupt) does not cancel the delayed submit keystroke, which still lands after whatever the raw write left behind', async () => {
    vi.useFakeTimers();
    const { service, harness, events } = setup();
    const session = await service.create({ directory: '/tmp', name: 'G', harness: 'fake', emoji: '🤖' });
    service.applyInput(session.id, hook(session.id, { hook_event_name: 'SessionStart' }));

    service.sendMessage({ sessionId: session.id, body: 'do X' });
    service.writeRaw(session.id, '\x1b'); // human presses Escape mid-delay
    expect(harness.handles[0]!.written).toEqual(['do X', '\x1b']);

    await vi.advanceTimersByTimeAsync(SUBMIT_KEYSTROKE_DELAY_MS);

    // Pinning actual behaviour: the delayed '\r' is unconditional on what happened to the composer in
    // between, so it lands right after the Escape and the message is still reported delivered.
    expect(harness.handles[0]!.written).toEqual(['do X', '\x1b', '\r']);
    expect(events.filter((e) => e.type === 'message.delivered')).toHaveLength(1);
  });

  it('a raw \\r from the human (e.g. POST /api/sessions/:id/input, double-pressing Enter) during the delay lands as its own keystroke, so the later delayed submit double-submits', async () => {
    vi.useFakeTimers();
    const { service, harness, events } = setup();
    const session = await service.create({ directory: '/tmp', name: 'G', harness: 'fake', emoji: '🤖' });
    service.applyInput(session.id, hook(session.id, { hook_event_name: 'SessionStart' }));

    service.sendMessage({ sessionId: session.id, body: 'do X' });
    service.writeRaw(session.id, '\r'); // restHandlers.ts POST /input forwards raw bytes straight to writeRaw
    expect(harness.handles[0]!.written).toEqual(['do X', '\r']);

    await vi.advanceTimersByTimeAsync(SUBMIT_KEYSTROKE_DELAY_MS);

    // Pinning actual behaviour: two '\r' writes reach the pty for one logical message. The queue
    // bookkeeping itself stays correct (delivered exactly once) even though the pty sees a double-submit.
    expect(harness.handles[0]!.written).toEqual(['do X', '\r', '\r']);
    expect(events.filter((e) => e.type === 'message.delivered')).toHaveLength(1);
  });

  it('the submit delay does not scale with body length: a very long body still waits exactly SUBMIT_KEYSTROKE_DELAY_MS', async () => {
    vi.useFakeTimers();
    const { service, harness } = setup();
    const session = await service.create({ directory: '/tmp', name: 'G', harness: 'fake', emoji: '🤖' });
    service.applyInput(session.id, hook(session.id, { hook_event_name: 'SessionStart' }));

    const longBody = 'x'.repeat(50_000);
    service.sendMessage({ sessionId: session.id, body: longBody });

    await vi.advanceTimersByTimeAsync(SUBMIT_KEYSTROKE_DELAY_MS - 1);
    expect(harness.handles[0]!.written).toEqual([longBody]); // '\r' not due yet, however long the body

    await vi.advanceTimersByTimeAsync(1);
    expect(harness.handles[0]!.written).toEqual([longBody, '\r']);
  });

  it('holds the submit keystroke if the session has moved to "generating" before the delay elapses, then submits the already typed body once idle again without retyping it', async () => {
    vi.useFakeTimers();
    const { service, harness, events } = setup();
    const session = await service.create({ directory: '/tmp', name: 'G', harness: 'fake', emoji: '🤖' });
    service.applyInput(session.id, hook(session.id, { hook_event_name: 'SessionStart' }));

    service.sendMessage({ sessionId: session.id, body: 'first' });
    service.applyInput(session.id, hook(session.id, { hook_event_name: 'UserPromptSubmit' })); // e.g. a stray/duplicated hook
    expect(service.get(session.id)!.state).toBe('generating');

    await vi.advanceTimersByTimeAsync(SUBMIT_KEYSTROKE_DELAY_MS);

    // Writing '\r' into a session that has already moved on would submit into the wrong turn — the
    // keystroke waits and the message stays queued for the next deliverable moment (Review Focus #1).
    expect(harness.handles[0]!.written).toEqual(['first']);
    expect(events.filter((e) => e.type === 'message.delivered')).toHaveLength(0);
    expect(service.hasQueuedMessage(session.id, 'first')).toBe(true);

    service.applyInput(session.id, hook(session.id, { hook_event_name: 'Stop' })); // generating -> idle: submits the body already typed
    expect(harness.handles[0]!.written).toEqual(['first', '\r']);
    expect(events.filter((e) => e.type === 'message.delivered')).toHaveLength(1);
  });

  it('holds the submit keystroke and leaves the message queued if a permission prompt interrupts mid-delay, instead of accidentally answering the prompt', async () => {
    vi.useFakeTimers();
    const { service, harness, events } = setup();
    const session = await service.create({ directory: '/tmp', name: 'G', harness: 'fake', emoji: '🤖' });
    service.applyInput(session.id, hook(session.id, { hook_event_name: 'SessionStart' }));

    service.sendMessage({ sessionId: session.id, body: 'do X' });
    service.applyInput(session.id, hook(session.id, { hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: {} }));
    expect(service.get(session.id)!.state).toBe('waiting_permission');

    await vi.advanceTimersByTimeAsync(SUBMIT_KEYSTROKE_DELAY_MS);

    expect(harness.handles[0]!.written).toEqual(['do X']); // the '\r' must never land on the permission prompt itself
    expect(events.filter((e) => e.type === 'message.delivered')).toHaveLength(0);
    expect(service.hasQueuedMessage(session.id, 'do X')).toBe(true);

    service.applyInput(session.id, { kind: 'permission_resolved' }); // -> generating
    expect(harness.handles[0]!.written).toEqual(['do X']);
    service.applyInput(session.id, hook(session.id, { hook_event_name: 'Stop' })); // -> idle: submits the body already typed
    expect(harness.handles[0]!.written).toEqual(['do X', '\r']);
    expect(events.filter((e) => e.type === 'message.delivered')).toHaveLength(1);
    expect(service.hasQueuedMessage(session.id, 'do X')).toBe(false);
  });

  it('does not crash the daemon when the pty write for the delayed submit keystroke throws, leaving the message queued for a later retry', async () => {
    vi.useFakeTimers();
    const { service, harness, events } = setup();
    const session = await service.create({ directory: '/tmp', name: 'G', harness: 'fake', emoji: '🤖' });
    service.applyInput(session.id, hook(session.id, { hook_event_name: 'SessionStart' }));

    const handle = harness.handles[0]!;
    const originalWrite = handle.write.bind(handle);
    let submitWritesToFail = 1;
    handle.write = (data: string) => {
      const shouldFail = data === '\r' && submitWritesToFail > 0;
      if (shouldFail) { submitWritesToFail -= 1; throw new Error('pty write failed'); }
      originalWrite(data);
    };
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = service.sendMessage({ sessionId: session.id, body: 'do X' });
    expect(result.status).toBe('delivered'); // the body itself reached the terminal; only the '\r' write fails below

    let threw = false;
    try {
      await vi.advanceTimersByTimeAsync(SUBMIT_KEYSTROKE_DELAY_MS);
    } catch {
      threw = true;
    }
    expect(threw).toBe(false); // a throwing pty write must not crash the daemon as an uncaught exception

    expect(handle.written).toEqual(['do X']); // the '\r' write threw and never landed
    expect(events.filter((e) => e.type === 'message.delivered')).toHaveLength(0);
    expect(service.hasQueuedMessage(session.id, 'do X')).toBe(true);
    expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
    expect(String(consoleErrorSpy.mock.calls[0]![0])).toContain(session.id);

    await vi.advanceTimersByTimeAsync(DELIVERY_RETRY_MS); // the retry submits the body already typed, without retyping it
    expect(handle.written).toEqual(['do X', '\r']);
    expect(events.filter((e) => e.type === 'message.delivered')).toHaveLength(1);
    expect(service.hasQueuedMessage(session.id, 'do X')).toBe(false);
    consoleErrorSpy.mockRestore();
  });

  it('parks a submit keystroke that keeps failing after MAX_DELIVERY_RETRIES fast retries, then resumes on the next deliverable transition', async () => {
    vi.useFakeTimers();
    const { service, harness, events } = setup();
    const session = await service.create({ directory: '/tmp', name: 'G', harness: 'fake', emoji: '🤖' });
    service.applyInput(session.id, hook(session.id, { hook_event_name: 'SessionStart' }));
    const handle = harness.handles[0]!;
    const originalWrite = handle.write.bind(handle);
    let isPtyBroken = true;
    let submitAttempts = 0;
    handle.write = (data: string) => {
      if (data === '\r') submitAttempts += 1;
      if (data === '\r' && isPtyBroken) throw new Error('pty write failed');
      originalWrite(data);
    };
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    service.sendMessage({ sessionId: session.id, body: 'do X' });
    await vi.advanceTimersByTimeAsync(SUBMIT_KEYSTROKE_DELAY_MS + DELIVERY_RETRY_MS * (MAX_DELIVERY_RETRIES + 2));

    expect(submitAttempts).toBe(1 + MAX_DELIVERY_RETRIES);
    expect(vi.getTimerCount()).toBe(1); // parked: only the long parked retry remains
    expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
    expect(service.hasQueuedMessage(session.id, 'do X')).toBe(true);

    isPtyBroken = false;
    service.applyInput(session.id, hook(session.id, { hook_event_name: 'UserPromptSubmit' }));
    service.applyInput(session.id, hook(session.id, { hook_event_name: 'Stop' }));
    expect(handle.written).toEqual(['do X', '\r']);
    expect(events.filter((e) => e.type === 'message.delivered')).toHaveLength(1);
    consoleErrorSpy.mockRestore();
  });

  it('keeps retrying a parked delivery every PARKED_RETRY_MS with no state transition, logging once per failure streak', async () => {
    vi.useFakeTimers();
    const { service, harness, events } = setup();
    const session = await service.create({ directory: '/tmp', name: 'G', harness: 'fake', emoji: '🤖' });
    service.applyInput(session.id, hook(session.id, { hook_event_name: 'SessionStart' }));
    const handle = harness.handles[0]!;
    const originalWrite = handle.write.bind(handle);
    let isPtyBroken = true;
    let submitAttempts = 0;
    handle.write = (data: string) => {
      if (data === '\r') submitAttempts += 1;
      if (data === '\r' && isPtyBroken) throw new Error('pty write failed');
      originalWrite(data);
    };
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    service.sendMessage({ sessionId: session.id, body: 'do X' });
    await vi.advanceTimersByTimeAsync(SUBMIT_KEYSTROKE_DELAY_MS + DELIVERY_RETRY_MS * MAX_DELIVERY_RETRIES);
    expect(submitAttempts).toBe(1 + MAX_DELIVERY_RETRIES);
    expect(vi.getTimerCount()).toBe(1);

    await vi.advanceTimersByTimeAsync(PARKED_RETRY_MS);
    expect(submitAttempts).toBe(2 + MAX_DELIVERY_RETRIES);
    expect(vi.getTimerCount()).toBe(1);
    expect(consoleErrorSpy).toHaveBeenCalledTimes(1);

    isPtyBroken = false;
    await vi.advanceTimersByTimeAsync(PARKED_RETRY_MS);
    expect(handle.written).toEqual(['do X', '\r']);
    expect(events.filter((e) => e.type === 'message.delivered')).toHaveLength(1);
    expect(service.hasQueuedMessage(session.id, 'do X')).toBe(false);
    consoleErrorSpy.mockRestore();
  });

  it('commits a submitted delivery even when a message.delivered listener throws: one \\r, one event, no retry', async () => {
    vi.useFakeTimers();
    const { service, harness, bus, events } = setup();
    const session = await service.create({ directory: '/tmp', name: 'G', harness: 'fake', emoji: '🤖' });
    service.applyInput(session.id, hook(session.id, { hook_event_name: 'SessionStart' }));
    bus.subscribe((e) => { if (e.type === 'message.delivered') throw new Error('socket closing'); });
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    service.sendMessage({ sessionId: session.id, body: 'do X' });
    await vi.advanceTimersByTimeAsync(SUBMIT_KEYSTROKE_DELAY_MS);
    const listenerFailureLogs = consoleErrorSpy.mock.calls.length;
    consoleErrorSpy.mockRestore();
    const secondSend = service.sendMessage({ sessionId: session.id, body: 'do Y' });
    const timersWhileSubmitted = vi.getTimerCount();
    await vi.advanceTimersByTimeAsync(TURN_START_TIMEOUT_MS); // the turn-start fallback, not a retry, frees the machine

    expect(secondSend.status).toBe('queued'); // submitted: awaiting the turn start
    expect(timersWhileSubmitted).toBe(1); // only the turn-start timeout, no retry timer
    expect(harness.handles[0]!.written).toEqual(['do X', '\r', 'do Y']);
    expect(events.filter((e) => e.type === 'message.delivered')).toHaveLength(1);
    expect(service.hasQueuedMessage(session.id, 'do X')).toBe(false);
    expect(listenerFailureLogs).toBe(1);
  });

  it('never retypes a submitted message whose delivery record fails once: the record is retried, then the queue flows on', async () => {
    vi.useFakeTimers();
    const { service, harness, events } = setup();
    const session = await service.create({ directory: '/tmp', name: 'G', harness: 'fake', emoji: '🤖' });
    service.applyInput(session.id, hook(session.id, { hook_event_name: 'SessionStart' }));
    const originalMarkDelivered = MessageQueue.prototype.markDelivered;
    let recordsToFail = 1;
    const markDeliveredSpy = vi.spyOn(MessageQueue.prototype, 'markDelivered').mockImplementation(function (this: MessageQueue, id) {
      if (recordsToFail > 0) { recordsToFail -= 1; throw new Error('SQLITE_BUSY'); }
      originalMarkDelivered.call(this, id);
    });
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const first = service.sendMessage({ sessionId: session.id, body: 'do X' });
    await vi.advanceTimersByTimeAsync(SUBMIT_KEYSTROKE_DELAY_MS);
    const second = service.sendMessage({ sessionId: session.id, body: 'do Y' });
    service.applyInput(session.id, hook(session.id, { hook_event_name: 'UserPromptSubmit' }));
    service.applyInput(session.id, hook(session.id, { hook_event_name: 'Stop' }));
    await vi.advanceTimersByTimeAsync(SUBMIT_KEYSTROKE_DELAY_MS);

    const deliveredIds = events.flatMap((e) => (e.type === 'message.delivered' ? [e.messageId] : []));
    expect(harness.handles[0]!.written).toEqual(['do X', '\r', 'do Y', '\r']);
    expect(deliveredIds).toEqual([first.messageId, second.messageId]);
    expect(service.hasQueuedMessage(session.id, 'do X')).toBe(false);
    markDeliveredSpy.mockRestore();
    consoleErrorSpy.mockRestore();
  });

  it('never retypes a submitted message whose delivery record keeps failing: the session parks on a timer with bounded logs, then flows once the db heals', async () => {
    vi.useFakeTimers();
    const { service, harness, events } = setup();
    const session = await service.create({ directory: '/tmp', name: 'G', harness: 'fake', emoji: '🤖' });
    service.applyInput(session.id, hook(session.id, { hook_event_name: 'SessionStart' }));
    const markDeliveredSpy = vi.spyOn(MessageQueue.prototype, 'markDelivered').mockImplementation(() => { throw new Error('SQLITE_BUSY'); });
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    service.sendMessage({ sessionId: session.id, body: 'do X' });
    await vi.advanceTimersByTimeAsync(SUBMIT_KEYSTROKE_DELAY_MS);
    service.sendMessage({ sessionId: session.id, body: 'do Y' });
    service.applyInput(session.id, hook(session.id, { hook_event_name: 'UserPromptSubmit' }));
    service.applyInput(session.id, hook(session.id, { hook_event_name: 'Stop' }));
    await vi.advanceTimersByTimeAsync(DELIVERY_RETRY_MS * (MAX_DELIVERY_RETRIES + 2) + PARKED_RETRY_MS * 2);

    expect(harness.handles[0]!.written).toEqual(['do X', '\r']);
    expect(events.filter((e) => e.type === 'message.delivered')).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(1); // parked, not stuck
    expect(consoleErrorSpy).toHaveBeenCalledTimes(2); // the failed record, then one failure streak

    markDeliveredSpy.mockRestore();
    await vi.advanceTimersByTimeAsync(PARKED_RETRY_MS + SUBMIT_KEYSTROKE_DELAY_MS);
    expect(harness.handles[0]!.written).toEqual(['do X', '\r', 'do Y', '\r']);
    expect(events.filter((e) => e.type === 'message.delivered')).toHaveLength(2);
    consoleErrorSpy.mockRestore();
  });

  it('does not crash the daemon when typing the body throws, and types it once the retry delay elapses', async () => {
    vi.useFakeTimers();
    const { service, harness, events } = setup();
    const session = await service.create({ directory: '/tmp', name: 'G', harness: 'fake', emoji: '🤖' });
    service.applyInput(session.id, hook(session.id, { hook_event_name: 'SessionStart' }));
    const handle = harness.handles[0]!;
    const originalWrite = handle.write.bind(handle);
    let bodyWritesToFail = 1;
    handle.write = (data: string) => {
      const shouldFail = data === 'do X' && bodyWritesToFail > 0;
      if (shouldFail) { bodyWritesToFail -= 1; throw new Error('pty write failed'); }
      originalWrite(data);
    };
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = service.sendMessage({ sessionId: session.id, body: 'do X' });

    expect(result.status).toBe('queued');
    expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(DELIVERY_RETRY_MS + SUBMIT_KEYSTROKE_DELAY_MS);
    expect(handle.written).toEqual(['do X', '\r']);
    expect(events.filter((e) => e.type === 'message.delivered')).toHaveLength(1);
    consoleErrorSpy.mockRestore();
  });

  it('emits message.delivered only once the submit keystroke lands, not when the body is typed', async () => {
    vi.useFakeTimers();
    const { service, events } = setup();
    const session = await service.create({ directory: '/tmp', name: 'G', harness: 'fake', emoji: '🤖' });
    service.applyInput(session.id, hook(session.id, { hook_event_name: 'SessionStart' }));

    const { messageId } = service.sendMessage({ sessionId: session.id, body: 'do X' });
    expect(events.filter((e) => e.type === 'message.delivered')).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(SUBMIT_KEYSTROKE_DELAY_MS + TURN_START_TIMEOUT_MS);
    expect(events.filter((e) => e.type === 'message.delivered')).toEqual([{ type: 'message.delivered', sessionId: session.id, messageId }]);
  });

  it('queues a send that arrives while the session is being gracefully killed, instead of typing into the dying pty', async () => {
    vi.useFakeTimers();
    const { service, harness } = setup();
    const session = await service.create({ directory: '/tmp', name: 'G', harness: 'fake', emoji: '🤖' });
    service.applyInput(session.id, hook(session.id, { hook_event_name: 'SessionStart' }));
    const handle = harness.handles[0]!;
    handle.ignoresGracefulKill = true;

    const closePromise = service.close(session.id);
    const result = service.sendMessage({ sessionId: session.id, body: 'too late' });

    expect(result.status).toBe('queued');
    expect(handle.written).toEqual([]);
    await vi.advanceTimersByTimeAsync(DEFAULT_CLOSE_ESCALATE_MS);
    await closePromise;
    expect(handle.written).toEqual([]);
    expect(service.hasQueuedMessage(session.id, 'too late')).toBe(true);
  });

  it('a stale instance never types a body into the handle a resume replaced', async () => {
    vi.useFakeTimers();
    const db = openDatabase(':memory:');
    const bus = new EventBus();
    const firstRunHarness = new FakeHarness();
    const original = new SessionService({ db, bus, harnesses: [firstRunHarness], baseUrl: 'http://127.0.0.1:7331', worktreesRoot: '/tmp/of-wt' });
    const session = await original.create({ directory: '/tmp', name: 'G', harness: 'fake', emoji: '🤖' });
    const staleHandle = firstRunHarness.handles[0]!;
    const restartHarness = new FakeHarness();
    const restarted = new SessionService({ db, bus, harnesses: [restartHarness], baseUrl: 'http://127.0.0.1:7331', worktreesRoot: '/tmp/of-wt' });
    await restarted.resumeAll();
    restarted.applyInput(session.id, hook(session.id, { hook_event_name: 'SessionStart' }));

    const result = original.sendMessage({ sessionId: session.id, body: 'via the stale instance' });

    expect(result.status).toBe('queued');
    expect(staleHandle.written).toEqual([]);
    await vi.advanceTimersByTimeAsync(SUBMIT_KEYSTROKE_DELAY_MS);
    expect(staleHandle.written).toEqual([]);
  });

  it('clears the pending submit keystroke immediately on close(), before the graceful-kill escalation window elapses', async () => {
    vi.useFakeTimers();
    const { service, harness } = setup();
    const session = await service.create({ directory: '/tmp', name: 'G', harness: 'fake', emoji: '🤖' });
    service.applyInput(session.id, hook(session.id, { hook_event_name: 'SessionStart' }));
    const handle = harness.handles[0]!;
    handle.ignoresGracefulKill = true;

    service.sendMessage({ sessionId: session.id, body: 'do X' }); // leaves the submit keystroke pending

    const closePromise = service.close(session.id);
    await vi.advanceTimersByTimeAsync(SUBMIT_KEYSTROKE_DELAY_MS); // the delay elapses mid-teardown, well before the escalation window
    expect(handle.written).toEqual(['do X']); // no stray '\r' lands on the dying pty

    await vi.advanceTimersByTimeAsync(DEFAULT_CLOSE_ESCALATE_MS); // escalation window elapses, force-kill fires
    await closePromise;
    expect(handle.written).toEqual(['do X']); // still no '\r', even after the process is gone
  });

  it('a send arriving in the post-\\r gap before the next hook queues behind an earlier queued message, preserving FIFO order', async () => {
    vi.useFakeTimers();
    const { service, harness } = setup();
    const session = await service.create({ directory: '/tmp', name: 'G', harness: 'fake', emoji: '🤖' });
    service.applyInput(session.id, hook(session.id, { hook_event_name: 'SessionStart' }));

    service.sendMessage({ sessionId: session.id, body: 'A' }); // delivered immediately
    const b = service.sendMessage({ sessionId: session.id, body: 'B' }); // queued: A's submit keystroke is pending
    expect(b.status).toBe('queued');

    await vi.advanceTimersByTimeAsync(SUBMIT_KEYSTROKE_DELAY_MS); // A's '\r' lands, but no hook has confirmed the turn yet
    expect(harness.handles[0]!.written).toEqual(['A', '\r']);

    // C arrives in the gap between A's '\r' landing and the CLI's own hook confirming the turn started —
    // it must not jump ahead of B, which has been sitting queued the whole time.
    const c = service.sendMessage({ sessionId: session.id, body: 'C' });
    expect(c.status).toBe('queued');
    expect(harness.handles[0]!.written).toEqual(['A', '\r']);

    service.applyInput(session.id, hook(session.id, { hook_event_name: 'UserPromptSubmit' }));
    service.applyInput(session.id, hook(session.id, { hook_event_name: 'Stop' }));
    expect(harness.handles[0]!.written).toEqual(['A', '\r', 'B']); // B flushed first, not C
    await vi.advanceTimersByTimeAsync(SUBMIT_KEYSTROKE_DELAY_MS);
    expect(harness.handles[0]!.written).toEqual(['A', '\r', 'B', '\r']);

    service.applyInput(session.id, hook(session.id, { hook_event_name: 'UserPromptSubmit' }));
    service.applyInput(session.id, hook(session.id, { hook_event_name: 'Stop' }));
    expect(harness.handles[0]!.written).toEqual(['A', '\r', 'B', '\r', 'C']);
  });

  it('flushes a queued message after the turn-start timeout even if no hook ever confirms the turn began', async () => {
    vi.useFakeTimers();
    const { service, harness } = setup();
    const session = await service.create({ directory: '/tmp', name: 'G', harness: 'fake', emoji: '🤖' });
    service.applyInput(session.id, hook(session.id, { hook_event_name: 'SessionStart' }));

    service.sendMessage({ sessionId: session.id, body: 'A' });
    const b = service.sendMessage({ sessionId: session.id, body: 'B' });
    expect(b.status).toBe('queued');

    await vi.advanceTimersByTimeAsync(SUBMIT_KEYSTROKE_DELAY_MS); // A's '\r' lands
    expect(harness.handles[0]!.written).toEqual(['A', '\r']);

    // No hook ever arrives to confirm the turn started (e.g. the CLI silently drops the keystroke) — the
    // turn-start timeout must still flush B rather than stranding it forever.
    await vi.advanceTimersByTimeAsync(TURN_START_TIMEOUT_MS);
    expect(harness.handles[0]!.written).toEqual(['A', '\r', 'B']);
  });

  it('queues a send that arrives in the post-\\r gap, with nothing else queued, instead of typing into the terminal before the turn is confirmed', async () => {
    vi.useFakeTimers();
    const { service, harness } = setup();
    const session = await service.create({ directory: '/tmp', name: 'G', harness: 'fake', emoji: '🤖' });
    service.applyInput(session.id, hook(session.id, { hook_event_name: 'SessionStart' }));

    service.sendMessage({ sessionId: session.id, body: 'A' }); // delivered immediately
    await vi.advanceTimersByTimeAsync(SUBMIT_KEYSTROKE_DELAY_MS); // A's '\r' lands
    expect(harness.handles[0]!.written).toEqual(['A', '\r']);

    // C arrives before the CLI's own UserPromptSubmit hook has confirmed A's turn actually started —
    // typing it now would land in a terminal about to start running A (Review Focus #4).
    const c = service.sendMessage({ sessionId: session.id, body: 'C' });
    expect(c.status).toBe('queued');
    expect(harness.handles[0]!.written).toEqual(['A', '\r']);

    service.applyInput(session.id, hook(session.id, { hook_event_name: 'UserPromptSubmit' }));
    service.applyInput(session.id, hook(session.id, { hook_event_name: 'Stop' }));
    expect(harness.handles[0]!.written).toEqual(['A', '\r', 'C']);
    await vi.advanceTimersByTimeAsync(SUBMIT_KEYSTROKE_DELAY_MS);
    expect(harness.handles[0]!.written).toEqual(['A', '\r', 'C', '\r']);
  });

  it('delivers a send that arrived in the post-\\r gap after the turn-start timeout, when no hook ever confirms the turn', async () => {
    vi.useFakeTimers();
    const { service, harness } = setup();
    const session = await service.create({ directory: '/tmp', name: 'G', harness: 'fake', emoji: '🤖' });
    service.applyInput(session.id, hook(session.id, { hook_event_name: 'SessionStart' }));

    service.sendMessage({ sessionId: session.id, body: 'A' });
    await vi.advanceTimersByTimeAsync(SUBMIT_KEYSTROKE_DELAY_MS);
    expect(harness.handles[0]!.written).toEqual(['A', '\r']);

    const c = service.sendMessage({ sessionId: session.id, body: 'C' });
    expect(c.status).toBe('queued');

    await vi.advanceTimersByTimeAsync(TURN_START_TIMEOUT_MS);
    expect(harness.handles[0]!.written).toEqual(['A', '\r', 'C']);
  });

  it('a daemon restart mid-delay drops the stale instance\'s pending submit keystroke and delivers the message exactly once, to the resumed handle', async () => {
    vi.useFakeTimers();
    const db = openDatabase(':memory:');
    const bus = new EventBus();
    const events: ServerEvent[] = [];
    bus.subscribe((e) => events.push(e));
    const firstRunHarness = new FakeHarness();
    const original = new SessionService({ db, bus, harnesses: [firstRunHarness], baseUrl: 'http://127.0.0.1:7331', worktreesRoot: '/tmp/of-wt' });
    const session = await original.create({ directory: '/tmp', name: 'G', harness: 'fake', emoji: '🤖' });
    original.applyInput(session.id, hook(session.id, { hook_event_name: 'SessionStart' }));
    const { messageId } = original.sendMessage({ sessionId: session.id, body: 'orphaned' });
    const staleHandle = firstRunHarness.handles[0]!;
    expect(staleHandle.written).toEqual(['orphaned']);

    // Daemon restarts before the stale process's own delayed '\r' has fired — the exact race the
    // resume tests above already model by keeping both instances alive over the same db.
    const restartHarness = new FakeHarness();
    const restarted = new SessionService({ db, bus, harnesses: [restartHarness], baseUrl: 'http://127.0.0.1:7331', worktreesRoot: '/tmp/of-wt' });
    await restarted.resumeAll();
    restarted.applyInput(session.id, hook(session.id, { hook_event_name: 'SessionStart' }));

    // The message row is still 'queued' (the stale timer hasn't marked it delivered yet), so the
    // resumed instance's own flush redelivers the same body to the fresh handle immediately.
    const resumedHandle = restartHarness.handles[0]!;
    expect(resumedHandle.written).toEqual(['orphaned']);

    await vi.advanceTimersByTimeAsync(SUBMIT_KEYSTROKE_DELAY_MS);

    // Only the resumed handle receives the submit keystroke; the stale instance's timer sees the
    // module-level activeHandleBySessionId has moved on and drops its own pending '\r'.
    expect(staleHandle.written).toEqual(['orphaned']);
    expect(resumedHandle.written).toEqual(['orphaned', '\r']);
    const deliveredForThisMessage = events.filter((e) => e.type === 'message.delivered' && e.messageId === messageId);
    expect(deliveredForThisMessage).toHaveLength(1);
  });
});
