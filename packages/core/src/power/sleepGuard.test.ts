import { afterEach, describe, expect, it, vi } from 'vitest';
import { openDatabase } from '../db/database.js';
import { EventBus } from '../events/eventBus.js';
import { FakeHarness } from '../harness/fakeHarness.js';
import { SessionService } from '../sessions/sessionService.js';
import { SleepGuard } from './sleepGuard.js';
import type { PowerApi } from './powerApi.js';

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.useRealTimers();
});

function setup(options: { power?: PowerApi; enabled?: boolean } = {}) {
  const db = openDatabase(':memory:');
  const bus = new EventBus();
  const harness = new FakeHarness();
  const sessions = new SessionService({ db, bus, harnesses: [harness], baseUrl: 'http://localhost:0', worktreesRoot: '/tmp/of-wt' });
  let assertionCount = 0;
  let acquisitions = 0;
  let powerFailures = 0;
  const guard = new SleepGuard({
    sessions, bus, enabled: options.enabled ?? true,
    power: options.power ?? { acquire: () => { assertionCount += 1; acquisitions += 1; return { release: () => { assertionCount -= 1; } }; } },
    clock: Date.now,
    schedule: (callback, delayMs) => { const timer = setTimeout(callback, delayMs); timer.unref(); return () => clearTimeout(timer); },
    onPowerUnavailable: () => { powerFailures += 1; },
  });
  guard.start();
  cleanups.push(() => db.close(), () => sessions.closeAll(), () => guard.stop());
  const create = (name: string, parentId?: string) => sessions.create({ name, parentId, directory: '/tmp', harness: 'fake', emoji: '🤖' });
  const hook = (id: string, hook_event_name: 'UserPromptSubmit' | 'Stop' | 'SessionStart' | 'PreToolUse') => sessions.applyInput(id, { kind: 'hook', event: { session_id: id, hook_event_name } as never });
  return { sessions, harness, guard, create, hook, held: () => assertionCount, acquisitions: () => acquisitions, powerFailures: () => powerFailures };
}

describe('sleep protection for active sessions', () => {
  it('holds one assertion from the first generating session until the last child or manager is idle', async () => {
    const { create, hook, held, acquisitions, guard } = setup();
    const manager = await create('manager');
    const firstChild = await create('first', manager.id);
    const secondChild = await create('second', manager.id);
    expect(held()).toBe(0);

    hook(firstChild.id, 'UserPromptSubmit');
    expect(held()).toBe(1);
    hook(secondChild.id, 'UserPromptSubmit');
    hook(manager.id, 'UserPromptSubmit');
    hook(firstChild.id, 'PreToolUse');
    expect(acquisitions()).toBe(1);
    hook(firstChild.id, 'Stop');
    hook(secondChild.id, 'Stop');
    expect(held()).toBe(1);
    hook(manager.id, 'Stop');
    expect(held()).toBe(0);
    guard.stop();
    guard.stop();
    expect(held()).toBe(0);
  });

  it('releases protection while waiting for permission or input and on process exit', async () => {
    const { create, hook, sessions, harness, held } = setup();
    const child = await create('waits on the operator');
    hook(child.id, 'UserPromptSubmit');
    expect(held()).toBe(1);

    sessions.applyInput(child.id, { kind: 'hook', event: { session_id: child.id, hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: {} } });
    expect(held()).toBe(0);
    sessions.applyInput(child.id, { kind: 'permission_resolved' });
    expect(held()).toBe(1);
    sessions.applyInput(child.id, { kind: 'hook', event: { session_id: child.id, hook_event_name: 'Notification', notification_type: 'agent_needs_input' } });
    expect(held()).toBe(0);
    hook(child.id, 'UserPromptSubmit');
    expect(held()).toBe(1);
    harness.handles[0]!.emitExit(0);
    expect(held()).toBe(0);
  });

  it('flags silence 120 active seconds after timer drift, while a current hook clears the other child', async () => {
    vi.useFakeTimers();
    const { create, hook, sessions, harness, held } = setup();
    const silentChild = await create('silent');
    const progressingChild = await create('progressing');
    hook(silentChild.id, 'UserPromptSubmit');
    hook(progressingChild.id, 'UserPromptSubmit');

    vi.setSystemTime(Date.now() + 60_000);
    await vi.advanceTimersByTimeAsync(5000);
    await vi.advanceTimersByTimeAsync(60_000);
    hook(progressingChild.id, 'PreToolUse');
    harness.handles[0]!.emitData('spinner redraw');
    await vi.advanceTimersByTimeAsync(59_999);
    expect(sessions.get(silentChild.id)?.runtimeAttention).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);

    expect(sessions.get(silentChild.id)).toMatchObject({
      state: 'generating',
      runtimeAttention: { reason: 'post_wake_no_progress', wakeSource: 'resume_suspected', launchId: expect.any(String), detectedAt: expect.any(String) },
    });
    expect(sessions.get(progressingChild.id)?.runtimeAttention).toBeUndefined();
    expect(held()).toBe(1);
    expect(harness.handles.every((handle) => !handle.killed)).toBe(true);

    hook(silentChild.id, 'PreToolUse');
    await vi.advanceTimersByTimeAsync(5000);
    expect(sessions.get(silentChild.id)?.runtimeAttention).toBeUndefined();
  });

  it('recognizes an advancing current transcript but does not accept a replacement full of history', async () => {
    vi.useFakeTimers();
    const { create, hook, sessions, harness } = setup();
    const currentChild = await create('current transcript');
    const historicalChild = await create('replaced transcript');
    hook(currentChild.id, 'UserPromptSubmit');
    hook(historicalChild.id, 'UserPromptSubmit');
    harness.handles[0]!.transcriptCursor = { identity: 'current', offset: 100 };
    harness.handles[1]!.transcriptCursor = { identity: 'original', offset: 100 };
    vi.setSystemTime(Date.now() + 60_000);
    await vi.advanceTimersByTimeAsync(5000);

    harness.handles[0]!.transcriptCursor = { identity: 'current', offset: 200 };
    harness.handles[1]!.transcriptCursor = { identity: 'replacement', offset: 10_000 };
    await vi.advanceTimersByTimeAsync(120_000);

    expect(sessions.get(currentChild.id)?.runtimeAttention).toBeUndefined();
    expect(sessions.get(historicalChild.id)?.runtimeAttention?.reason).toBe('post_wake_no_progress');
  });

  it('keeps a child closed when it exits during the resume check and retains its runtime attention', async () => {
    vi.useFakeTimers();
    const { create, hook, sessions, harness, held } = setup();
    const child = await create('exits after resume');
    hook(child.id, 'UserPromptSubmit');
    vi.setSystemTime(Date.now() + 60_000);
    await vi.advanceTimersByTimeAsync(5000);

    harness.handles[0]!.emitExit(137);
    await vi.advanceTimersByTimeAsync(120_000);

    expect(sessions.get(child.id)).toMatchObject({ state: 'closed', exitCode: 137, runtimeAttention: { reason: 'post_wake_process_exited' } });
    expect(held()).toBe(0);
  });

  it('restarts the active-time grace after a second suspension and ignores a backwards clock jump', async () => {
    vi.useFakeTimers();
    const { create, hook, sessions } = setup();
    const child = await create('suspends twice');
    hook(child.id, 'UserPromptSubmit');
    vi.setSystemTime(Date.now() - 60_000);
    await vi.advanceTimersByTimeAsync(125_000);
    expect(sessions.get(child.id)?.runtimeAttention).toBeUndefined();
    vi.setSystemTime(Date.now() + 60_000);
    await vi.advanceTimersByTimeAsync(5000);
    await vi.advanceTimersByTimeAsync(100_000);
    vi.setSystemTime(Date.now() + 60_000);
    await vi.advanceTimersByTimeAsync(5000);
    await vi.advanceTimersByTimeAsync(119_999);
    expect(sessions.get(child.id)?.runtimeAttention).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(sessions.get(child.id)?.runtimeAttention?.reason).toBe('post_wake_no_progress');
  });

  it('separates an unavailable process probe from silence in a live process', async () => {
    vi.useFakeTimers();
    const { create, hook, sessions, harness } = setup();
    const child = await create('unknown process');
    hook(child.id, 'UserPromptSubmit');
    harness.handles[0]!.processState = 'unknown';
    vi.setSystemTime(Date.now() + 60_000);
    await vi.advanceTimersByTimeAsync(125_000);
    expect(sessions.get(child.id)).toMatchObject({ state: 'generating', runtimeAttention: { reason: 'post_wake_health_unknown' } });
    expect(harness.handles[0]!.killed).toBe(false);
  });

  it('bounds failed acquisition attempts and releases a recovered assertion even if release reports an error', async () => {
    vi.useFakeTimers();
    let attempts = 0;
    let held = false;
    const power: PowerApi = { acquire: () => {
      attempts += 1;
      if (attempts < 3) throw new Error('power unavailable');
      held = true;
      return { release: () => { held = false; throw new Error('release diagnostic'); } };
    } };
    const { create, hook, guard, powerFailures } = setup({ power });
    const child = await create('recovering power');
    hook(child.id, 'UserPromptSubmit');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(held).toBe(true);
    expect(attempts).toBe(3);

    expect(() => guard.stop()).not.toThrow();
    expect(held).toBe(false);
    expect(powerFailures()).toBe(3);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(attempts).toBe(3);
  });

  it('stops retrying an unavailable power API and still checks progress when protection is disabled', async () => {
    vi.useFakeTimers();
    let attempts = 0;
    const unavailable: PowerApi = { acquire: () => { attempts += 1; throw new Error('unavailable'); } };
    const { create, hook, sessions } = setup({ power: unavailable });
    const child = await create('power unavailable');
    hook(child.id, 'UserPromptSubmit');
    await vi.advanceTimersByTimeAsync(30_000);
    expect(attempts).toBe(3);

    const disabled = setup({ power: unavailable, enabled: false });
    const unprotectedChild = await disabled.create('disabled protection');
    disabled.hook(unprotectedChild.id, 'UserPromptSubmit');
    vi.setSystemTime(Date.now() + 60_000);
    await vi.advanceTimersByTimeAsync(125_000);
    expect(attempts).toBe(3);
    expect(disabled.sessions.get(unprotectedChild.id)?.runtimeAttention?.reason).toBe('post_wake_no_progress');
    expect(sessions.get(child.id)?.runtimeAttention?.reason).toBe('post_wake_no_progress');
  });

  it('continues observing recovery of an alerted launch after a backwards clock adjustment', async () => {
    vi.useFakeTimers();
    const { create, hook, sessions } = setup();
    const child = await create('recovering after a clock adjustment');
    hook(child.id, 'UserPromptSubmit');
    vi.setSystemTime(Date.now() + 60_000);
    await vi.advanceTimersByTimeAsync(125_000);
    expect(sessions.get(child.id)?.runtimeAttention?.reason).toBe('post_wake_no_progress');

    vi.setSystemTime(Date.now() - 60_000);
    await vi.advanceTimersByTimeAsync(5000);
    hook(child.id, 'PreToolUse');
    await vi.advanceTimersByTimeAsync(5000);

    expect(sessions.get(child.id)?.runtimeAttention).toBeUndefined();
  });
});
