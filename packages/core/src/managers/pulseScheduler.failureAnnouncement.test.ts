import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServerEvent } from '@openfleet/shared';
import { openDatabase } from '../db/database.js';
import { describeError } from '../errors/describeError.js';
import { EventBus } from '../events/eventBus.js';
import { FakeHarness } from '../harness/fakeHarness.js';
import { SessionService } from '../sessions/sessionService.js';
import { ManagerRepository } from './managerRepository.js';
import { PulseScheduler, type PulseSchedulerDeps } from './pulseScheduler.js';

const PULSE_SECONDS = 1;
const CADENCE_MS = PULSE_SECONDS * 1000;
const THROWN_DETAIL = 'sqlite write refused at /Users/someone/secret/openfleet.db';

type ErrorEvent = Extract<ServerEvent, { type: 'error' }>;

async function idleManagerWorld(options: { describeError?: PulseSchedulerDeps['describeError'] }) {
  const db = openDatabase(':memory:');
  const bus = new EventBus();
  const sessions = new SessionService({ db, bus, harnesses: [new FakeHarness()], baseUrl: 'http://127.0.0.1:7331', worktreesRoot: '/tmp/of-wt' });
  const managers = new ManagerRepository(db);
  const scheduler = new PulseScheduler({ managers, sessions, bus, describeError: options.describeError });
  const manager = await sessions.create({ directory: '/tmp', name: 'Lead', emoji: '🧭', harness: 'fake' });
  sessions.applyInput(manager.id, { kind: 'hook', event: { session_id: manager.id, hook_event_name: 'SessionStart' } as never });
  managers.insert({ sessionId: manager.id, pulseSeconds: PULSE_SECONDS, childrenCap: 1, missionText: 'x', createdAt: new Date().toISOString() });
  const errorEvents: ErrorEvent[] = [];
  bus.subscribe((event) => { if (event.type === 'error') errorEvents.push(event); });
  scheduler.onManagerCreated(managers.get(manager.id)!);
  return { sessions, scheduler, managerId: manager.id, errorEvents };
}

function makeSendMessageFail(sessions: SessionService) {
  const originalSendMessage = sessions.sendMessage.bind(sessions);
  let isFailing = true;
  vi.spyOn(sessions, 'sendMessage').mockImplementation((...args: Parameters<typeof sessions.sendMessage>) => {
    if (isFailing) throw new Error(THROWN_DETAIL);
    return originalSendMessage(...args);
  });
  return { recover: () => { isFailing = false; } };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('PulseScheduler — a failing pulse tick is announced to the clients', () => {
  it('broadcasts one internal_error event scoped to the manager, with a ref and a fixed message that carries no thrown detail', async () => {
    const { sessions, managerId, errorEvents } = await idleManagerWorld({ describeError });
    makeSendMessageFail(sessions);

    vi.advanceTimersByTime(CADENCE_MS);

    expect(errorEvents).toHaveLength(1);
    const { sessionId, error } = errorEvents[0]!;
    expect(sessionId).toBe(managerId);
    expect(errorEvents[0]).toMatchObject({ scope: 'broadcast' });
    expect(error).toMatchObject({ error: 'internal_error', kind: 'internal', retry: 'later', message: 'the daemon hit an unexpected error.' });
    expect(error.id).toMatch(/^[0-9a-f]{8}$/);
    expect(JSON.stringify(error)).not.toContain('secret');
  });

  it('keeps re-arming the cadence while it announces', async () => {
    const { sessions, errorEvents } = await idleManagerWorld({ describeError });
    makeSendMessageFail(sessions);

    vi.advanceTimersByTime(CADENCE_MS);

    expect(errorEvents).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(1);
  });

  it('announces once per failure streak, not once per failing tick', async () => {
    const { sessions, errorEvents } = await idleManagerWorld({ describeError });
    makeSendMessageFail(sessions);

    vi.advanceTimersByTime(CADENCE_MS * 5);

    expect(errorEvents).toHaveLength(1);
  });

  it('announces a new streak once a pulse succeeded in between', async () => {
    const { sessions, errorEvents } = await idleManagerWorld({ describeError });
    const sendMessage = makeSendMessageFail(sessions);
    vi.advanceTimersByTime(CADENCE_MS);
    sendMessage.recover();
    vi.advanceTimersByTime(CADENCE_MS); // this pulse succeeds
    expect(errorEvents).toHaveLength(1);
    vi.restoreAllMocks();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    makeSendMessageFail(sessions);

    vi.advanceTimersByTime(CADENCE_MS * 2);

    expect(errorEvents).toHaveLength(2);
  });

  it('announces nothing and still logs when no describeError is wired', async () => {
    const { sessions, errorEvents } = await idleManagerWorld({});
    makeSendMessageFail(sessions);

    vi.advanceTimersByTime(CADENCE_MS);

    expect(errorEvents).toHaveLength(0);
    expect(console.error).toHaveBeenCalled();
  });

  it('keeps a failed announcement from stopping the re-arm', async () => {
    const refusingDescribeError = () => { throw new Error('describe refused'); };
    const { sessions } = await idleManagerWorld({ describeError: refusingDescribeError });
    makeSendMessageFail(sessions);

    vi.advanceTimersByTime(CADENCE_MS);

    expect(vi.getTimerCount()).toBe(1);
  });
});
