import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openDatabase } from '../db/database.js';
import { EventBus } from '../events/eventBus.js';
import { FakeHarness } from '../harness/fakeHarness.js';
import { SleepGuard } from '../power/sleepGuard.js';
import { SessionService } from '../sessions/sessionService.js';
import { ManagerRepository } from './managerRepository.js';
import { PulseScheduler } from './pulseScheduler.js';

const cleanups: (() => void | Promise<void>)[] = [];
beforeEach(() => vi.useFakeTimers());
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); vi.useRealTimers(); });

function setup() {
  const db = openDatabase(':memory:');
  const bus = new EventBus();
  const harness = new FakeHarness();
  const sessions = new SessionService({ db, bus, harnesses: [harness], baseUrl: 'http://localhost:0', worktreesRoot: '/tmp/of-wt' });
  const guard = new SleepGuard({ sessions, bus, enabled: false, power: { acquire: () => { throw new Error('disabled'); } }, clock: Date.now,
    schedule: (callback, delayMs) => { const timer = setTimeout(callback, delayMs); return () => clearTimeout(timer); }, onPowerUnavailable: () => undefined });
  guard.start();
  const managers = new ManagerRepository(db);
  const scheduler = new PulseScheduler({ sessions, managers, bus });
  cleanups.push(() => db.close(), () => sessions.closeAll(), () => guard.stop(), () => scheduler.stop());
  const create = (name: string, parentId?: string) => sessions.create({ directory: '/tmp', name, parentId, emoji: '🤖', harness: 'fake' });
  const hook = (id: string, hook_event_name: string) => sessions.applyInput(id, { kind: 'hook', event: { session_id: id, hook_event_name } as never });
  const registerManager = (sessionId: string) => managers.insert({ sessionId, missionText: 'coordinate', pulseSeconds: 3600, childrenCap: 10, createdAt: new Date().toISOString() });
  const resume = async () => { vi.setSystemTime(Date.now() + 60_000); await vi.advanceTimersByTimeAsync(125_000); };
  return { sessions, harness, bus, create, hook, registerManager, resume };
}

describe('manager notification of runtime attention', () => {
  it('coalesces two stalled children into one queued message and never types into a permission gate', async () => {
    const { sessions, harness, create, hook, registerManager, resume, bus } = setup();
    const manager = await create('manager');
    registerManager(manager.id);
    hook(manager.id, 'SessionStart');
    hook(manager.id, 'PermissionRequest');
    const first = await create('untrusted child name', manager.id);
    const second = await create('second', manager.id);
    hook(first.id, 'UserPromptSubmit');
    hook(second.id, 'UserPromptSubmit');

    await resume();
    const attention = sessions.get(first.id)!.runtimeAttention!;
    bus.emit({ type: 'session.attention', sessionId: first.id, runtimeAttention: attention });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(sessions.queuedMessageCount(manager.id)).toBe(1);
    expect(harness.handles[0]!.written).toEqual([]);

    hook(manager.id, 'Stop');
    expect(harness.handles[0]!.written[0]).toContain(first.id);
    expect(harness.handles[0]!.written[0]).toContain(second.id);
    expect(harness.handles[0]!.written[0]).toContain('post_wake_no_progress');
    expect(harness.handles[0]!.written[0]).not.toContain('untrusted child name');
  });

  it('queues one notification for a child that closes during the resume check instead of duplicate close and attention messages', async () => {
    const { sessions, harness, create, hook, registerManager } = setup();
    const manager = await create('manager');
    registerManager(manager.id);
    hook(manager.id, 'UserPromptSubmit');
    const child = await create('child', manager.id);
    hook(child.id, 'UserPromptSubmit');
    vi.setSystemTime(Date.now() + 60_000);
    await vi.advanceTimersByTimeAsync(5000);
    harness.handles[1]!.emitExit(137);
    expect(sessions.queuedMessageCount(manager.id)).toBe(1);
    hook(manager.id, 'Stop');
    expect(harness.handles[0]!.written[0]).toContain('post_wake_process_exited');
    expect(harness.handles[0]!.written[0]).toContain(child.id);
  });
});
