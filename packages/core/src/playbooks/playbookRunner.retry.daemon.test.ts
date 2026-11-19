import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { OWN_PROJECT_ID, startGovernanceFixture, type GovernanceFixture } from '../governance/governanceQueue.testkit.js';
import { createManualTimers, type ManualTimers } from '../integrations/manualTimers.testkit.js';
import { createTempDirTracker } from '../tempDirTracker.js';

/*
 * Guards of the retry field of a cell, each with the test that fails when the guard is removed (replay: break the line, run this file, restore).
 *  1. retry loop            `runStepWithRetry`            -> 'runs the cell again after a failed attempt ...'
 *  2. until                 `isDoneAfter`                 -> 'keeps trying while until is false ...'
 *  3. attempt cap           `maxAttempts`                 -> 'fails with retry_exhausted ...', 'fails with the code of the last attempt ...'
 *  4. backoff on the timer  `this.sleep(backoffMs)`       -> 'runs the cell again after a failed attempt ...' (delays armed), 'does not arm a timer ...'
 *  5. effects never replayed `refusesRetry`               -> 'refuses a retry on a cell with an effect ...'
 *  6. crash never replays   `recover`                     -> 'never replays an attempt after a crash ...'
 *  7. step cap              `maxStepExecutions`           -> 'counts every attempt among the step executions of the run'
 */
type RunView = { id: string; status: string; errorCode: string | null; steps: { seq: number; stepId: string; status: string; errorCode: string | null; output: { output?: string } | null }[] };

const directories = createTempDirTracker();
let fixture: GovernanceFixture | undefined;
let scriptRoot = '';
let markers = '';
let timers: ManualTimers;
afterEach(async () => { await fixture?.close(); fixture = undefined; directories.removeAll(); });

const boot = async (playbooks: { maxStepExecutions?: number } = {}) => {
  scriptRoot = directories.make('playbook-scripts-');
  markers = directories.make('playbook-markers-');
  timers = createManualTimers();
  fixture = await startGovernanceFixture({ playbooks: { scriptRoots: [scriptRoot], startTimer: timers.startTimer, ...playbooks } });
  return fixture;
};

const writeScript = (name: string, body: string) => {
  const path = join(scriptRoot, name);
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o700);
};
/** A script that counts its own runs in a file, prints the count, and exits 1 until the count reaches `succeedsAt`. */
const writeCountingScript = (name: string, { succeedsAt }: { succeedsAt: number }) =>
  writeScript(name, `printf x >> ${join(markers, 'count')}\nn=$(wc -c < ${join(markers, 'count')})\nprintf '%s' "$((n))"\n[ "$((n))" -ge ${succeedsAt} ]`);
const attemptsMade = () => readFileSync(join(markers, 'count'), 'utf8').length;

const jsonOf = async <T>(response: Response) => await response.json() as T;
const sleepMs = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const waitUntil = async (what: string, isDone: () => boolean, timeoutMs = 15_000) => {
  const deadline = Date.now() + timeoutMs;
  while (!isDone()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleepMs(10);
  }
};
const createApprovedPlaybook = async (f: GovernanceFixture, cells: Record<string, unknown>[]) => {
  const playbook = await jsonOf<{ id: string }>(await f.api('/api/playbooks', { method: 'POST', body: JSON.stringify({ projectId: OWN_PROJECT_ID, name: 'P', cells }) }));
  const { digest } = await jsonOf<{ digest: string }>(await f.api(`/api/playbooks/${playbook.id}/approval`));
  expect((await f.api(`/api/playbooks/${playbook.id}/approve`, { method: 'POST', body: JSON.stringify({ digest }) })).status).toBe(200);
  return playbook;
};
const startRun = (f: GovernanceFixture, playbookId: string) => f.api(`/api/playbooks/${playbookId}/run`, { method: 'POST', body: JSON.stringify({ inputs: {} }) });
const viewOfRun = async (f: GovernanceFixture, runId: string) => jsonOf<RunView>(await f.api(`/api/playbook-runs/${runId}`));
const statusOfRun = (f: GovernanceFixture, runId: string) => (f.db.prepare('SELECT status FROM playbook_runs WHERE id = ?').get(runId) as { status: string }).status;
const startedRunId = async (f: GovernanceFixture, playbookId: string) => {
  const started = await startRun(f, playbookId);
  expect(started.status).toBe(202);
  return (await jsonOf<RunView>(started)).id;
};
/** Fires the backoff timer the run is sleeping on, once it is armed. */
const elapseBackoffNumber = async (position: number) => {
  await waitUntil(`the backoff timer ${position}`, () => timers.armedCount() === position);
  timers.elapseAll();
};
const endedRun = async (f: GovernanceFixture, runId: string) => {
  await waitUntil('the run to end', () => statusOfRun(f, runId) !== 'running');
  return viewOfRun(f, runId);
};
const retryOf = (extra: { maxAttempts: number; backoffMs?: number; until?: Record<string, unknown>[] }) => ({ maxAttempts: extra.maxAttempts, backoffMs: extra.backoffMs ?? 0, until: extra.until ?? [] });
const countingCell = (retry: Record<string, unknown>) => ({ id: 'poll', kind: 'script', program: 'count.sh', retry });

describe('a cell that retries', () => {
  it('runs the cell again after a failed attempt, waiting its backoff on the injected timer', async () => {
    const f = await boot();
    writeCountingScript('count.sh', { succeedsAt: 3 });
    const playbook = await createApprovedPlaybook(f, [countingCell(retryOf({ maxAttempts: 5, backoffMs: 2000 }))]);

    const runId = await startRun(f, playbook.id).then(async (response) => (await jsonOf<RunView>(response)).id);
    await elapseBackoffNumber(1);
    await elapseBackoffNumber(2);
    const run = await endedRun(f, runId);

    expect(run.status).toBe('succeeded');
    expect(run.steps.map((step) => [step.seq, step.stepId, step.status])).toEqual([[1, 'poll', 'failed'], [2, 'poll', 'failed'], [3, 'poll', 'succeeded']]);
    expect(timers.delaysArmed()).toEqual([2000, 2000]);
    expect(attemptsMade()).toBe(3);
  });

  it('does not arm a timer when the backoff is zero', async () => {
    const f = await boot();
    writeCountingScript('count.sh', { succeedsAt: 2 });
    const playbook = await createApprovedPlaybook(f, [countingCell(retryOf({ maxAttempts: 3, backoffMs: 0 }))]);

    const run = await endedRun(f, await startedRunId(f, playbook.id));

    expect(run.status).toBe('succeeded');
    expect(timers.armedCount()).toBe(0);
  });

  it('keeps trying while until is false on a succeeded attempt', async () => {
    const f = await boot();
    writeCountingScript('count.sh', { succeedsAt: 1 });
    const untilThirdAttempt = [{ lhs: 'steps.poll.output', op: 'eq', rhs: '3' }];
    const playbook = await createApprovedPlaybook(f, [countingCell(retryOf({ maxAttempts: 5, until: untilThirdAttempt }))]);

    const run = await endedRun(f, await startedRunId(f, playbook.id));

    expect(run.status).toBe('succeeded');
    expect(run.steps.map((step) => step.status)).toEqual(['succeeded', 'succeeded', 'succeeded']);
    expect(attemptsMade()).toBe(3);
  });

  it('does not retry a succeeded attempt when until holds at once', async () => {
    const f = await boot();
    writeCountingScript('count.sh', { succeedsAt: 1 });
    const playbook = await createApprovedPlaybook(f, [countingCell(retryOf({ maxAttempts: 5, until: [{ lhs: 'steps.poll.exitCode', op: 'eq', rhs: 0 }] }))]);

    const run = await endedRun(f, await startedRunId(f, playbook.id));

    expect(run.status).toBe('succeeded');
    expect(attemptsMade()).toBe(1);
  });

  it('fails with retry_exhausted when the attempts end with until still false', async () => {
    const f = await boot();
    writeCountingScript('count.sh', { succeedsAt: 1 });
    const neverTrue = [{ lhs: 'steps.poll.output', op: 'eq', rhs: 'never' }];
    const playbook = await createApprovedPlaybook(f, [countingCell(retryOf({ maxAttempts: 3, until: neverTrue }))]);

    const run = await endedRun(f, await startedRunId(f, playbook.id));

    expect(run).toMatchObject({ status: 'failed', errorCode: 'retry_exhausted' });
    expect(run.steps).toHaveLength(3);
    expect(run.steps.at(-1)).toMatchObject({ status: 'failed', errorCode: 'retry_exhausted' });
    expect(attemptsMade()).toBe(3);
  });

  it('fails with the code of the last attempt when every attempt fails', async () => {
    const f = await boot();
    writeCountingScript('count.sh', { succeedsAt: 99 });
    const playbook = await createApprovedPlaybook(f, [countingCell(retryOf({ maxAttempts: 2 }))]);

    const run = await endedRun(f, await startedRunId(f, playbook.id));

    expect(run).toMatchObject({ status: 'failed', errorCode: 'script_failed' });
    expect(run.steps.map((step) => step.status)).toEqual(['failed', 'failed']);
    expect(attemptsMade()).toBe(2);
  });

  it('counts every attempt among the step executions of the run', async () => {
    const f = await boot({ maxStepExecutions: 3 });
    writeCountingScript('count.sh', { succeedsAt: 99 });
    const playbook = await createApprovedPlaybook(f, [countingCell(retryOf({ maxAttempts: 20 }))]);

    const run = await endedRun(f, await startedRunId(f, playbook.id));

    expect(run).toMatchObject({ status: 'failed', errorCode: 'step_limit_exceeded' });
    expect(run.steps).toHaveLength(3);
    expect(attemptsMade()).toBe(3);
  });
});

describe('a retry never repeats an effect it cannot take back', () => {
  const retry = retryOf({ maxAttempts: 3 });
  const runnableAsWritten = (method: string) => ({ id: 'call', kind: 'http', method, url: 'https://example.com/x', retry });

  it.each([
    ['a writeToStore cell', { id: 'put', kind: 'writeToStore', storeID: 'table', rowMappings: { col: 'x' }, retry }],
    ['an http POST', runnableAsWritten('POST')],
    ['an http PUT', runnableAsWritten('PUT')],
    ['an http PATCH', runnableAsWritten('PATCH')],
    ['an http DELETE', runnableAsWritten('DELETE')],
    ['a manual cell', { id: 'ask', kind: 'manual', prompt: 'go?', retry }],
    ['a subPlaybook cell', { id: 'child', kind: 'subPlaybook', playbookId: 'another', retry }],
  ])('refuses a retry on a cell with an effect: %s', async (_name, cell) => {
    const f = await boot();
    const playbook = await createApprovedPlaybook(f, [cell]);

    const refused = await startRun(f, playbook.id);

    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ error: 'playbook_not_runnable' });
    expect((f.db.prepare('SELECT COUNT(*) AS n FROM playbook_runs').get() as { n: number }).n).toBe(0);
  });

  it.each([['GET'], ['HEAD']])('accepts a retry on an http %s', async (method) => {
    const f = await boot();
    const playbook = await createApprovedPlaybook(f, [{ ...runnableAsWritten(method), retry: retryOf({ maxAttempts: 1 }) }]);

    const started = await startRun(f, playbook.id);

    expect(started.status).toBe(202);
  });
});

describe('a daemon that stops or crashes between two attempts', () => {
  it('ends the run as needs_review when it stops during the backoff, and never starts the next attempt', async () => {
    const f = await boot();
    writeCountingScript('count.sh', { succeedsAt: 99 });
    const playbook = await createApprovedPlaybook(f, [countingCell(retryOf({ maxAttempts: 5, backoffMs: 60_000 }))]);
    const runId = await startedRunId(f, playbook.id);
    await waitUntil('the backoff to be armed', () => timers.armedCount() === 1);

    await f.daemon.playbookRunner.stop();
    timers.elapseAll();
    const run = await endedRun(f, runId);

    expect(run).toMatchObject({ status: 'needs_review', errorCode: 'interrupted' });
    expect(attemptsMade()).toBe(1);
  });

  it('never replays an attempt after a crash: a run found running at boot is needs_review', async () => {
    const f = await boot();
    writeCountingScript('count.sh', { succeedsAt: 99 });
    const playbook = await createApprovedPlaybook(f, [countingCell(retryOf({ maxAttempts: 5, backoffMs: 60_000 }))]);
    const runId = await startedRunId(f, playbook.id);
    await waitUntil('the backoff to be armed', () => timers.armedCount() === 1);

    f.daemon.playbookRunner.recover();
    const run = await viewOfRun(f, runId);

    expect(run).toMatchObject({ status: 'needs_review', errorCode: 'interrupted' });
    expect(run.steps.every((step) => step.status !== 'running')).toBe(true);
    expect(attemptsMade()).toBe(1);
  });
});
