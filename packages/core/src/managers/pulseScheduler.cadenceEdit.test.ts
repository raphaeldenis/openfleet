import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openDatabase } from '../db/database.js';
import { EventBus } from '../events/eventBus.js';
import { FakeHarness } from '../harness/fakeHarness.js';
import { SessionService, SUBMIT_KEYSTROKE_DELAY_MS } from '../sessions/sessionService.js';
import { ManagerRepository } from './managerRepository.js';
import { PULSE_MESSAGE, PulseScheduler } from './pulseScheduler.js';

const pulseCount = (written: string[]) => written.filter((entry) => entry === PULSE_MESSAGE).length;

async function anIdleManagerPulsingEvery(pulseSeconds: number) {
  const db = openDatabase(':memory:');
  const bus = new EventBus();
  const harness = new FakeHarness();
  const sessions = new SessionService({ db, bus, harnesses: [harness], baseUrl: 'http://127.0.0.1:7331', worktreesRoot: '/tmp/of-wt' });
  const managers = new ManagerRepository(db);
  const scheduler = new PulseScheduler({ managers, sessions, bus });
  const manager = await sessions.create({ directory: '/tmp', name: 'Lead', emoji: '🧭', harness: 'fake' });
  sessions.applyInput(manager.id, { kind: 'hook', event: { session_id: manager.id, hook_event_name: 'SessionStart' } as never });
  managers.insert({ sessionId: manager.id, pulseSeconds, childrenCap: 1, missionText: 'x', createdAt: new Date().toISOString() });
  scheduler.onManagerCreated(managers.get(manager.id)!);
  return { scheduler, managers, harness, managerId: manager.id };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('PulseScheduler: a cadence edited on a live manager', () => {
  it('pulses after the new interval, not the old one', async () => {
    const { scheduler, managers, harness, managerId } = await anIdleManagerPulsingEvery(3600);
    managers.update(managerId, { pulseSeconds: 5 });

    scheduler.onManagerUpdated(managers.get(managerId)!);
    vi.advanceTimersByTime(4999);
    expect(pulseCount(harness.handles[0]!.written)).toBe(0);
    vi.advanceTimersByTime(1);
    vi.advanceTimersByTime(SUBMIT_KEYSTROKE_DELAY_MS);

    expect(pulseCount(harness.handles[0]!.written)).toBe(1);
  });
});
