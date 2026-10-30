import { MANAGER_ROLE } from '@openfleet/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { EventBus } from '../events/eventBus.js';
import type { AgentMessageSent } from '../sessions/sessionService.js';
import type { ChildSilenceRepository, StoredSilenceCheck } from './childSilenceRepository.js';
import { ChildSilenceWatch, type ChildSilenceWatchDeps } from './childSilenceWatch.js';

const MINUTE_MS = 60_000;
const DELAY_MS = 10 * MINUTE_MS;
const BOOT_AT = Date.parse('2026-10-30T10:00:00.000Z');

interface FakeSession { id: string; name: string; role?: string; parentId?: string; state: string; stateSince: string }
interface ArmedTimer { callback: () => void; delayMs: number; isCancelled: boolean }

let nowMs: number;
let sessionsById: Map<string, FakeSession>;
let storedChecks: Map<string, StoredSilenceCheck>;
let armedTimers: ArmedTimer[];
let sentMessages: { sessionId: string; body: string }[];
let messageListeners: ((message: AgentMessageSent) => void)[];
let managerRecord: { mode?: string } | undefined;

const livingTimers = () => armedTimers.filter((timer) => !timer.isCancelled);
const fireLivingTimers = () => { for (const timer of livingTimers()) timer.callback(); };
const addSession = (session: Partial<FakeSession> & { id: string }) =>
  sessionsById.set(session.id, { name: session.id, state: 'idle', stateSince: new Date(BOOT_AT - 60 * MINUTE_MS).toISOString(), ...session });
const storeCheck = ({ armedMinutesAgo, dueInMinutes }: { armedMinutesAgo: number; dueInMinutes: number }) =>
  storedChecks.set('worker', {
    childId: 'worker', managerId: 'lead',
    armedAt: new Date(BOOT_AT - armedMinutesAgo * MINUTE_MS).toISOString(), dueAt: new Date(BOOT_AT + dueInMinutes * MINUTE_MS).toISOString(),
  });

const checksRepository = {
  save: (check: StoredSilenceCheck) => { storedChecks.set(check.childId, check); },
  remove: (childId: string) => { storedChecks.delete(childId); },
  list: () => [...storedChecks.values()],
} as unknown as ChildSilenceRepository;

const buildWatch = (overrides: Partial<ChildSilenceWatchDeps> = {}) =>
  new ChildSilenceWatch({
    sessions: {
      get: (id: string) => sessionsById.get(id),
      sendMessage: (message: { sessionId: string; body: string }) => { sentMessages.push(message); },
      onAgentMessageSent: (listener: (message: AgentMessageSent) => void) => { messageListeners.push(listener); return () => {}; },
    } as unknown as ChildSilenceWatchDeps['sessions'],
    managers: { getWithinBounds: () => managerRecord } as unknown as ChildSilenceWatchDeps['managers'],
    bus: new EventBus(),
    delayMs: DELAY_MS,
    checks: checksRepository,
    clock: () => nowMs,
    schedule: (callback, delayMs) => {
      const timer: ArmedTimer = { callback, delayMs, isCancelled: false };
      armedTimers.push(timer);
      return () => { timer.isCancelled = true; };
    },
    ...overrides,
  });
const childWritesToItsManager = () => { for (const listener of messageListeners) listener({ fromSessionId: 'worker', toSessionId: 'lead' }); };

beforeEach(() => {
  nowMs = BOOT_AT;
  sessionsById = new Map();
  storedChecks = new Map();
  armedTimers = [];
  sentMessages = [];
  messageListeners = [];
  managerRecord = undefined;
  addSession({ id: 'lead', role: MANAGER_ROLE });
  addSession({ id: 'worker', parentId: 'lead' });
});

describe('the wake of a silence check restored at boot', () => {
  it('wakes the manager although the timer fires one millisecond before the deadline', () => {
    storeCheck({ armedMinutesAgo: 6, dueInMinutes: 4 });
    buildWatch().restore();

    nowMs = BOOT_AT + 4 * MINUTE_MS - 1;
    fireLivingTimers();

    expect(sentMessages).toHaveLength(1);
    expect(storedChecks.size).toBe(0);
  });

  it('wakes the manager at the stored deadline when the delay is longer at the second boot', () => {
    storeCheck({ armedMinutesAgo: 6, dueInMinutes: 4 });
    buildWatch({ delayMs: 30 * MINUTE_MS }).restore();

    expect(livingTimers().map((timer) => timer.delayMs)).toEqual([4 * MINUTE_MS]);
    nowMs = BOOT_AT + 4 * MINUTE_MS;
    fireLivingTimers();

    expect(sentMessages).toHaveLength(1);
  });

  it('words the age of a restored check from the message and says the last sign of life is unknown', () => {
    storeCheck({ armedMinutesAgo: 6, dueInMinutes: 4 });
    buildWatch().restore();

    nowMs = BOOT_AT + 4 * MINUTE_MS;
    fireLivingTimers();

    const body = sentMessages[0]!.body;
    expect(body).toContain('message of 10 min ago');
    expect(body).toContain('last known sign of life unknown after a restart');
    expect(body).not.toContain('last sign of life is');
  });
});

describe('the children that answer or vanish around the restore', () => {
  it('arms nothing for a check whose child answered its manager before the restore', () => {
    storeCheck({ armedMinutesAgo: 6, dueInMinutes: 4 });
    const watch = buildWatch();

    childWritesToItsManager();
    watch.restore();

    expect(livingTimers()).toEqual([]);
    expect(storedChecks.size).toBe(0);
  });

  it('deletes the stored check of a child that now has another parent', () => {
    storeCheck({ armedMinutesAgo: 6, dueInMinutes: 4 });
    addSession({ id: 'worker', parentId: 'other-lead' });

    buildWatch().restore();

    expect(livingTimers()).toEqual([]);
    expect(storedChecks.size).toBe(0);
  });

  it('deletes the stored check of a child that does not exist any more', () => {
    storeCheck({ armedMinutesAgo: 6, dueInMinutes: 4 });
    sessionsById.delete('worker');

    buildWatch().restore();

    expect(livingTimers()).toEqual([]);
    expect(storedChecks.size).toBe(0);
  });

  it('tells nobody and deletes the stored check when the manager is disabled at boot', () => {
    storeCheck({ armedMinutesAgo: 20, dueInMinutes: -10 });
    managerRecord = { mode: 'disabled' };
    buildWatch().restore();

    fireLivingTimers();

    expect(sentMessages).toEqual([]);
    expect(storedChecks.size).toBe(0);
  });

  it('keeps one timer when restore runs twice', () => {
    storeCheck({ armedMinutesAgo: 6, dueInMinutes: 4 });
    const watch = buildWatch();

    watch.restore();
    watch.restore();

    expect(livingTimers()).toHaveLength(1);
    fireLivingTimers();
    expect(sentMessages).toHaveLength(1);
  });
});
