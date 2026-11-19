import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { OWN_PROJECT_ID, startGovernanceFixture, type GovernanceFixture } from '../governance/governanceQueue.testkit.js';
import { createTempDirTracker } from '../tempDirTracker.js';

/*
 * Guards of the forEach edge, each with the test that fails when the guard is removed (replay: break the line, run this file, restore).
 *  1. one run of the target per element  `executeForEach`            -> 'runs the target once per element ...'
 *  2. item and index                     `iteration` in the scope    -> 'runs the target once per element ...', 'writes an object element as JSON'
 *  3. 100 elements per edge              `MAX_FOR_EACH_ITEMS`        -> 'accepts 100 elements and refuses 101'
 *  4. iterations per run                 `maxForEachIterations`      -> 'refuses an edge that would pass the iterations of the run'
 *  5. an iteration that fails stops all  `for_each_iteration_failed` -> 'stops at the first failed iteration ...'
 *  6. the source is a list               `itemsOf`                   -> 'refuses a source that is not a list', 'iterates a list that a step printed as JSON'
 *  7. no manual target                   `assertCellsCanRun`         -> 'refuses a forEach edge into a manual cell'
 *  8. stop and crash never replay        `executeForEach`            -> 'never starts the next iteration after the daemon stopped'
 *  9. step cap                           `maxStepExecutions`         -> 'counts every iteration among the step executions of the run'
 */
type RunView = { id: string; status: string; errorCode: string | null; steps: { seq: number; stepId: string; status: string; errorCode: string | null; output: { output?: string } | null }[] };

const directories = createTempDirTracker();
let fixture: GovernanceFixture | undefined;
let scriptRoot = '';
let markers = '';
afterEach(async () => { await fixture?.close(); fixture = undefined; directories.removeAll(); });

const boot = async (playbooks: { maxStepExecutions?: number; maxForEachIterations?: number } = {}) => {
  scriptRoot = directories.make('playbook-scripts-');
  markers = directories.make('playbook-markers-');
  fixture = await startGovernanceFixture({ playbooks: { scriptRoots: [scriptRoot], ...playbooks } });
  writeScript('noop.sh', 'true');
  writeScript('say.sh', 'printf "%s" "$1"');
  return fixture;
};

const writeScript = (name: string, body: string) => {
  const path = join(scriptRoot, name);
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o700);
};
const jsonOf = async <T>(response: Response) => await response.json() as T;
const sleepMs = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const waitUntil = async (what: string, isDone: () => boolean, timeoutMs = 15_000) => {
  const deadline = Date.now() + timeoutMs;
  while (!isDone()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleepMs(10);
  }
};
const ITEMS_INPUT = [{ name: 'items', type: 'json' }];
const createApprovedPlaybook = async (f: GovernanceFixture, cells: Record<string, unknown>[], inputs: Record<string, unknown>[] = ITEMS_INPUT) => {
  const playbook = await jsonOf<{ id: string }>(await f.api('/api/playbooks', { method: 'POST', body: JSON.stringify({ projectId: OWN_PROJECT_ID, name: 'P', cells, inputs }) }));
  const { digest } = await jsonOf<{ digest: string }>(await f.api(`/api/playbooks/${playbook.id}/approval`));
  expect((await f.api(`/api/playbooks/${playbook.id}/approve`, { method: 'POST', body: JSON.stringify({ digest }) })).status).toBe(200);
  return playbook;
};
const startRun = (f: GovernanceFixture, playbookId: string, inputs: Record<string, unknown>) => f.api(`/api/playbooks/${playbookId}/run`, { method: 'POST', body: JSON.stringify({ inputs }) });
const viewOfRun = async (f: GovernanceFixture, runId: string) => jsonOf<RunView>(await f.api(`/api/playbook-runs/${runId}`));
const statusOfRun = (f: GovernanceFixture, runId: string) => (f.db.prepare('SELECT status FROM playbook_runs WHERE id = ?').get(runId) as { status: string }).status;
const runToTheEnd = async (f: GovernanceFixture, playbookId: string, inputs: Record<string, unknown>) => {
  const started = await startRun(f, playbookId, inputs);
  expect(started.status).toBe(202);
  const { id } = await jsonOf<RunView>(started);
  await waitUntil('the run to end', () => statusOfRun(f, id) !== 'running');
  return viewOfRun(f, id);
};
const stepIdsOf = (run: RunView) => run.steps.map((step) => step.stepId);
const outputsOf = (run: RunView, stepId: string) => run.steps.filter((step) => step.stepId === stepId).map((step) => step.output?.output);

const entry = (iterate: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({ id: 'start', kind: 'script', program: 'noop.sh', next: [{ to: 'each', ...iterate }], ...extra });
const sayItem = (extra: Record<string, unknown> = {}) => ({ id: 'each', kind: 'script', program: 'say.sh', args: ['{{index}}:{{item}}'], ...extra });
const quickWait = (extra: Record<string, unknown> = {}) => ({ id: 'each', kind: 'waitFor', predicate: [{ lhs: 'wait.elapsedMs', op: 'gte', rhs: 0 }], ...extra });

describe('a forEach edge', () => {
  it('runs the target once per element, with the element as item and its position as index', async () => {
    const f = await boot();
    const playbook = await createApprovedPlaybook(f, [entry({ forEach: 'inputs.items' }), sayItem()]);

    const run = await runToTheEnd(f, playbook.id, { items: ['a', 'b', 'c'] });

    expect(run.status).toBe('succeeded');
    expect(stepIdsOf(run)).toEqual(['start', 'each', 'each', 'each']);
    expect(outputsOf(run, 'each')).toEqual(['0:a', '1:b', '2:c']);
  });

  it('writes an object element as JSON', async () => {
    const f = await boot();
    const playbook = await createApprovedPlaybook(f, [entry({ forEach: 'inputs.items' }), sayItem()]);

    const run = await runToTheEnd(f, playbook.id, { items: [{ n: 1 }] });

    expect(outputsOf(run, 'each')).toEqual(['0:{"n":1}']);
  });

  it('goes on with the cell after the target once every element is done', async () => {
    const f = await boot();
    const playbook = await createApprovedPlaybook(f, [entry({ forEach: 'inputs.items' }), sayItem({ next: [{ to: 'after' }] }), { id: 'after', kind: 'script', program: 'noop.sh' }]);

    const run = await runToTheEnd(f, playbook.id, { items: ['a', 'b'] });

    expect(run.status).toBe('succeeded');
    expect(stepIdsOf(run)).toEqual(['start', 'each', 'each', 'after']);
  });

  it('runs the target no time for an empty list and goes on', async () => {
    const f = await boot();
    const playbook = await createApprovedPlaybook(f, [entry({ forEach: 'inputs.items' }), sayItem({ next: [{ to: 'after' }] }), { id: 'after', kind: 'script', program: 'noop.sh' }]);

    const run = await runToTheEnd(f, playbook.id, { items: [] });

    expect(run.status).toBe('succeeded');
    expect(stepIdsOf(run)).toEqual(['start', 'after']);
  });

  it('stops at the first failed iteration: the run fails and the next elements never start', async () => {
    const f = await boot();
    writeScript('flaky.sh', `printf x >> ${join(markers, 'ran')}\n[ "$1" != "1" ]`);
    const playbook = await createApprovedPlaybook(f, [entry({ forEach: 'inputs.items' }), { id: 'each', kind: 'script', program: 'flaky.sh', args: ['{{index}}'] }]);

    const run = await runToTheEnd(f, playbook.id, { items: ['a', 'b', 'c', 'd'] });

    expect(run).toMatchObject({ status: 'failed', errorCode: 'for_each_iteration_failed' });
    expect(run.steps.map((step) => [step.stepId, step.status, step.errorCode])).toEqual([['start', 'succeeded', null], ['each', 'succeeded', null], ['each', 'failed', 'script_failed']]);
    expect(readFileSync(join(markers, 'ran'), 'utf8')).toBe('xx');
  });

  it('accepts 100 elements and refuses 101 before running any of them', async () => {
    const f = await boot();
    const playbook = await createApprovedPlaybook(f, [entry({ forEach: 'inputs.items' }), quickWait()]);

    const hundred = await runToTheEnd(f, playbook.id, { items: Array.from({ length: 100 }, (_, position) => position) });
    const hundredAndOne = await runToTheEnd(f, playbook.id, { items: Array.from({ length: 101 }, (_, position) => position) });

    expect(hundred.status).toBe('succeeded');
    expect(hundred.steps).toHaveLength(101);
    expect(hundredAndOne).toMatchObject({ status: 'failed', errorCode: 'for_each_limit_exceeded' });
    expect(stepIdsOf(hundredAndOne)).toEqual(['start']);
  });

  it('refuses an edge that would pass the iterations of the run, before running any of its elements', async () => {
    const f = await boot({ maxForEachIterations: 5 });
    const playbook = await createApprovedPlaybook(f, [
      entry({ forEach: 'inputs.items' }),
      quickWait({ next: [{ to: 'again', forEach: 'inputs.items' }] }),
      { id: 'again', kind: 'waitFor', predicate: [{ lhs: 'wait.elapsedMs', op: 'gte', rhs: 0 }] },
    ]);

    const run = await runToTheEnd(f, playbook.id, { items: [1, 2, 3] });

    expect(run).toMatchObject({ status: 'failed', errorCode: 'for_each_limit_exceeded' });
    expect(stepIdsOf(run)).toEqual(['start', 'each', 'each', 'each']);
  });

  it('counts every iteration among the step executions of the run', async () => {
    const f = await boot({ maxStepExecutions: 3 });
    const playbook = await createApprovedPlaybook(f, [entry({ forEach: 'inputs.items' }), quickWait()]);

    const run = await runToTheEnd(f, playbook.id, { items: [1, 2, 3, 4, 5] });

    expect(run).toMatchObject({ status: 'failed', errorCode: 'step_limit_exceeded' });
    expect(run.steps).toHaveLength(3);
  });
});

describe('the source of a forEach edge', () => {
  it.each([['a string', 'text'], ['a number', 3], ['an object', { a: 1 }]])('refuses a source that is not a list: %s', async (_name, value) => {
    const f = await boot();
    const playbook = await createApprovedPlaybook(f, [entry({ forEach: 'inputs.items' }), sayItem()]);

    const run = await runToTheEnd(f, playbook.id, { items: value });

    expect(run).toMatchObject({ status: 'failed', errorCode: 'for_each_source_invalid' });
    expect(stepIdsOf(run)).toEqual(['start']);
  });

  it('iterates a list that a step printed as JSON', async () => {
    const f = await boot();
    writeScript('list.sh', `printf '["x","y"]'`);
    writeScript('log.sh', `printf '%s' "$1" >> ${join(markers, 'seen')}`);
    const playbook = await createApprovedPlaybook(f, [
      { id: 'gen', kind: 'script', program: 'list.sh', next: [{ to: 'each', forEach: 'steps.gen.output' }] },
      { id: 'each', kind: 'script', program: 'log.sh', args: ['{{index}}'] },
    ], []);

    const run = await runToTheEnd(f, playbook.id, {});

    expect(run.status).toBe('succeeded');
    expect(readFileSync(join(markers, 'seen'), 'utf8')).toBe('01');
  });

  it('refuses at the save the item of a step output in the arguments of a script', async () => {
    const f = await boot();

    const saved = await f.api('/api/playbooks', { method: 'POST', body: JSON.stringify({ projectId: OWN_PROJECT_ID, name: 'P', cells: [
      { id: 'gen', kind: 'script', program: 'noop.sh', next: [{ to: 'each', forEach: 'steps.gen.output' }] },
      { id: 'each', kind: 'script', program: 'say.sh', args: ['{{item}}'] },
    ] }) });

    expect(saved.status).toBeGreaterThanOrEqual(400);
    expect(await saved.json()).toMatchObject({ error: 'untrusted_reference' });
  });

  it('refuses a forEach edge into a manual cell, and writes no run', async () => {
    const f = await boot();
    const playbook = await createApprovedPlaybook(f, [entry({ forEach: 'inputs.items' }), { id: 'each', kind: 'manual', prompt: 'ok?' }]);

    const refused = await startRun(f, playbook.id, { items: [1] });

    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ error: 'playbook_not_runnable' });
    expect((f.db.prepare('SELECT COUNT(*) AS n FROM playbook_runs').get() as { n: number }).n).toBe(0);
  });
});

describe('a daemon that stops during an iteration', () => {
  it('never starts the next iteration after the daemon stopped', async () => {
    const f = await boot();
    writeScript('hang.sh', `printf x >> ${join(markers, 'ran')}\nsleep 30`);
    const playbook = await createApprovedPlaybook(f, [entry({ forEach: 'inputs.items' }), { id: 'each', kind: 'script', program: 'hang.sh' }]);
    const { id } = await jsonOf<RunView>(await startRun(f, playbook.id, { items: [1, 2, 3] }));
    await waitUntil('the first iteration to start', () => existsSync(join(markers, 'ran')) && readFileSync(join(markers, 'ran'), 'utf8') === 'x');

    await f.daemon.playbookRunner.stop();
    const run = await viewOfRun(f, id);

    expect(run).toMatchObject({ status: 'needs_review', errorCode: 'interrupted' });
    expect(run.steps.map((step) => step.status)).toEqual(['succeeded', 'needs_review']);
    expect(readFileSync(join(markers, 'ran'), 'utf8')).toBe('x');
  }, 25_000);
});
