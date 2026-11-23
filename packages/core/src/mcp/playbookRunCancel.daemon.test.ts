import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { OTHER_PROJECT_ID, OWN_PROJECT_ID, startGovernanceFixture, type GovernanceFixture } from '../governance/governanceQueue.testkit.js';
import { createManualTimers, until, type ManualTimers } from '../integrations/manualTimers.testkit.js';
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

afterEach(async () => {
  if (markers !== '') writeFileSync(join(markers, 'go'), '');
  await fixture?.close();
  fixture = undefined;
  directories.removeAll();
});

const boot = async (limits: { maxConcurrentRuns?: number } = {}) => {
  now = START_OF_TEST_TIME;
  timers = createManualTimers();
  scriptRoot = directories.make('cancel-scripts-');
  markers = directories.make('cancel-markers-');
  fixture = await startGovernanceFixture({ playbooks: { scriptRoots: [scriptRoot], clock: () => new Date(now).toISOString(), startTimer: timers.startTimer, ...limits } });
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
const approvedPlaybook = async (cells: Record<string, unknown>[], projectId = OWN_PROJECT_ID) => {
  const f = fixture!;
  const playbook = await jsonOf<{ id: string }>(await f.api('/api/playbooks', { method: 'POST', body: JSON.stringify({ projectId, name: `P-${randomUUID()}`, cells }) }));
  const { digest } = await jsonOf<{ digest: string }>(await f.api(`/api/playbooks/${playbook.id}/approval`));
  expect((await f.api(`/api/playbooks/${playbook.id}/approve`, { method: 'POST', body: JSON.stringify({ digest }) })).status).toBe(200);
  return playbook;
};
const startedRunId = async (playbook: string) => {
  const started = await tool(lead, 'run_playbook', { playbook });
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
