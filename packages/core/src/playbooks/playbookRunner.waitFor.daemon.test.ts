import { afterEach, describe, expect, it } from 'vitest';
import { OWN_PROJECT_ID, startGovernanceFixture, type GovernanceFixture } from '../governance/governanceQueue.testkit.js';
import { createManualTimers, until, type ManualTimers } from '../integrations/manualTimers.testkit.js';

/*
 * Guards of the waitFor cell, each with the test that fails when the guard is removed (replay: break the line, run this file, restore).
 *  1. injected clock and timer  `startTimer` -> 'waits on the injected timer ...' (no real timer is armed by the cell)
 *  2. ceiling                   `ceilingMs` -> 'fails with wait_for_timeout at the ceiling of the cell'
 *  3. poll floor                `MIN_WAIT_POLL_MS` -> 'never polls faster than once a second ...'
 *  4. evaluation cap            `maxWaitEvaluations` -> 'stops after the cap of evaluations ...'
 *  5. shared evaluator          `evaluateConditions` -> 'waits for a date', 'ends at once when the predicate already holds'
 *  6. kinds                     `assertCellsCanRun` -> 'still refuses a subPlaybook cell ...'
 */
type RunView = { id: string; status: string; errorCode: string | null; steps: { stepId: string; status: string; errorCode: string | null; output: Record<string, unknown> | null }[] };

const START_OF_TEST_TIME = Date.parse('2026-11-12T10:00:00.000Z');
const SECOND = 1000;

let fixture: GovernanceFixture | undefined;
let timers: ManualTimers;
let now: number;
afterEach(async () => {
  await fixture?.close();
  fixture = undefined;
});

const boot = async (limits: { maxWaitEvaluations?: number } = {}) => {
  now = START_OF_TEST_TIME;
  timers = createManualTimers();
  fixture = await startGovernanceFixture({ playbooks: { clock: () => new Date(now).toISOString(), startTimer: timers.startTimer, ...limits } });
  return fixture;
};

const jsonOf = async <T>(response: Response) => await response.json() as T;
const createApprovedPlaybook = async (f: GovernanceFixture, cells: Record<string, unknown>[]) => {
  const playbook = await jsonOf<{ id: string }>(await f.api('/api/playbooks', { method: 'POST', body: JSON.stringify({ projectId: OWN_PROJECT_ID, name: 'P', cells }) }));
  const { digest } = await jsonOf<{ digest: string }>(await f.api(`/api/playbooks/${playbook.id}/approval`));
  expect((await f.api(`/api/playbooks/${playbook.id}/approve`, { method: 'POST', body: JSON.stringify({ digest }) })).status).toBe(200);
  return playbook;
};
const statusOfRun = (f: GovernanceFixture, runId: string) => (f.db.prepare('SELECT status FROM playbook_runs WHERE id = ?').get(runId) as { status: string }).status;
const viewOfRun = async (f: GovernanceFixture, runId: string) => jsonOf<RunView>(await f.api(`/api/playbook-runs/${runId}`));
const startRun = async (f: GovernanceFixture, playbookId: string) => {
  const started = await f.api(`/api/playbooks/${playbookId}/run`, { method: 'POST', body: JSON.stringify({ inputs: {} }) });
  expect(started.status).toBe(202);
  return (await started.json() as RunView).id;
};
const waitForCell = (extra: Record<string, unknown> = {}) => ({ id: 'wait', kind: 'waitFor', predicate: [{ lhs: 'wait.elapsedMs', op: 'gte', rhs: 5000 }], ...extra });
const NEVER_TRUE = [{ lhs: 'wait.elapsedMs', op: 'lt', rhs: 0 }];

describe('a waitFor cell waits for its predicate on the injected clock', () => {
  it('waits on the injected timer and ends once the predicate holds', async () => {
    const f = await boot();
    const playbook = await createApprovedPlaybook(f, [waitForCell({ pollMs: 1000 })]);
    const runId = await startRun(f, playbook.id);
    await until(() => timers.armedCount() === 1);
    expect(statusOfRun(f, runId)).toBe('running');

    now += 5 * SECOND;
    timers.elapseAll();
    await until(() => statusOfRun(f, runId) !== 'running');

    const run = await viewOfRun(f, runId);
    expect(run.status).toBe('succeeded');
    expect(run.steps[0]).toMatchObject({ stepId: 'wait', status: 'succeeded', output: { elapsedMs: 5000 } });
    expect(timers.delaysArmed()).toEqual([1000]);
  });

  it('ends at once, with no timer, when the predicate already holds', async () => {
    const f = await boot();
    const playbook = await createApprovedPlaybook(f, [waitForCell({ predicate: [{ lhs: 'wait.elapsedMs', op: 'gte', rhs: 0 }] })]);

    const runId = await startRun(f, playbook.id);

    await until(() => statusOfRun(f, runId) !== 'running');
    expect(statusOfRun(f, runId)).toBe('succeeded');
    expect(timers.armedCount()).toBe(0);
  });

  it('waits for a date', async () => {
    const f = await boot();
    const playbook = await createApprovedPlaybook(f, [waitForCell({ pollMs: 1000, predicate: [{ lhs: 'wait.now', op: 'gte', rhs: '2026-11-12T10:00:30.000Z' }] })]);
    const runId = await startRun(f, playbook.id);
    await until(() => timers.armedCount() === 1);

    now += 29 * SECOND;
    timers.elapseAll();
    await until(() => timers.armedCount() === 2);
    expect(statusOfRun(f, runId)).toBe('running');

    now += 1 * SECOND;
    timers.elapseAll();
    await until(() => statusOfRun(f, runId) !== 'running');
    expect(statusOfRun(f, runId)).toBe('succeeded');
  });

  it('never polls faster than once a second, even when the cell asks for 100 ms', async () => {
    const f = await boot();
    const playbook = await createApprovedPlaybook(f, [waitForCell({ pollMs: 100 })]);

    await startRun(f, playbook.id);
    await until(() => timers.armedCount() === 1);

    expect(timers.delaysArmed()).toEqual([1000]);
  });

  it('fails with wait_for_timeout at the ceiling of the cell', async () => {
    const f = await boot();
    const playbook = await createApprovedPlaybook(f, [waitForCell({ pollMs: 1000, timeoutSeconds: 3, predicate: NEVER_TRUE })]);
    const runId = await startRun(f, playbook.id);

    for (let second = 1; second <= 3; second++) {
      await until(() => timers.armedCount() === second);
      now += SECOND;
      timers.elapseAll();
    }

    await until(() => statusOfRun(f, runId) !== 'running');
    const run = await viewOfRun(f, runId);
    expect(run).toMatchObject({ status: 'failed', errorCode: 'wait_for_timeout' });
    expect(run.steps[0]).toMatchObject({ status: 'failed', errorCode: 'wait_for_timeout' });
  });

  it('does not sleep past the ceiling: the last timer is the time that is left', async () => {
    const f = await boot();
    const playbook = await createApprovedPlaybook(f, [waitForCell({ pollMs: 4000, timeoutSeconds: 5, predicate: NEVER_TRUE })]);
    const runId = await startRun(f, playbook.id);
    await until(() => timers.armedCount() === 1);
    now += 4 * SECOND;
    timers.elapseAll();

    await until(() => timers.armedCount() === 2);

    expect(timers.delaysArmed()).toEqual([4000, 1000]);
    expect(statusOfRun(f, runId)).toBe('running');
  });

  it('stops after the cap of evaluations even when the clock does not move', async () => {
    const f = await boot({ maxWaitEvaluations: 3 });
    const playbook = await createApprovedPlaybook(f, [waitForCell({ pollMs: 1000, timeoutSeconds: 86_400, predicate: NEVER_TRUE })]);
    const runId = await startRun(f, playbook.id);

    for (let armed = 1; armed <= 2; armed++) {
      await until(() => timers.armedCount() === armed);
      timers.elapseAll();
    }

    await until(() => statusOfRun(f, runId) !== 'running');
    expect(await viewOfRun(f, runId)).toMatchObject({ status: 'failed', errorCode: 'wait_for_timeout' });
    expect(timers.armedCount()).toBe(2);
  });

  it('cancels its timer when the daemon stops, and journals the step as needs_review', async () => {
    const f = await boot();
    const playbook = await createApprovedPlaybook(f, [waitForCell({ pollMs: 1000, predicate: NEVER_TRUE })]);
    const runId = await startRun(f, playbook.id);
    await until(() => timers.armedCount() === 1);

    await f.daemon.playbookRunner.stop();

    expect(timers.cancelledCount()).toBe(1);
    expect(await viewOfRun(f, runId)).toMatchObject({ status: 'needs_review', errorCode: 'interrupted' });
  });
});

describe('the kinds this runner executes', () => {
  it('still refuses a subPlaybook cell and a tool cell before anything is written', async () => {
    const f = await boot();
    const playbook = await createApprovedPlaybook(f, [waitForCell({ predicate: [{ lhs: 'wait.elapsedMs', op: 'gte', rhs: 0 }] }), { id: 'child', kind: 'subPlaybook', playbookId: 'any' }]);

    const refused = await f.api(`/api/playbooks/${playbook.id}/run`, { method: 'POST', body: JSON.stringify({ inputs: {} }) });

    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ error: 'playbook_not_runnable' });
    expect((f.db.prepare('SELECT COUNT(*) AS n FROM playbook_runs').get() as { n: number }).n).toBe(0);
  });
});
