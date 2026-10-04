import { signal } from '@angular/core';
import type { DaemonIssue, Session, SilentBlock, WorkingState } from '@openfleet/shared';

export const NOW_ISO = '2026-09-30T10:00:00.000Z';
const MINUTE_MS = 60_000;

export const minutesBeforeNow = (minutes: number): string => new Date(Date.parse(NOW_ISO) - minutes * MINUTE_MS).toISOString();

export function sessionOf(patch: Partial<Session> = {}): Session {
  return {
    id: 's1',
    name: 'Gimli',
    emoji: '⚔️',
    directory: '/tmp/wt',
    harness: 'claude-cli',
    state: 'idle',
    stateSince: NOW_ISO,
    createdAt: NOW_ISO,
    ...patch,
  };
}

export function stateOf(patch: Partial<WorkingState> = {}): WorkingState {
  return {
    sessionId: 's1',
    plan: [],
    todo: [],
    remaining: [],
    questionsForHuman: [],
    internalQuestions: [],
    blockers: [],
    updatedAt: minutesBeforeNow(1),
    ...patch,
  };
}

/** What a daemon that reports no working state, no degraded issue and no failure gives a spec's own FleetEventsService fake. */
export function silentWorkingStateSignals() {
  return {
    daemonIssues: signal<DaemonIssue[]>([]),
    backgroundFailures: signal<unknown[]>([]),
    dismissBackgroundFailure: () => undefined,
    silentBlocks: signal<SilentBlock[]>([]),
    dismissSilentBlock: () => undefined,
    closeReasonOf: () => undefined,
    workingStates: signal<ReadonlyMap<string, WorkingState>>(new Map()),
    workingStatesReported: signal(false),
    workingStateMaxAgeMinutes: signal<number | undefined>(undefined),
    workingStateMaxBytes: signal<number | undefined>(undefined),
  };
}

interface FakeEventsOptions {
  sessions?: Session[];
  states?: WorkingState[];
  reported?: boolean;
  maxAgeMinutes?: number | undefined;
  maxBytes?: number | undefined;
}

/** The slice of FleetEventsService the working-state views read, as plain signals. */
export function fakeWorkingStateEvents(options: FakeEventsOptions = {}) {
  const { sessions = [sessionOf()], states = [], reported = true } = options;
  return {
    ...silentWorkingStateSignals(),
    sessions: signal(sessions),
    approvals: signal<unknown[]>([]),
    managers: signal<unknown[]>([]),
    workingStates: signal<ReadonlyMap<string, WorkingState>>(new Map(states.map((state) => [state.sessionId, state]))),
    workingStatesReported: signal(reported),
    workingStateMaxAgeMinutes: signal<number | undefined>('maxAgeMinutes' in options ? options.maxAgeMinutes : 30),
    workingStateMaxBytes: signal<number | undefined>('maxBytes' in options ? options.maxBytes : 6144),
  };
}
