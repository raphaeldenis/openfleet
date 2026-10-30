import type { ServerEvent } from '@openfleet/shared';
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_MODEL_TABLE } from '../models.js';
import { ArbiterRunner, type ArbiterRunnerDeps } from './arbiterRunner.js';

const MANAGER_ID = 'manager-1';
const BATCH_ID = 'b1b1b1b1-0000-0000-0000-000000000000';
const BATCH_TAG = `[${BATCH_ID.slice(0, 8)}]`;

interface FakeSession { id: string; name: string; role: string; parentId: string; state: string; directory: string; harness: string; branch?: string; projectId?: string }
interface Scheduled { delayMs: number; run: () => void; cancelled: boolean }

function aRunner({ batchesWithOpenQuestions = [BATCH_ID] }: { batchesWithOpenQuestions?: string[] } = {}) {
  const sessionsById = new Map<string, FakeSession>();
  const listeners: ((event: ServerEvent) => void)[] = [];
  const scheduled: Scheduled[] = [];
  const closeCalls: string[] = [];
  const created: FakeSession[] = [];
  let releaseCreate: (() => void) | undefined;
  const state = {
    closesToFail: 0,
    closeDuringCreate: false,
    createRejects: false,
    createAttempts: 0,
    /** Makes create() wait until the returned function is called: every call, or only the given attempt (1-based). */
    holdCreate: ({ onlyAttempt }: { onlyAttempt?: number } = {}) => {
      const held = new Promise<void>((resolve) => { releaseCreate = resolve; });
      createGate = held;
      gatedAttempt = onlyAttempt;
      return () => releaseCreate?.();
    },
  };
  let createGate: Promise<void> | undefined;
  let gatedAttempt: number | undefined;
  const emitClosed = (sessionId: string) => listeners.forEach((listener) => listener({ type: 'session.closed', sessionId, reason: 'harness_exit' } as ServerEvent));

  sessionsById.set(MANAGER_ID, { id: MANAGER_ID, name: 'Manager', role: 'manager', parentId: '', state: 'running', directory: '/work', harness: 'fake' });
  const escalateBatchToHuman = vi.fn(() => undefined);
  const deps = {
    sessions: {
      create: async (spec: Record<string, unknown>) => {
        state.createAttempts += 1;
        const isGated = gatedAttempt === undefined || gatedAttempt === state.createAttempts;
        if (isGated) await createGate;
        if (state.createRejects) throw new Error('create failed');
        const session: FakeSession = { id: `arbiter-${created.length + 1}`, name: spec.name as string, role: spec.role as string, parentId: spec.parentId as string, state: 'running', directory: spec.directory as string, harness: 'fake' };
        sessionsById.set(session.id, session);
        created.push(session);
        if (state.closeDuringCreate) { session.state = 'closed'; emitClosed(session.id); }
        return session;
      },
      get: (id: string) => sessionsById.get(id),
      list: () => [...sessionsById.values()],
      close: async (id: string) => {
        closeCalls.push(id);
        if (state.closesToFail > 0) { state.closesToFail -= 1; throw new Error('close failed'); }
        const session = sessionsById.get(id);
        if (session) session.state = 'closed';
      },
    },
    bus: { subscribe: (listener: (event: ServerEvent) => void) => { listeners.push(listener); return () => {}; } },
    managers: { get: () => ({ sessionId: MANAGER_ID, pulseSeconds: 60, pulseEnabled: true, mode: 'watching' }) },
    projects: { get: () => undefined },
    repository: {
      findBatch: (id: string) => (id === BATCH_ID ? { id, managerId: MANAGER_ID, ticket: 'CCM-1', planNoteId: 'n1', planNoteRev: 1 } : undefined),
      questionsOfBatch: () => [{ questionId: 'q1', route: 'arbiter', status: 'open', declaredClass: 'technical', text: 'which name?' }],
      addArbiterRun: () => {},
      arbiterRunsOfTicket: () => 0,
      batchIdsWithOpenArbiterQuestions: () => batchesWithOpenQuestions,
    },
    escalations: { escalateBatchToHuman },
    modelTable: DEFAULT_MODEL_TABLE,
    schedule: (run: () => void, delayMs: number) => {
      const entry: Scheduled = { delayMs, run: () => { if (!entry.cancelled) run(); }, cancelled: false };
      scheduled.push(entry);
      return () => { entry.cancelled = true; };
    },
  };
  const runner = new ArbiterRunner(deps as unknown as ArbiterRunnerDeps);
  const addLiveArbiter = (id: string, name = `Arbiter CCM-1 ${BATCH_TAG}`) =>
    sessionsById.set(id, { id, name, role: 'arbiter', parentId: MANAGER_ID, state: 'running', directory: '/work', harness: 'fake' });
  return { runner, state, created, closeCalls, scheduled, escalateBatchToHuman, addLiveArbiter, emitClosed, sessionsById };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('ArbiterRunner — no arbiter session stays live without a run', () => {
  it('closes at recovery a resumed arbiter whose batch has no open question', () => {
    const { runner, addLiveArbiter, closeCalls } = aRunner({ batchesWithOpenQuestions: [] });
    addLiveArbiter('orphan-1');

    runner.recover();

    expect(closeCalls).toEqual(['orphan-1']);
  });

  it('keeps at recovery the resumed arbiter of a batch that still waits for it', () => {
    const { runner, addLiveArbiter, closeCalls } = aRunner();
    addLiveArbiter('resumed-1');

    runner.recover();

    expect(closeCalls).toEqual([]);
    expect(runner.batchOf('resumed-1')).toBe(BATCH_ID);
  });

  it('retries the close of an arbiter whose first close failed after its opinion was recorded', async () => {
    const { runner, created, state, closeCalls, scheduled, sessionsById } = aRunner();
    await runner.launch(BATCH_ID);
    const arbiterId = created[0]!.id;
    state.closesToFail = 1;

    runner.settle(arbiterId);
    await settle();
    scheduled.filter(({ cancelled }) => !cancelled).forEach(({ run }) => run());
    await settle();

    expect(closeCalls).toEqual([arbiterId, arbiterId]);
    expect(sessionsById.get(arbiterId)!.state).toBe('closed');
  });

  it('fires no close retry once the runner is stopped at daemon shutdown', async () => {
    const { runner, created, state, closeCalls, scheduled } = aRunner();
    await runner.launch(BATCH_ID);
    const arbiterId = created[0]!.id;
    state.closesToFail = 1;
    runner.settle(arbiterId);
    await settle();

    runner.stop();
    scheduled.forEach(({ run }) => run());
    await settle();

    expect(closeCalls).toEqual([arbiterId]);
  });

  it('cancels the expiry timer of a live arbiter when the runner is stopped', async () => {
    const { runner, scheduled, created } = aRunner();
    await runner.launch(BATCH_ID);

    runner.stop();

    expect(scheduled.map(({ cancelled }) => cancelled)).toEqual([true]);
    expect(runner.batchOf(created[0]!.id)).toBeUndefined();
  });

  it('closes an arbiter whose creation resolves after stop(), arms no expiry timer and launches nothing else', async () => {
    const { runner, state, created, closeCalls, scheduled, escalateBatchToHuman } = aRunner();
    const releaseCreate = state.holdCreate();

    const outcome = runner.launch(BATCH_ID);
    runner.stop();
    releaseCreate();
    await outcome;
    await settle();

    expect(closeCalls).toEqual([created[0]!.id]);
    expect(scheduled).toEqual([]);
    expect(created).toHaveLength(1);
    expect(escalateBatchToHuman).not.toHaveBeenCalled();
  });

  it('starts no second arbiter and escalates nothing when creation rejects after stop()', async () => {
    const { runner, state, scheduled, escalateBatchToHuman } = aRunner();
    const releaseCreate = state.holdCreate();

    const outcome = runner.launch(BATCH_ID);
    runner.stop();
    state.createRejects = true;
    releaseCreate();
    await outcome;
    await settle();

    expect(state.createAttempts).toBe(1);
    expect(escalateBatchToHuman).not.toHaveBeenCalled();
    expect(scheduled).toEqual([]);
  });

  it('hands nothing to the human and starts no third arbiter when the retry creation rejects after stop()', async () => {
    const { runner, state, scheduled, escalateBatchToHuman } = aRunner();
    state.createRejects = true;
    const releaseRetryCreate = state.holdCreate({ onlyAttempt: 2 });

    const outcome = runner.launch(BATCH_ID);
    await settle();
    runner.stop();
    releaseRetryCreate();
    await outcome;
    await settle();

    expect(state.createAttempts).toBe(2);
    expect(escalateBatchToHuman).not.toHaveBeenCalled();
    expect(scheduled).toEqual([]);
  });

  it('launches nothing once stopped', async () => {
    const { runner, state } = aRunner();
    runner.stop();

    const outcome = await runner.launch(BATCH_ID);

    expect(outcome).toEqual({ status: 'idle' });
    expect(state.createAttempts).toBe(0);
  });

  it('tracks no arbiter after stop(), whatever calls track', () => {
    const { runner, addLiveArbiter, scheduled } = aRunner();
    addLiveArbiter('resumed-1');
    runner.stop();

    runner.recover();

    expect(scheduled).toEqual([]);
    expect(runner.batchOf('resumed-1')).toBeUndefined();
  });

  it('treats an arbiter that closes while it is being created as a lost arbiter, then hands the batch to the human on the second loss', async () => {
    const { runner, state, created, escalateBatchToHuman } = aRunner();
    state.closeDuringCreate = true;

    await runner.launch(BATCH_ID);
    await settle();

    expect(created).toHaveLength(2);
    expect(escalateBatchToHuman).toHaveBeenCalledTimes(1);
  });

  it('forgets the failures of a batch once its opinion is recorded: a later loss starts a new arbiter instead of failing closed', async () => {
    const { runner, created, escalateBatchToHuman, emitClosed } = aRunner();
    await runner.launch(BATCH_ID);
    emitClosed(created[0]!.id);
    await settle();
    runner.settle(created[1]!.id);
    await settle();

    await runner.launch(BATCH_ID);
    emitClosed(created[2]!.id);
    await settle();

    expect(created).toHaveLength(4);
    expect(escalateBatchToHuman).not.toHaveBeenCalled();
  });
});
