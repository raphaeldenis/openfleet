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
    /** Makes the next create() wait until the returned function is called. */
    holdCreate: () => {
      const held = new Promise<void>((resolve) => { releaseCreate = resolve; });
      createGate = held;
      return () => releaseCreate?.();
    },
  };
  let createGate: Promise<void> | undefined;
  const emitClosed = (sessionId: string, reason = 'harness_exit') => listeners.forEach((listener) => listener({ type: 'session.closed', sessionId, reason } as ServerEvent));
  const workspaces = { created: [] as string[], removed: [] as string[], swept: [] as ReadonlySet<string>[] };
  const realPaths = { byPath: {} as Record<string, string>, unresolvable: false };

  sessionsById.set(MANAGER_ID, { id: MANAGER_ID, name: 'Manager', role: 'manager', parentId: '', state: 'running', directory: '/work', harness: 'fake' });
  const escalateBatchToHuman = vi.fn(() => undefined);
  const deps = {
    sessions: {
      create: async (spec: Record<string, unknown>) => {
        state.createAttempts += 1;
        await createGate;
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
    workspaces: {
      create: () => { const path = `/arbiter-workspaces/w${workspaces.created.length + 1}`; workspaces.created.push(path); return path; },
      remove: (path: string) => { workspaces.removed.push(path); },
      removeAllExcept: (keep: ReadonlySet<string>) => { workspaces.swept.push(keep); },
    },
    realPathOf: (path: string) => {
      if (realPaths.unresolvable) throw new Error(`cannot resolve ${path}`);
      return realPaths.byPath[path] ?? path;
    },
    schedule: (run: () => void, delayMs: number) => {
      const entry: Scheduled = { delayMs, run: () => { if (!entry.cancelled) run(); }, cancelled: false };
      scheduled.push(entry);
      return () => { entry.cancelled = true; };
    },
  };
  const runner = new ArbiterRunner(deps as unknown as ArbiterRunnerDeps);
  const addLiveArbiter = (id: string, name = `Arbiter CCM-1 ${BATCH_TAG}`) =>
    sessionsById.set(id, { id, name, role: 'arbiter', parentId: MANAGER_ID, state: 'running', directory: '/work', harness: 'fake' });
  const createSpecs: Record<string, unknown>[] = [];
  const createdBySession = deps.sessions.create;
  deps.sessions.create = async (spec: Record<string, unknown>) => { createSpecs.push(spec); return createdBySession(spec); };
  return { runner, state, created, closeCalls, scheduled, escalateBatchToHuman, addLiveArbiter, emitClosed, sessionsById, workspaces, realPaths, createSpecs };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('ArbiterRunner — the arbiter starts in a neutral workspace', () => {
  it('starts in a fresh workspace and reads the directory of the manager through a read directory', async () => {
    const { runner, createSpecs, workspaces } = aRunner();

    await runner.launch(BATCH_ID);

    expect(createSpecs).toEqual([expect.objectContaining({ directory: workspaces.created[0], readDirectories: ['/work'] })]);
    expect(createSpecs[0]!.directory).not.toBe('/work');
  });

  it('gives the arbiter the resolved real path of the directory it reads', async () => {
    const { runner, createSpecs, realPaths } = aRunner();
    realPaths.byPath['/work'] = '/real/work';

    await runner.launch(BATCH_ID);

    expect(createSpecs[0]!.readDirectories).toEqual(['/real/work']);
  });

  it('reads the worktree of the ticket when a child of the manager works on it', async () => {
    const { runner, createSpecs, sessionsById } = aRunner();
    sessionsById.set('dev-1', { id: 'dev-1', name: 'Dev', role: 'dev', parentId: MANAGER_ID, state: 'running', directory: '/worktrees/CCM-1', harness: 'fake', branch: 'feature/CCM-1-x' });

    await runner.launch(BATCH_ID);

    expect(createSpecs[0]!.readDirectories).toEqual(['/worktrees/CCM-1']);
    expect(createSpecs[0]!.directory).not.toBe('/worktrees/CCM-1');
  });

  it('creates no workspace and hands the batch over when the directory to read cannot be resolved', async () => {
    const { runner, workspaces, realPaths, created, escalateBatchToHuman } = aRunner();
    realPaths.unresolvable = true;

    await runner.launch(BATCH_ID);

    expect(created).toEqual([]);
    expect(workspaces.created).toEqual([]);
    expect(escalateBatchToHuman).toHaveBeenCalledOnce();
  });

  it('removes the workspace when the arbiter session closes', async () => {
    const { runner, emitClosed, workspaces } = aRunner();
    await runner.launch(BATCH_ID);

    runner.settle('arbiter-1');
    emitClosed('arbiter-1', 'user');

    expect(workspaces.removed).toEqual([workspaces.created[0]]);
  });

  it('removes the workspace of an arbiter that could not be created', async () => {
    const { runner, state, workspaces } = aRunner();
    state.createRejects = true;

    await runner.launch(BATCH_ID);

    expect(workspaces.created.length).toBeGreaterThan(0);
    expect(workspaces.removed).toEqual(workspaces.created);
  });

  it('keeps the workspace when the daemon shuts down, so the arbiter can be resumed', async () => {
    const { runner, emitClosed, workspaces } = aRunner();
    await runner.launch(BATCH_ID);

    emitClosed('arbiter-1', 'daemon_shutdown');

    expect(workspaces.removed).toEqual([]);
  });

  it('removes at recovery every workspace but those of the live arbiters', () => {
    const { runner, addLiveArbiter, workspaces, sessionsById } = aRunner();
    addLiveArbiter('resumed-1');
    sessionsById.get('resumed-1')!.directory = '/arbiter-workspaces/resumed';

    runner.recover();

    expect(workspaces.swept).toEqual([new Set(['/arbiter-workspaces/resumed'])]);
  });

  it('removes at recovery the workspace of a resumed arbiter that is closed because no batch waits for it', async () => {
    const { runner, addLiveArbiter, workspaces, sessionsById, emitClosed } = aRunner({ batchesWithOpenQuestions: [] });
    addLiveArbiter('orphan-1');
    sessionsById.get('orphan-1')!.directory = '/arbiter-workspaces/orphan';

    runner.recover();
    emitClosed('orphan-1', 'user');

    expect(workspaces.removed).toEqual(['/arbiter-workspaces/orphan']);
  });
});

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
