import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { openDatabase } from '../db/database.js';
import { FakeHandle, FakeHarness } from '../harness/fakeHarness.js';
import type { Harness, HarnessHandle, HarnessLaunch } from '../harness/harness.js';
import { EventBus } from '../events/eventBus.js';
import { DEFAULT_CLOSE_ESCALATE_MS, RESUME_LAUNCH_FAILED_EXIT_CODE, RESUME_TIMEOUT_EXIT_CODE, SessionService } from './sessionService.js';
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

describe('SessionService', () => {
  it('creates a session in starting state and launches the harness with hook/mcp urls', async () => {
    const { service, harness } = setup();
    const session = await service.create({ directory: '/tmp', name: 'Gimli', harness: 'fake', emoji: '⚔️' });
    expect(session.state).toBe('starting');
    expect(harness.launches[0]!.hookUrl).toMatch(/^http:\/\/127\.0\.0\.1:7331\/hooks\/[A-Za-z0-9_-]+$/);
    expect(harness.launches[0]!.displayName).toBe('⚔️ Gimli');
  });

  it('delivers a message immediately when idle, writing body + CR to the pty', async () => {
    const { service, harness } = setup();
    const session = await service.create({ directory: '/tmp', name: 'G', harness: 'fake', emoji: '🤖' });
    service.applyInput(session.id, hook(session.id, { hook_event_name: 'SessionStart' }));
    const result = service.sendMessage({ sessionId: session.id, body: 'do X' });
    expect(result.status).toBe('delivered');
    expect(harness.handles[0]!.written).toEqual(['do X\r']);
  });

  it('queues while waiting_permission and flushes on idle', async () => {
    const { service, harness, events } = setup();
    const session = await service.create({ directory: '/tmp', name: 'G', harness: 'fake', emoji: '🤖' });
    service.applyInput(session.id, hook(session.id, { hook_event_name: 'SessionStart' }));
    service.applyInput(session.id, hook(session.id, { hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: {} }));
    const result = service.sendMessage({ sessionId: session.id, body: 'later' });
    expect(result.status).toBe('queued');
    expect(harness.handles[0]!.written).toEqual([]);
    service.applyInput(session.id, { kind: 'permission_resolved' });
    service.applyInput(session.id, hook(session.id, { hook_event_name: 'Stop' }));
    expect(harness.handles[0]!.written).toEqual(['later\r']);
    expect(events.some((e) => e.type === 'message.delivered')).toBe(true);
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

    expect(restartHarness.handles[0]!.written).toEqual(['queued before crash\r']);
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
  it('applies the model immediately when idle, and records it', async () => {
    const { service, harness, events } = setup();
    const session = await service.create({ directory: '/tmp', name: 'G', harness: 'fake', emoji: '🤖' });
    service.applyInput(session.id, hook(session.id, { hook_event_name: 'SessionStart' }));
    const result = service.updateModel(session.id, 'claude-opus-5-5');
    expect(result.status).toBe('delivered');
    expect(harness.handles[0]!.written).toEqual(['/model claude-opus-5-5\r']);
    expect(service.get(session.id)!.model).toBe('claude-opus-5-5');
    expect(events).toContainEqual({ type: 'session.model_changed', sessionId: session.id, model: 'claude-opus-5-5' });
  });

  it('queues the model switch while the session is generating, and still records the target model immediately', async () => {
    const { service, harness } = setup();
    const session = await service.create({ directory: '/tmp', name: 'G', harness: 'fake', emoji: '🤖' });
    service.applyInput(session.id, hook(session.id, { hook_event_name: 'SessionStart' }));
    service.applyInput(session.id, hook(session.id, { hook_event_name: 'UserPromptSubmit' }));

    const result = service.updateModel(session.id, 'claude-opus-5-5');

    expect(result.status).toBe('queued');
    expect(harness.handles[0]!.written).toEqual([]);
    expect(service.get(session.id)!.model).toBe('claude-opus-5-5');

    service.applyInput(session.id, hook(session.id, { hook_event_name: 'Stop' }));
    expect(harness.handles[0]!.written).toEqual(['/model claude-opus-5-5\r']);
  });

  it('delivers only the first of two model switches queued while generating, one per idle turn', async () => {
    const { service, harness } = setup();
    const session = await service.create({ directory: '/tmp', name: 'G', harness: 'fake', emoji: '🤖' });
    service.applyInput(session.id, hook(session.id, { hook_event_name: 'SessionStart' }));
    service.applyInput(session.id, hook(session.id, { hook_event_name: 'UserPromptSubmit' }));

    service.updateModel(session.id, 'claude-opus-5-5');
    const second = service.updateModel(session.id, 'claude-haiku-4-5');

    expect(second.status).toBe('queued');
    expect(service.get(session.id)!.model).toBe('claude-haiku-4-5');

    service.applyInput(session.id, hook(session.id, { hook_event_name: 'Stop' }));
    expect(harness.handles[0]!.written).toEqual(['/model claude-opus-5-5\r']);

    service.applyInput(session.id, hook(session.id, { hook_event_name: 'UserPromptSubmit' }));
    service.applyInput(session.id, hook(session.id, { hook_event_name: 'Stop' }));
    expect(harness.handles[0]!.written).toEqual(['/model claude-opus-5-5\r', '/model claude-haiku-4-5\r']);
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
