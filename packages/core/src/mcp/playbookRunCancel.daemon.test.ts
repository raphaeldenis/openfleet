import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Session } from '@openfleet/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { registerPlaybookRunTools } from './playbookRunTools.js';
import { OTHER_PROJECT_ID, OWN_PROJECT_ID, startGovernanceFixture, type GovernanceFixture } from '../governance/governanceQueue.testkit.js';
import { createManualTimers, deferred, until, type ManualTimers } from '../integrations/manualTimers.testkit.js';
import type { HttpStepNetwork } from '../playbooks/httpStepRequest.js';
import { createInMemorySecretStore, type InMemorySecretStore } from '../secrets/inMemorySecretStore.js';
import { SecretRefRepository } from '../secrets/secretRefRepository.js';
import { createTempDirTracker } from '../tempDirTracker.js';

/*
 * Guards of the cancellation of a run, each with the test that fails when the guard is removed (replay: break the line, run this file, restore).
 *  1. a sleeping wait ends        `liveTree.signal` in `sleep`         -> 'cancels a run asleep on a waitFor cell ...'
 *  2. no attempt after a cancel   `isStopping` in the retries          -> 'cancels a run asleep in a retry backoff ...'
 *  3. a script is killed          `signal: context.liveTree.signal`    -> 'kills the script in flight ...'
 *  4. a question is closed        `abandonPendingQuestion`             -> 'closes the question of a run waiting for a human ...'
 *  5. the whole tree              `liveTree: context.liveTree`         -> 'cancels the children of a run ...', 'cancels the whole tree when a child is named'
 *  6. a finished run is refused   `isRunningHere`                      -> 'refuses a run that has already ended ...'
 *  7. the project of the session  `runOfProject`                       -> 'answers a run of another project like a run that does not exist'
 */
type Client = Awaited<ReturnType<GovernanceFixture['connect']>>;

const START_OF_TEST_TIME = Date.parse('2026-11-23T10:00:00.000Z');
const directories = createTempDirTracker();
let fixture: GovernanceFixture | undefined;
let timers: ManualTimers;
let lead: Client;
let scriptRoot = '';
let markers = '';
let now: number;
/** The instants the next reads of the clock return, one each, before it goes back to `now`. */
let scriptedClockReads: number[] = [];
let secretStore: InMemorySecretStore;

let releaseHeldSecretReads: (() => void) | undefined;

afterEach(async () => {
  releaseHeldSecretReads?.();
  releaseHeldSecretReads = undefined;
  if (markers !== '') writeFileSync(join(markers, 'go'), '');
  await fixture?.close();
  fixture = undefined;
  directories.removeAll();
});

const boot = async (limits: { maxConcurrentRuns?: number; httpNetwork?: HttpStepNetwork } = {}) => {
  now = START_OF_TEST_TIME;
  scriptedClockReads = [];
  timers = createManualTimers();
  secretStore = createInMemorySecretStore();
  scriptRoot = directories.make('cancel-scripts-');
  markers = directories.make('cancel-markers-');
  fixture = await startGovernanceFixture({ playbooks: { scriptRoots: [scriptRoot], clock: () => new Date(scriptedClockReads.shift() ?? now).toISOString(), startTimer: timers.startTimer, ...limits }, secrets: { store: secretStore } });
  lead = await fixture.connect(fixture.lead.id);
  return fixture;
};

const writeScript = (name: string, body: string) => {
  const path = join(scriptRoot, name);
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o700);
};
const tool = async (client: Client, name: string, args: Record<string, unknown> = {}) => {
  const result = await client.callTool({ name, arguments: args });
  const text = (result.content as { text: string }[])[0]!.text;
  return { isError: result.isError === true, text, json: result.isError === true ? undefined : (JSON.parse(text) as Record<string, any>) };
};
const jsonOf = async <T>(response: Response) => await response.json() as T;
const waitForCell = (id = 'wait', extra: Record<string, unknown> = {}) => ({ id, kind: 'waitFor', predicate: [{ lhs: 'wait.elapsedMs', op: 'lt', rhs: 0 }], pollMs: 1000, ...extra });
const approvedPlaybook = async (cells: Record<string, unknown>[], projectId = OWN_PROJECT_ID, extra: Record<string, unknown> = {}) => {
  const f = fixture!;
  const playbook = await jsonOf<{ id: string; contentRev: number }>(await f.api('/api/playbooks', { method: 'POST', body: JSON.stringify({ projectId, name: `P-${randomUUID()}`, cells, ...extra }) }));
  const { digest } = await jsonOf<{ digest: string }>(await f.api(`/api/playbooks/${playbook.id}/approval`));
  expect((await f.api(`/api/playbooks/${playbook.id}/approve`, { method: 'POST', body: JSON.stringify({ digest }) })).status).toBe(200);
  return playbook;
};
const startedRunId = async (playbook: string, inputs: Record<string, unknown> = {}) => {
  const started = await tool(lead, 'run_playbook', { playbook, inputs });
  expect(started.isError, started.text).toBe(false);
  return started.json!.run.id as string;
};
const runRow = (runId: string) => fixture!.db.prepare('SELECT status, error_code, ended_at FROM playbook_runs WHERE id = ?').get(runId) as { status: string; error_code: string | null; ended_at: string | null };
const stepRows = (runId: string) => fixture!.db.prepare('SELECT step_id, status, error_code FROM playbook_run_steps WHERE run_id = ? ORDER BY seq').all(runId) as { step_id: string; status: string; error_code: string | null }[];
const runsStillRunning = () => (fixture!.db.prepare("SELECT COUNT(*) AS n FROM playbook_runs WHERE status IN ('running', 'waiting_manual')").get() as { n: number }).n;
const CANCELLED = { status: 'failed', error_code: 'run_cancelled' };

describe('cancelling a run of a playbook', () => {
  it('cancels a run asleep on a waitFor cell: the run and its step end failed with run_cancelled, and the place among the runs is free', async () => {
    await boot({ maxConcurrentRuns: 1 });
    const sleeping = await approvedPlaybook([waitForCell()]);
    const runId = await startedRunId(sleeping.id);
    await until(() => timers.armedCount() === 1);

    const cancelled = await tool(lead, 'cancel_playbook_run', { run_id: runId });

    expect(cancelled.isError, cancelled.text).toBe(false);
    expect(runRow(runId)).toMatchObject(CANCELLED);
    expect(runRow(runId).ended_at).not.toBeNull();
    expect(stepRows(runId)).toEqual([{ step_id: 'wait', status: 'failed', error_code: 'run_cancelled' }]);
    expect(timers.cancelledCount()).toBe(1);
    const another = await approvedPlaybook([waitForCell()]);
    expect((await tool(lead, 'run_playbook', { playbook: another.id })).isError).toBe(false);
  });

  it('cancels a run asleep in a retry backoff: no second attempt starts', async () => {
    await boot();
    const retrying = await approvedPlaybook([{ id: 'poll', kind: 'waitFor', predicate: [{ lhs: 'wait.elapsedMs', op: 'gte', rhs: 0 }], retry: { maxAttempts: 3, backoffMs: 60_000, until: [{ lhs: 'attempt.number', op: 'gte', rhs: 3 }] } }]);
    const runId = await startedRunId(retrying.id);
    await until(() => timers.armedCount() === 1);
    expect(timers.delaysArmed()).toEqual([60_000]);

    const cancelled = await tool(lead, 'cancel_playbook_run', { run_id: runId });

    expect(cancelled.isError, cancelled.text).toBe(false);
    expect(runRow(runId)).toMatchObject(CANCELLED);
    expect(stepRows(runId)).toEqual([{ step_id: 'poll', status: 'succeeded', error_code: null }]);
    timers.elapseAll();
    await until(() => runsStillRunning() === 0);
    expect(stepRows(runId)).toHaveLength(1);
  });

  it('kills the script in flight and ends its step failed with run_cancelled', async () => {
    await boot();
    writeScript('hold.sh', `touch ${join(markers, 'started')}; while [ ! -e ${join(markers, 'go')} ]; do sleep 0.05; done`);
    const holding = await approvedPlaybook([{ id: 'hold', kind: 'script', program: 'hold.sh', args: [], env: {} }]);
    const runId = await startedRunId(holding.id);
    await until(() => existsSync(join(markers, 'started')));

    const cancelled = await tool(lead, 'cancel_playbook_run', { run_id: runId });

    expect(cancelled.isError, cancelled.text).toBe(false);
    expect(runRow(runId)).toMatchObject(CANCELLED);
    expect(stepRows(runId)).toEqual([{ step_id: 'hold', status: 'failed', error_code: 'run_cancelled' }]);
  });

  it('closes the question of a run waiting for a human: the run ends failed with run_cancelled and the question is cancelled', async () => {
    await boot();
    const asking = await approvedPlaybook([{ id: 'ask', kind: 'manual', prompt: 'Ship it?' }]);
    const runId = await startedRunId(asking.id);
    await until(() => runRow(runId).status === 'waiting_manual');

    const cancelled = await tool(lead, 'cancel_playbook_run', { run_id: runId });

    expect(cancelled.isError, cancelled.text).toBe(false);
    expect(runRow(runId)).toMatchObject(CANCELLED);
    expect(stepRows(runId)).toEqual([{ step_id: 'ask', status: 'failed', error_code: 'run_cancelled' }]);
    expect(fixture!.db.prepare('SELECT status FROM playbook_manual_requests WHERE run_id = ?').get(runId)).toEqual({ status: 'cancelled' });
    expect(runsStillRunning()).toBe(0);
  });

  it('cancels the children of a run: every run of the tree ends failed with run_cancelled, no run is left running and the capacity of the tree is free', async () => {
    await boot({ maxConcurrentRuns: 2 });
    const child = await approvedPlaybook([waitForCell('child_wait')]);
    const parent = await approvedPlaybook([{ id: 'sub', kind: 'subPlaybook', playbookId: child.id }]);
    const parentRunId = await startedRunId(parent.id);
    await until(() => timers.armedCount() === 1);
    const childRunId = (fixture!.db.prepare('SELECT id FROM playbook_runs WHERE id <> ?').get(parentRunId) as { id: string }).id;

    const cancelled = await tool(lead, 'cancel_playbook_run', { run_id: parentRunId });

    expect(cancelled.isError, cancelled.text).toBe(false);
    expect(runRow(parentRunId)).toMatchObject(CANCELLED);
    expect(runRow(childRunId)).toMatchObject(CANCELLED);
    expect(stepRows(parentRunId)).toEqual([{ step_id: 'sub', status: 'failed', error_code: 'run_cancelled' }]);
    expect(stepRows(childRunId)).toEqual([{ step_id: 'child_wait', status: 'failed', error_code: 'run_cancelled' }]);
    expect(runsStillRunning()).toBe(0);
    const startedAgain = await tool(lead, 'run_playbook', { playbook: parent.id });
    expect(startedAgain.isError, startedAgain.text).toBe(false);
    await until(() => timers.armedCount() === 2);
    expect(runsStillRunning()).toBe(2);
  });

  it('cancels the whole tree when a child is named', async () => {
    await boot({ maxConcurrentRuns: 2 });
    const child = await approvedPlaybook([waitForCell('child_wait')]);
    const parent = await approvedPlaybook([{ id: 'sub', kind: 'subPlaybook', playbookId: child.id }]);
    const parentRunId = await startedRunId(parent.id);
    await until(() => timers.armedCount() === 1);
    const childRunId = (fixture!.db.prepare('SELECT id FROM playbook_runs WHERE id <> ?').get(parentRunId) as { id: string }).id;

    const cancelled = await tool(lead, 'cancel_playbook_run', { run_id: childRunId });

    expect(cancelled.isError, cancelled.text).toBe(false);
    expect(runRow(parentRunId)).toMatchObject(CANCELLED);
    expect(runRow(childRunId)).toMatchObject(CANCELLED);
    expect(runsStillRunning()).toBe(0);
  });

  it('refuses a run that has already ended with playbook_conflict, and changes nothing', async () => {
    await boot();
    writeScript('quick.sh', 'printf done');
    const quick = await approvedPlaybook([{ id: 'say', kind: 'script', program: 'quick.sh', args: [], env: {} }]);
    const runId = await startedRunId(quick.id);
    await until(() => runRow(runId).status === 'succeeded');
    const before = runRow(runId);

    const cancelled = await tool(lead, 'cancel_playbook_run', { run_id: runId });

    expect(cancelled.isError).toBe(true);
    expect(cancelled.text).toContain('playbook_conflict');
    expect(runRow(runId)).toEqual(before);
  });

  it('does not publish cancel_playbook_run to a worker session', async () => {
    await boot();
    const worker = await fixture!.connect(fixture!.worker.id);

    const workerTools = (await worker.listTools()).tools.map((published) => published.name);
    const managerTools = (await lead.listTools()).tools.map((published) => published.name);

    expect(managerTools).toContain('cancel_playbook_run');
    expect(workerTools).not.toContain('cancel_playbook_run');
  });

  it('refuses the invocation of cancel_playbook_run by a worker session even when the tool is registered, and leaves the run running', async () => {
    await boot();
    const sleeping = await approvedPlaybook([waitForCell()]);
    const runId = await startedRunId(sleeping.id);
    await until(() => timers.armedCount() === 1);
    const handlers = new Map<string, (args: Record<string, unknown>) => Promise<unknown>>();
    const registeringServer = { registerTool: (name: string, _config: unknown, handler: (args: Record<string, unknown>) => Promise<unknown>) => handlers.set(name, handler) } as unknown as McpServer;
    const workerSession = { ...fixture!.worker, projectId: OWN_PROJECT_ID } as Session;
    const cancelRunCalls: string[] = [];
    const untouchedDependencies = {
      playbooks: { getById: () => { throw new Error('the playbooks must not be read'); }, getInProject: () => { throw new Error('the playbooks must not be read'); } },
      runner: { start: async () => { throw new Error('unexpected'); }, startCell: async () => { throw new Error('unexpected'); }, cancelRun: async (id: string) => { cancelRunCalls.push(id); throw new Error('the run must not be cancelled'); } },
      runs: { get: () => { throw new Error('the runs must not be read'); }, stepsOf: () => [], listPageOfProject: () => [] },
      managers: { get: () => undefined },
    };
    registerPlaybookRunTools(registeringServer, { ...untouchedDependencies, caller: workerSession } as unknown as Parameters<typeof registerPlaybookRunTools>[1]);

    const refusal = handlers.get('cancel_playbook_run')!({ run_id: runId });

    await expect(refusal).rejects.toMatchObject({ code: 'not_a_manager' });
    expect(cancelRunCalls).toEqual([]);
    expect(runRow(runId).status).toBe('running');
  });

  it('answers a run of another project like a run that does not exist, and leaves it running', async () => {
    await boot();
    const foreign = await approvedPlaybook([waitForCell()], OTHER_PROJECT_ID);
    const started = await fixture!.api(`/api/playbooks/${foreign.id}/run`, { method: 'POST', body: JSON.stringify({ inputs: {} }) });
    const foreignRunId = (await jsonOf<{ id: string }>(started)).id;
    await until(() => timers.armedCount() === 1);

    const ofAnotherProject = await tool(lead, 'cancel_playbook_run', { run_id: foreignRunId });
    const unknown = await tool(lead, 'cancel_playbook_run', { run_id: randomUUID() });

    expect(ofAnotherProject.isError).toBe(true);
    expect(ofAnotherProject.text).toContain('playbook_run_not_found');
    expect(ofAnotherProject.text.replace(foreignRunId, '')).toBe(unknown.text.replace(/[0-9a-f-]{36}/, ''));
    expect(runRow(foreignRunId).status).toBe('running');
  });
});

const sleepMs = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const GUARD_AGAINST_A_HANG_MS = 1_500;
/** True when the promise settles before the guard: a cancel that waits for a slow read of secrets does not. */
const settlesBeforeTheGuard = (pending: Promise<unknown>): Promise<boolean> => Promise.race([pending.then(() => true, () => true), sleepMs(GUARD_AGAINST_A_HANG_MS).then(() => false)]);
const runCount = () => (fixture!.db.prepare('SELECT COUNT(*) AS n FROM playbook_runs').get() as { n: number }).n;

describe('cancelling a run whose child is still reading its secrets', () => {
  const SECRET_NAME = 'API_KEY';
  const secretHolderCell = { id: 'holder', kind: 'http', method: 'GET', url: 'https://example.invalid/', headers: { 'X-Key': `{{secret:${SECRET_NAME}}}` } };

  /** Holds every read of a secret until released: a child that needs a secret stops there, and the test acts in that window. */
  const holdSecretReads = () => {
    const gate = deferred<void>();
    let reads = 0;
    const read = secretStore.read.bind(secretStore);
    secretStore.read = async (scope, name) => {
      reads += 1;
      await gate.promise;
      return read(scope, name);
    };
    releaseHeldSecretReads = () => gate.resolve();
    return { release: () => gate.resolve(), reached: () => until(() => reads >= 1) };
  };
  const parentWaitingForTheSecretsOfItsChild = async () => {
    await boot({ maxConcurrentRuns: 2 });
    const child = await approvedPlaybook([secretHolderCell]);
    new SecretRefRepository(fixture!.db).declare({ kind: 'playbook', id: child.id }, SECRET_NAME);
    await secretStore.set({ kind: 'playbook', id: child.id }, SECRET_NAME, `dummy-canary-built-at-runtime-${randomUUID()}`);
    const parent = await approvedPlaybook([{ id: 'sub', kind: 'subPlaybook', playbookId: child.id }]);
    const held = holdSecretReads();
    const parentRunId = await startedRunId(parent.id);
    await held.reached();
    return { child, held, parentRunId };
  };

  it('answers at once, without waiting for the read, and journals no child once the read returns', async () => {
    const { held, parentRunId } = await parentWaitingForTheSecretsOfItsChild();

    const cancelling = tool(lead, 'cancel_playbook_run', { run_id: parentRunId });

    expect(await settlesBeforeTheGuard(cancelling)).toBe(true);
    held.release();
    await sleepMs(50);
    expect(runCount()).toBe(1);
    expect(runRow(parentRunId)).toMatchObject(CANCELLED);
    expect(stepRows(parentRunId)).toEqual([{ step_id: 'sub', status: 'failed', error_code: 'run_cancelled' }]);
    expect(runsStillRunning()).toBe(0);
  });

  it('ends the parent step with the verdict of the cancellation, not with the error that the preparation of the child met', async () => {
    const { child, held, parentRunId } = await parentWaitingForTheSecretsOfItsChild();
    const editedWhileTheSecretsAreRead = await fixture!.api(`/api/playbooks/${child.id}`, { method: 'PUT', body: JSON.stringify({ expectedRev: child.contentRev, policy: { allowedHosts: ['example.test'] } }) });
    expect(editedWhileTheSecretsAreRead.status).toBe(200);

    const cancelling = tool(lead, 'cancel_playbook_run', { run_id: parentRunId });

    expect(await settlesBeforeTheGuard(cancelling)).toBe(true);
    held.release();
    await sleepMs(50);
    expect(runRow(parentRunId)).toMatchObject(CANCELLED);
    expect(stepRows(parentRunId)).toEqual([{ step_id: 'sub', status: 'failed', error_code: 'run_cancelled' }]);
    expect(runCount()).toBe(1);
  });
});

describe('the answer of a cancellation does not depend on the retention of runs', () => {
  it('answers the cancelled run even when the retention of the playbook purged it as soon as it ended', async () => {
    await boot();
    writeScript('gate.sh', `touch ${join(markers, 'started')}; while [ ! -e ${join(markers, 'go')} ]; do sleep 0.05; done`);
    const playbook = await approvedPlaybook([{ id: 'gate', kind: 'script', program: 'gate.sh', args: [], env: {} }], OWN_PROJECT_ID, { policy: { maxRunsToKeep: 1 } });
    writeFileSync(join(markers, 'go'), '');
    now = START_OF_TEST_TIME + 3_600_000;
    const newerRunId = await startedRunId(playbook.id);
    await until(() => runRow(newerRunId).status === 'succeeded');
    rmSync(join(markers, 'go'));
    rmSync(join(markers, 'started'));
    now = START_OF_TEST_TIME;
    const olderRunId = await startedRunId(playbook.id);
    await until(() => existsSync(join(markers, 'started')));

    const cancelled = await tool(lead, 'cancel_playbook_run', { run_id: olderRunId });

    expect(cancelled.isError, cancelled.text).toBe(false);
    expect(cancelled.json!.run).toMatchObject({ id: olderRunId, status: 'failed', error_code: 'run_cancelled' });
    expect(fixture!.db.prepare('SELECT 1 FROM playbook_runs WHERE id = ?').get(olderRunId)).toBeUndefined();
  });
});

describe('what a cancellation does when two things happen at once', () => {
  it('answers both of two cancels sent during the same stop with the same ended run', async () => {
    await boot();
    const sleeping = await approvedPlaybook([waitForCell()]);
    const runId = await startedRunId(sleeping.id);
    await until(() => timers.armedCount() === 1);
    const { playbookRunner } = fixture!.daemon;

    const [first, second] = await Promise.all([playbookRunner.cancelRun(runId), playbookRunner.cancelRun(runId)]);

    expect(first).toMatchObject({ id: runId, status: 'failed', errorCode: 'run_cancelled' });
    expect(second).toEqual(first);
    expect(runsStillRunning()).toBe(0);
  });

  it('lets the end of the wait win over a cancellation when the deadline of the question is already reached', async () => {
    await boot();
    const asking = await approvedPlaybook([{ id: 'ask', kind: 'manual', prompt: 'Ship it?', timeoutSeconds: 60 }]);
    const runId = await startedRunId(asking.id);
    await until(() => runRow(runId).status === 'waiting_manual');
    now += 61_000;

    const cancelled = await tool(lead, 'cancel_playbook_run', { run_id: runId });

    expect(cancelled.isError).toBe(true);
    expect(cancelled.text).toContain('playbook_conflict');
    expect(runRow(runId)).toMatchObject({ status: 'failed', error_code: 'manual_wait_expired' });
    expect(fixture!.db.prepare('SELECT status FROM playbook_manual_requests WHERE run_id = ?').get(runId)).toEqual({ status: 'expired' });
  });
});

describe('the end of a wait for a human, and the cancellation of a run that waits', () => {
  it('settles a wait whose deadline falls between two reads of the clock: the run ends instead of staying waiting_manual', async () => {
    await boot();
    const asking = await approvedPlaybook([{ id: 'ask', kind: 'manual', prompt: 'Ship it?', timeoutSeconds: 60 }]);
    const runId = await startedRunId(asking.id);
    await until(() => runRow(runId).status === 'waiting_manual');
    const justBeforeTheDeadline = START_OF_TEST_TIME + 59_999;
    const atTheDeadline = START_OF_TEST_TIME + 60_000;
    scriptedClockReads = [justBeforeTheDeadline, atTheDeadline];

    await tool(lead, 'cancel_playbook_run', { run_id: runId });

    expect(runRow(runId).status).toBe('failed');
    expect(runRow(runId).ended_at).not.toBeNull();
  });

  it('leaves the overdue waits of other projects alone when it cancels a wait', async () => {
    await boot();
    const shortWait = await approvedPlaybook([{ id: 'ask', kind: 'manual', prompt: 'Ship it?', timeoutSeconds: 60 }], OTHER_PROJECT_ID);
    const foreignRun = await fixture!.daemon.playbookRunner.start({ playbookId: shortWait.id, projectId: OTHER_PROJECT_ID, inputs: {}, actorKind: 'admin', launchedBy: { kind: 'admin_api', ref: null } });
    await until(() => runRow(foreignRun.id).status === 'waiting_manual');
    const longWait = await approvedPlaybook([{ id: 'ask', kind: 'manual', prompt: 'Ship it?', timeoutSeconds: 3600 }]);
    const ownRunId = await startedRunId(longWait.id);
    await until(() => runRow(ownRunId).status === 'waiting_manual');
    now += 61_000;

    const cancelled = await tool(lead, 'cancel_playbook_run', { run_id: ownRunId });

    expect(cancelled.isError, cancelled.text).toBe(false);
    expect(runRow(ownRunId)).toMatchObject(CANCELLED);
    expect(runRow(foreignRun.id).status).toBe('waiting_manual');
    expect(fixture!.db.prepare('SELECT status FROM playbook_manual_requests WHERE run_id = ?').get(foreignRun.id)).toEqual({ status: 'pending' });
  });
});

describe('a run resumed while the tree that parked it is still cleaning up', () => {
  it('stays cancellable: the cleanup of the old tree does not remove the tree of the resumed run', async () => {
    await boot();
    const playbook = await approvedPlaybook([{ id: 'ask', kind: 'manual', prompt: 'Ship it?' }, waitForCell('sleep')]);
    const runner = fixture!.daemon.playbookRunner as unknown as { deps: { manual: { park: (input: { runId: string; seq: number }) => void } }; commitAnswer: (input: { runId: string; seq: number; decision: 'approved'; secretValues: Map<string, string> }) => unknown; cancelRun: (runId: string) => Promise<unknown> };
    const realPark = runner.deps.manual.park.bind(runner.deps.manual);
    runner.deps.manual.park = (input) => {
      realPark(input);
      runner.commitAnswer({ runId: input.runId, seq: input.seq, decision: 'approved', secretValues: new Map() });
    };
    const runId = await startedRunId(playbook.id);
    await until(() => timers.armedCount() === 1);

    await runner.cancelRun(runId);

    expect(runRow(runId)).toMatchObject(CANCELLED);
    expect(runsStillRunning()).toBe(0);
  });
});

describe('the cancellation reaches every kind of step and every attempt', () => {
  it('stops an http request whose name is still being resolved and ends its step with run_cancelled', async () => {
    const lookups: string[] = [];
    const stalledNetwork = { resolveAddresses: (hostname: string) => { lookups.push(hostname); return new Promise<never>(() => {}); }, isForbiddenAddress: () => false } as unknown as HttpStepNetwork;
    await boot({ httpNetwork: stalledNetwork });
    const calling = await approvedPlaybook([{ id: 'call', kind: 'http', method: 'GET', url: 'http://slow-dns.test:9/' }], OWN_PROJECT_ID, { policy: { allowedHosts: ['slow-dns.test'] } });
    const runId = await startedRunId(calling.id);
    await until(() => lookups.length === 1);

    const cancelled = await tool(lead, 'cancel_playbook_run', { run_id: runId });

    expect(cancelled.isError, cancelled.text).toBe(false);
    expect(runRow(runId)).toMatchObject(CANCELLED);
    expect(stepRows(runId)).toEqual([{ step_id: 'call', status: 'failed', error_code: 'run_cancelled' }]);
  });

  it('stops a forEach in its first iteration: the run ends with run_cancelled, not with for_each_iteration_failed, and no other element starts', async () => {
    await boot();
    writeScript('noop.sh', 'true');
    writeScript('hold.sh', `touch ${join(markers, 'started')}; while [ ! -e ${join(markers, 'go')} ]; do sleep 0.05; done`);
    const iterating = await approvedPlaybook([
      { id: 'seed', kind: 'script', program: 'noop.sh', args: [], env: {}, next: [{ to: 'each', forEach: 'inputs.names' }] },
      { id: 'each', kind: 'script', program: 'hold.sh', args: [], env: {} },
    ], OWN_PROJECT_ID, { inputs: [{ name: 'names', type: 'json', required: true }] });
    const runId = await startedRunId(iterating.id, { names: ['a', 'b', 'c'] });
    await until(() => existsSync(join(markers, 'started')));

    const cancelled = await tool(lead, 'cancel_playbook_run', { run_id: runId });

    expect(cancelled.isError, cancelled.text).toBe(false);
    expect(runRow(runId)).toMatchObject(CANCELLED);
    expect(stepRows(runId)).toEqual([{ step_id: 'seed', status: 'succeeded', error_code: null }, { step_id: 'each', status: 'failed', error_code: 'run_cancelled' }]);
  });

  it('starts no further attempt of a retrying cell once its attempt in flight was cancelled', async () => {
    await boot();
    writeScript('hold.sh', `touch ${join(markers, 'started')}; while [ ! -e ${join(markers, 'go')} ]; do sleep 0.05; done`);
    const retrying = await approvedPlaybook([{ id: 'hold', kind: 'script', program: 'hold.sh', args: [], env: {}, retry: { maxAttempts: 3, backoffMs: 0, until: [{ lhs: 'steps.hold.exitCode', op: 'eq', rhs: 0 }] } }]);
    const runId = await startedRunId(retrying.id);
    await until(() => existsSync(join(markers, 'started')));

    const cancelled = await tool(lead, 'cancel_playbook_run', { run_id: runId });

    expect(cancelled.isError, cancelled.text).toBe(false);
    expect(runRow(runId)).toMatchObject(CANCELLED);
    expect(stepRows(runId)).toEqual([{ step_id: 'hold', status: 'failed', error_code: 'run_cancelled' }]);
  });
});
