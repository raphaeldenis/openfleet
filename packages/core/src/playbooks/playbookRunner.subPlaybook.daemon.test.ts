import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { OTHER_PROJECT_ID, OWN_PROJECT_ID, startGovernanceFixture, type GovernanceFixture } from '../governance/governanceQueue.testkit.js';
import { deferred, settle, until } from '../integrations/manualTimers.testkit.js';
import { createInMemorySecretStore, type InMemorySecretStore } from '../secrets/inMemorySecretStore.js';
import { SecretRefRepository } from '../secrets/secretRefRepository.js';
import { createTempDirTracker } from '../tempDirTracker.js';
import { PlaybookRunRepository } from './playbookRunRepository.js';

/*
 * Guards of the subPlaybook cell, each with the test that fails when the guard is removed (replay: break the line, run this file, restore).
 *  1. a real run, the actor of the parent  `launchChild`                   -> 'runs the child as a run of its own ...'
 *  2. link written before the child starts `linkBeforeJournal`             -> 'writes the link to the child before the child starts'
 *  3. same project                         `child.projectId`               -> 'refuses a playbook of another project ...'
 *  4. approved child                       `assertStillApproved`           -> 'refuses a child that is not approved', 'a child edited while its secrets are read'
 *  5. depth 10                             `MAX_SUB_PLAYBOOK_DEPTH`        -> 'accepts ten levels of children and refuses the eleventh'
 *  6. no cycle                             `lineage`                       -> 'refuses a cycle ...', 'refuses a playbook that calls itself'
 *  7. one slot per run                     `assertRoomForAnotherRun`       -> 'refuses the child with playbook_run_busy when the parent holds the only slot', 'a slot taken while the secrets of the child are read'
 *  8. untrusted outputs                    parent masker + cap on the output -> 'masks ... a secret of the parent', 'bounds the output of the child'
 *  9. masked inputs                        parent masker on child inputs   -> 'passes the inputs of the parent to the child with its secrets masked'
 * 10. untrusted input                      slot `child_input`              -> 'refuses at the save a step output in the inputs of the child'
 * 11. no manual child                      `hasManualCell`                 -> 'refuses a child that waits for a human'
 * 12. stop                                 abort of the child              -> 'ends the parent and the child as needs_review ...'
 */
type RunView = { id: string; playbookId: string; status: string; errorCode: string | null; steps: { seq: number; stepId: string; status: string; errorCode: string | null; output: Record<string, unknown> | null }[] };

const directories = createTempDirTracker();
let fixture: GovernanceFixture | undefined;
let scriptRoot = '';
let markers = '';
let secretStore: InMemorySecretStore;
afterEach(async () => { await fixture?.close(); fixture = undefined; directories.removeAll(); });

const SECRET_NAME = 'API_KEY';
const boot = async (playbooks: { maxConcurrentRuns?: number; maxStepExecutions?: number; maxChildRunsPerRoot?: number } = {}) => {
  scriptRoot = directories.make('playbook-scripts-');
  markers = directories.make('playbook-markers-');
  secretStore = createInMemorySecretStore();
  fixture = await startGovernanceFixture({ playbooks: { scriptRoots: [scriptRoot], ...playbooks }, secrets: { store: secretStore } });
  writeScript('noop.sh', 'true');
  writeScript('say.sh', 'printf "%s" "$1"');
  writeScript('hold.sh', `while [ ! -e ${join(markers, 'go')} ]; do sleep 0.05; done`);
  return fixture;
};
const writeScript = (name: string, body: string) => {
  const path = join(scriptRoot, name);
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o700);
};
const release = () => writeFileSync(join(markers, 'go'), '');

const jsonOf = async <T>(response: Response) => await response.json() as T;
const sleepMs = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const waitUntil = async (what: string, isDone: () => boolean, timeoutMs = 20_000) => {
  const deadline = Date.now() + timeoutMs;
  while (!isDone()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleepMs(10);
  }
};
type PlaybookOptions = { projectId?: string; inputs?: Record<string, unknown>[]; approved?: boolean };
const createPlaybook = async (f: GovernanceFixture, cells: Record<string, unknown>[], { projectId = OWN_PROJECT_ID, inputs = [] }: PlaybookOptions = {}) =>
  jsonOf<{ id: string; contentRev: number }>(await f.api('/api/playbooks', { method: 'POST', body: JSON.stringify({ projectId, name: 'P', cells, inputs }) }));
const approve = async (f: GovernanceFixture, playbookId: string) => {
  const { digest } = await jsonOf<{ digest: string }>(await f.api(`/api/playbooks/${playbookId}/approval`));
  expect((await f.api(`/api/playbooks/${playbookId}/approve`, { method: 'POST', body: JSON.stringify({ digest }) })).status).toBe(200);
};
const createApprovedPlaybook = async (f: GovernanceFixture, cells: Record<string, unknown>[], options: PlaybookOptions = {}) => {
  const playbook = await createPlaybook(f, cells, options);
  if (options.approved !== false) await approve(f, playbook.id);
  return playbook;
};
const startRun = (f: GovernanceFixture, playbookId: string, inputs: Record<string, unknown> = {}) => f.api(`/api/playbooks/${playbookId}/run`, { method: 'POST', body: JSON.stringify({ inputs }) });
const viewOfRun = async (f: GovernanceFixture, runId: string) => jsonOf<RunView>(await f.api(`/api/playbook-runs/${runId}`));
const statusOfRun = (f: GovernanceFixture, runId: string) => (f.db.prepare('SELECT status FROM playbook_runs WHERE id = ?').get(runId) as { status: string }).status;
const startedRunId = async (f: GovernanceFixture, playbookId: string, inputs: Record<string, unknown> = {}) => {
  const started = await startRun(f, playbookId, inputs);
  expect(started.status).toBe(202);
  return (await jsonOf<RunView>(started)).id;
};
const runToTheEnd = async (f: GovernanceFixture, playbookId: string, inputs: Record<string, unknown> = {}) => {
  const runId = await startedRunId(f, playbookId, inputs);
  await waitUntil('the run to end', () => statusOfRun(f, runId) !== 'running');
  return viewOfRun(f, runId);
};
const runsOf = (f: GovernanceFixture, playbookId: string) => new PlaybookRunRepository(f.db).listOfPlaybook(playbookId);
const subCell = (playbookId: string, extra: Record<string, unknown> = {}) => ({ id: 'sub', kind: 'subPlaybook', playbookId, ...extra });
const sayCell = { id: 'say', kind: 'script', program: 'say.sh', args: ['{{inputs.who}}'] };
const WHO_INPUT = [{ name: 'who', type: 'string', required: false }];

/** Holds every read of a secret until `release`: a child that needs a secret stops there, and the test acts in that window. */
const holdSecretReads = () => {
  const gate = deferred<void>();
  let reads = 0;
  const read = secretStore.read.bind(secretStore);
  secretStore.read = async (scope, name) => {
    reads += 1;
    await gate.promise;
    return read(scope, name);
  };
  return { release: () => gate.resolve(), reached: (count: number) => until(() => reads >= count) };
};
const secretHolderCell = { id: 'holder', kind: 'http', method: 'GET', url: 'https://example.invalid/', headers: { 'X-Key': `{{secret:${SECRET_NAME}}}` } };
const withASecret = async (f: GovernanceFixture, playbookId: string, value: string) => {
  new SecretRefRepository(f.db).declare({ kind: 'playbook', id: playbookId }, SECRET_NAME);
  await secretStore.set({ kind: 'playbook', id: playbookId }, SECRET_NAME, value);
};
const dummySecret = () => `dummy-canary-built-at-runtime-${randomUUID()}`;
const NEVER = [{ lhs: 'steps.sub.status', op: 'eq', rhs: 'never' }];

describe('a subPlaybook cell runs another playbook of the project', () => {
  it('runs the child as a run of its own, with the actor of the parent, and answers its run id, its status and its output', async () => {
    const f = await boot();
    const child = await createApprovedPlaybook(f, [sayCell], { inputs: WHO_INPUT });
    const parent = await createApprovedPlaybook(f, [subCell(child.id, { inputs: { who: '{{inputs.who}}' } })], { inputs: WHO_INPUT });

    const parentRun = await runToTheEnd(f, parent.id, { who: 'ada' });

    const [childRun] = runsOf(f, child.id);
    expect(parentRun.status).toBe('succeeded');
    expect(childRun).toMatchObject({ status: 'succeeded', inputs: { who: 'ada' } });
    expect(childRun!.actorKind).toBe(runsOf(f, parent.id)[0]!.actorKind);
    expect(parentRun.steps[0]!.output).toMatchObject({ childRunId: childRun!.id, status: 'succeeded' });
    expect(String(parentRun.steps[0]!.output!['output'])).toContain('ada');
  });

  it('writes the link to the child before the child starts', async () => {
    const f = await boot();
    const child = await createApprovedPlaybook(f, [{ id: 'hold', kind: 'script', program: 'hold.sh' }]);
    const parent = await createApprovedPlaybook(f, [subCell(child.id)]);
    const parentRunId = await startedRunId(f, parent.id);
    await waitUntil('the child to run', () => runsOf(f, child.id).length === 1);
    const childRunId = runsOf(f, child.id)[0]!.id;

    const link = new PlaybookRunRepository(f.db).parentOf(childRunId);
    const stepWhileTheChildRuns = (await viewOfRun(f, parentRunId)).steps[0]!;
    release();

    expect(link).toEqual({ runId: parentRunId, seq: 1 });
    expect(stepWhileTheChildRuns).toMatchObject({ status: 'running', output: { childRunId } });
  });

  it('answers no parent for a run nobody called', async () => {
    const f = await boot();
    const standalone = await createApprovedPlaybook(f, [{ id: 'say', kind: 'script', program: 'noop.sh' }]);
    const run = await runToTheEnd(f, standalone.id);

    expect(new PlaybookRunRepository(f.db).parentOf(run.id)).toBeUndefined();
    expect(new PlaybookRunRepository(f.db).parentOf('no-such-run')).toBeUndefined();
  });

  it('refuses a child that is not approved, and starts no run of it', async () => {
    const f = await boot();
    const child = await createApprovedPlaybook(f, [{ id: 'say', kind: 'script', program: 'noop.sh' }], { approved: false });
    const parent = await createApprovedPlaybook(f, [subCell(child.id)]);

    const run = await runToTheEnd(f, parent.id);

    expect(run).toMatchObject({ status: 'failed', errorCode: 'playbook_unapproved' });
    expect(run.steps[0]).toMatchObject({ status: 'failed', errorCode: 'playbook_unapproved' });
    expect(runsOf(f, child.id)).toHaveLength(0);
  });

  it('refuses a playbook of another project, as one that does not exist', async () => {
    const f = await boot();
    const foreign = await createApprovedPlaybook(f, [{ id: 'say', kind: 'script', program: 'noop.sh' }], { projectId: OTHER_PROJECT_ID });
    const parent = await createApprovedPlaybook(f, [subCell(foreign.id)]);

    const run = await runToTheEnd(f, parent.id);

    expect(run.steps[0]).toMatchObject({ status: 'failed', errorCode: 'playbook_not_found' });
    expect(runsOf(f, foreign.id)).toHaveLength(0);
  });

  it('refuses a child that waits for a human', async () => {
    const f = await boot();
    const child = await createApprovedPlaybook(f, [{ id: 'ask', kind: 'manual', prompt: 'ok?' }]);
    const parent = await createApprovedPlaybook(f, [subCell(child.id)]);

    const run = await runToTheEnd(f, parent.id);

    expect(run.steps[0]).toMatchObject({ status: 'failed', errorCode: 'playbook_not_runnable' });
    expect(runsOf(f, child.id)).toHaveLength(0);
  });

  it('answers the last attempt that succeeded when the child ends on a retry whose condition never held', async () => {
    const f = await boot();
    const neverTrue = [{ lhs: 'steps.say.output', op: 'eq', rhs: 'never' }];
    const child = await createApprovedPlaybook(f, [{ id: 'say', kind: 'script', program: 'say.sh', args: ['first'], retry: { maxAttempts: 2, backoffMs: 0, until: neverTrue } }]);
    const parent = await createApprovedPlaybook(f, [subCell(child.id)]);

    const run = await runToTheEnd(f, parent.id);

    expect(run.steps[0]!.output).toMatchObject({ status: 'failed', errorCode: 'retry_exhausted' });
    expect(String(run.steps[0]!.output!['output'])).toContain('first');
  });

  it('fails the parent with sub_playbook_failed when the child fails, and keeps the code of the child in the output', async () => {
    const f = await boot();
    writeScript('fail.sh', 'exit 3');
    const child = await createApprovedPlaybook(f, [{ id: 'boom', kind: 'script', program: 'fail.sh' }]);
    const parent = await createApprovedPlaybook(f, [subCell(child.id)]);

    const run = await runToTheEnd(f, parent.id);

    expect(run).toMatchObject({ status: 'failed', errorCode: 'sub_playbook_failed' });
    expect(run.steps[0]!.output).toMatchObject({ status: 'failed', errorCode: 'script_failed' });
  });
});

describe('the depth and the cycles of subPlaybook cells', () => {
  /** A chain of `length` playbooks: each calls the next, the last one runs a script. Returns the first. */
  const chainOf = async (f: GovernanceFixture, length: number) => {
    let next = await createApprovedPlaybook(f, [{ id: 'leaf', kind: 'script', program: 'noop.sh' }]);
    for (let level = 1; level < length; level += 1) next = await createApprovedPlaybook(f, [subCell(next.id)]);
    return next;
  };
  const allRuns = (f: GovernanceFixture) => f.db.prepare('SELECT playbook_id, status FROM playbook_runs').all() as { playbook_id: string; status: string }[];

  it('accepts ten levels of children and refuses the eleventh', async () => {
    const f = await boot({ maxConcurrentRuns: 20 });
    const tenLevels = await chainOf(f, 11);
    const elevenLevels = await chainOf(f, 12);

    const accepted = await runToTheEnd(f, tenLevels.id);
    const runsAfterTheAccepted = allRuns(f).length;
    const refused = await runToTheEnd(f, elevenLevels.id);

    expect(accepted.status).toBe('succeeded');
    expect(runsAfterTheAccepted).toBe(11);
    expect(refused.status).toBe('failed');
    expect(allRuns(f).length - runsAfterTheAccepted).toBe(11);
    expect(refused.steps[0]).toMatchObject({ status: 'failed', errorCode: 'sub_playbook_failed' });
    const refusals = f.db.prepare("SELECT COUNT(*) AS n FROM playbook_run_steps WHERE error_code = 'playbook_not_runnable'").get() as { n: number };
    expect(refusals.n).toBe(1);
  });

  it('refuses a cycle between two playbooks, at the call that closes it', async () => {
    const f = await boot();
    const a = await createPlaybook(f, [{ id: 'leaf', kind: 'script', program: 'noop.sh' }]);
    const b = await createApprovedPlaybook(f, [subCell(a.id)]);
    expect((await f.api(`/api/playbooks/${a.id}`, { method: 'PUT', body: JSON.stringify({ expectedRev: a.contentRev, cells: [subCell(b.id)] }) })).status).toBe(200);
    await approve(f, a.id);

    const run = await runToTheEnd(f, a.id);

    expect(run.status).toBe('failed');
    expect(runsOf(f, a.id)).toHaveLength(1);
    expect(runsOf(f, b.id)).toHaveLength(1);
    const closing = await viewOfRun(f, runsOf(f, b.id)[0]!.id);
    expect(closing.steps[0]).toMatchObject({ status: 'failed', errorCode: 'playbook_not_runnable' });
  });

  it('refuses a playbook that calls itself', async () => {
    const f = await boot();
    const a = await createPlaybook(f, [{ id: 'leaf', kind: 'script', program: 'noop.sh' }]);
    expect((await f.api(`/api/playbooks/${a.id}`, { method: 'PUT', body: JSON.stringify({ expectedRev: a.contentRev, cells: [subCell(a.id)] }) })).status).toBe(200);
    await approve(f, a.id);

    const run = await runToTheEnd(f, a.id);

    expect(run.steps[0]).toMatchObject({ status: 'failed', errorCode: 'playbook_not_runnable' });
    expect(runsOf(f, a.id)).toHaveLength(1);
  });
});

describe('a child is a run like any other: it needs a place among the runs at once', () => {
  it('refuses the child with playbook_run_busy when the parent holds the only slot', async () => {
    const f = await boot({ maxConcurrentRuns: 1 });
    const child = await createApprovedPlaybook(f, [{ id: 'leaf', kind: 'script', program: 'noop.sh' }]);
    const parent = await createApprovedPlaybook(f, [subCell(child.id)]);

    const run = await runToTheEnd(f, parent.id);

    expect(run).toMatchObject({ status: 'failed', errorCode: 'playbook_run_busy' });
    expect(run.steps[0]).toMatchObject({ status: 'failed', errorCode: 'playbook_run_busy' });
    expect(runsOf(f, child.id)).toHaveLength(0);
  });

  it('runs the child when a second slot exists', async () => {
    const f = await boot({ maxConcurrentRuns: 2 });
    const child = await createApprovedPlaybook(f, [{ id: 'leaf', kind: 'script', program: 'noop.sh' }]);
    const parent = await createApprovedPlaybook(f, [subCell(child.id)]);

    const run = await runToTheEnd(f, parent.id);

    expect(run.status).toBe('succeeded');
    expect(runsOf(f, child.id)).toHaveLength(1);
  });
});

describe('the child is checked again once its secrets are read', () => {
  const childNeedingASecret = async (f: GovernanceFixture) => {
    const child = await createApprovedPlaybook(f, [secretHolderCell]);
    await withASecret(f, child.id, dummySecret());
    return child;
  };

  it('refuses a child edited while its secrets are read, and starts no run of it', async () => {
    const f = await boot();
    const child = await childNeedingASecret(f);
    const parent = await createApprovedPlaybook(f, [subCell(child.id)]);
    const held = holdSecretReads();
    const parentRunId = await startedRunId(f, parent.id);
    await held.reached(1);

    const edited = await f.api(`/api/playbooks/${child.id}`, { method: 'PUT', body: JSON.stringify({ expectedRev: child.contentRev, policy: { allowedHosts: ['example.test'] } }) });
    held.release();
    await waitUntil('the parent to end', () => statusOfRun(f, parentRunId) !== 'running');

    expect(edited.status).toBe(200);
    expect((await viewOfRun(f, parentRunId)).steps[0]).toMatchObject({ status: 'failed', errorCode: 'playbook_unapproved' });
    expect(runsOf(f, child.id)).toHaveLength(0);
  });

  it('refuses a child when a slot was taken while its secrets are read, and starts no run of it', async () => {
    const f = await boot({ maxConcurrentRuns: 2 });
    const child = await childNeedingASecret(f);
    const parent = await createApprovedPlaybook(f, [subCell(child.id)]);
    const other = await createApprovedPlaybook(f, [{ id: 'hold', kind: 'script', program: 'hold.sh' }]);
    const held = holdSecretReads();
    const parentRunId = await startedRunId(f, parent.id);
    await held.reached(1);

    await startedRunId(f, other.id);
    held.release();
    await waitUntil('the parent to end', () => statusOfRun(f, parentRunId) !== 'running');
    release();

    expect((await viewOfRun(f, parentRunId)).steps[0]).toMatchObject({ status: 'failed', errorCode: 'playbook_run_busy' });
    expect(runsOf(f, child.id)).toHaveLength(0);
  });
});

describe('what a child answers is data the parent did not write', () => {
  it('passes the inputs of the parent to the child with the secrets of the parent masked', async () => {
    const f = await boot();
    const value = dummySecret();
    const child = await createApprovedPlaybook(f, [{ id: 'say', kind: 'script', program: 'say.sh', args: ['{{inputs.note}}'] }], { inputs: [{ name: 'note', type: 'string', required: false }] });
    const parent = await createApprovedPlaybook(f, [subCell(child.id, { inputs: { note: '{{inputs.note}}' }, next: [{ to: 'holder', when: NEVER }] }), secretHolderCell], { inputs: [{ name: 'note', type: 'string', required: false }] });
    await withASecret(f, parent.id, value);

    await runToTheEnd(f, parent.id, { note: value });

    const everythingPersisted = JSON.stringify(['playbook_runs', 'playbook_run_steps'].map((table) => f.db.prepare(`SELECT * FROM ${table}`).all()));
    expect(runsOf(f, child.id)[0]!.inputs).toEqual({ note: `[secret:${SECRET_NAME}]` });
    expect(everythingPersisted).not.toContain(value);
  });

  it('masks a secret of the parent in the journal of the child, and in the answer of the parent', async () => {
    const f = await boot();
    const value = dummySecret();
    const storeId = await f.createTable(OWN_PROJECT_ID, `T-${randomUUID()}`);
    const columnId = f.daemon.stores.addColumn(storeId, { projectId: OWN_PROJECT_ID, displayName: 'note', columnType: 'text' }).id;
    f.daemon.stores.insertRow(storeId, { projectId: OWN_PROJECT_ID, actor: { kind: 'human', label: 'tester' }, data: { [columnId]: value } });
    const child = await createApprovedPlaybook(f, [{ id: 'read', kind: 'readFromStore', storeID: storeId, columns: [columnId] }]);
    const parent = await createApprovedPlaybook(f, [subCell(child.id, { next: [{ to: 'holder', when: NEVER }] }), secretHolderCell]);
    await withASecret(f, parent.id, value);

    const run = await runToTheEnd(f, parent.id);

    const everythingPersisted = JSON.stringify(['playbook_runs', 'playbook_run_steps'].map((table) => f.db.prepare(`SELECT * FROM ${table}`).all()));
    const childAnswer = JSON.stringify((await viewOfRun(f, runsOf(f, child.id)[0]!.id)).steps[0]!.output);
    expect(everythingPersisted).not.toContain(value);
    expect(childAnswer).toContain(`[secret:${SECRET_NAME}]`);
    expect(JSON.stringify(run.steps[0]!.output)).toContain(`[secret:${SECRET_NAME}]`);
  });

  it('masks a secret of a grandparent in the journal of the grandchild', async () => {
    const f = await boot();
    const value = dummySecret();
    const storeId = await f.createTable(OWN_PROJECT_ID, `T-${randomUUID()}`);
    const columnId = f.daemon.stores.addColumn(storeId, { projectId: OWN_PROJECT_ID, displayName: 'note', columnType: 'text' }).id;
    f.daemon.stores.insertRow(storeId, { projectId: OWN_PROJECT_ID, actor: { kind: 'human', label: 'tester' }, data: { [columnId]: value } });
    const grandchild = await createApprovedPlaybook(f, [{ id: 'read', kind: 'readFromStore', storeID: storeId, columns: [columnId] }]);
    const child = await createApprovedPlaybook(f, [subCell(grandchild.id)]);
    const parent = await createApprovedPlaybook(f, [subCell(child.id, { next: [{ to: 'holder', when: NEVER }] }), secretHolderCell]);
    await withASecret(f, parent.id, value);

    await runToTheEnd(f, parent.id);

    const everythingPersisted = JSON.stringify(['playbook_runs', 'playbook_run_steps'].map((table) => f.db.prepare(`SELECT * FROM ${table}`).all()));
    expect(everythingPersisted).not.toContain(value);
  });

  it('bounds the output of the child at the cap of the output of a step', async () => {
    const f = await boot();
    writeScript('quotes.sh', `head -c 200000 /dev/zero | tr '\\0' '"'`);
    const child = await createApprovedPlaybook(f, [{ id: 'quotes', kind: 'script', program: 'quotes.sh' }]);
    const parent = await createApprovedPlaybook(f, [subCell(child.id)]);

    const run = await runToTheEnd(f, parent.id);

    expect(run.status).toBe('succeeded');
    expect(String(run.steps[0]!.output!['output']).length).toBeLessThanOrEqual(256 * 1024);
  });

  it('refuses at the save a step output in the inputs of the child', async () => {
    const f = await boot();
    const child = await createApprovedPlaybook(f, [sayCell], { inputs: WHO_INPUT });

    const saved = await f.api('/api/playbooks', { method: 'POST', body: JSON.stringify({ projectId: OWN_PROJECT_ID, name: 'P', cells: [
      { id: 'gen', kind: 'script', program: 'noop.sh' }, subCell(child.id, { inputs: { who: '{{steps.gen.output}}' } }),
    ] }) });

    expect(saved.status).toBeGreaterThanOrEqual(400);
    expect(await saved.json()).toMatchObject({ error: 'untrusted_reference' });
  });
});

describe('a daemon that stops while a child runs', () => {
  it('ends the parent and the child as needs_review, and never starts either again', async () => {
    const f = await boot();
    const child = await createApprovedPlaybook(f, [{ id: 'hold', kind: 'script', program: 'hold.sh' }]);
    const parent = await createApprovedPlaybook(f, [subCell(child.id)]);
    const parentRunId = await startedRunId(f, parent.id);
    await waitUntil('the child to run', () => runsOf(f, child.id).length === 1 && existsSync(scriptRoot));

    await f.daemon.playbookRunner.stop();

    expect(await viewOfRun(f, parentRunId)).toMatchObject({ status: 'needs_review', errorCode: 'interrupted', steps: [{ status: 'needs_review', errorCode: 'interrupted' }] });
    expect(runsOf(f, child.id)[0]).toMatchObject({ status: 'needs_review', errorCode: 'interrupted' });
  }, 25_000);
});

describe('a parent that disappears or changes while its child starts or runs', () => {
  const deleteOf = (f: GovernanceFixture, playbook: { id: string; contentRev: number }) => f.api(`/api/playbooks/${playbook.id}?expectedRev=${playbook.contentRev}`, { method: 'DELETE' });

  it('refuses to delete the parent playbook while its run waits for the secrets of the child', async () => {
    const f = await boot();
    const child = await createApprovedPlaybook(f, [secretHolderCell]);
    await withASecret(f, child.id, dummySecret());
    const parent = await createApprovedPlaybook(f, [subCell(child.id)]);
    const held = holdSecretReads();
    await startedRunId(f, parent.id);
    await held.reached(1);

    const refused = await deleteOf(f, parent);
    held.release();
    await settle(30);

    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ error: 'playbook_run_busy' });
    expect((await f.api(`/api/playbooks/${parent.id}`)).status).toBe(200);
    expect(runsOf(f, child.id)).toHaveLength(1);
  });

  it('refuses to delete the playbook of a child while the child runs, and the parent gets its result', async () => {
    const f = await boot();
    const child = await createApprovedPlaybook(f, [{ id: 'hold', kind: 'script', program: 'hold.sh' }]);
    const parent = await createApprovedPlaybook(f, [subCell(child.id)]);
    const parentRunId = await startedRunId(f, parent.id);
    await waitUntil('the child to run', () => runsOf(f, child.id).length === 1);

    const refused = await deleteOf(f, child);
    const refusedForTheParent = await deleteOf(f, parent);
    release();
    await waitUntil('the parent to end', () => statusOfRun(f, parentRunId) !== 'running');

    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ error: 'playbook_run_busy' });
    expect(refusedForTheParent.status).toBe(409);
    const parentRun = await viewOfRun(f, parentRunId);
    expect(parentRun.status).toBe('succeeded');
    expect(parentRun.steps[0]!.output).toMatchObject({ status: 'succeeded' });
  });

  it('deletes a playbook once its runs have ended', async () => {
    const f = await boot();
    const leaf = await createApprovedPlaybook(f, [{ id: 'leaf', kind: 'script', program: 'noop.sh' }]);
    await runToTheEnd(f, leaf.id);

    const deleted = await deleteOf(f, leaf);

    expect(deleted.status).toBe(200);
  });

  it('lets the parent go on with the content it was approved with when it is edited while the child runs', async () => {
    const f = await boot();
    const child = await createApprovedPlaybook(f, [{ id: 'hold', kind: 'script', program: 'hold.sh' }]);
    const parent = await createApprovedPlaybook(f, [subCell(child.id)]);
    const parentRunId = await startedRunId(f, parent.id);
    await waitUntil('the child to run', () => runsOf(f, child.id).length === 1);

    const edited = await f.api(`/api/playbooks/${parent.id}`, { method: 'PUT', body: JSON.stringify({ expectedRev: parent.contentRev, policy: { allowedHosts: ['example.test'] } }) });
    release();
    await waitUntil('the parent to end', () => statusOfRun(f, parentRunId) !== 'running');

    expect(edited.status).toBe(200);
    expect(await viewOfRun(f, parentRunId)).toMatchObject({ status: 'succeeded' });
  });
});

describe('a tree of runs shares one budget, carried by its root', () => {
  const ITEMS = [{ name: 'items', type: 'json', required: false }];
  const fanOutTo = (playbookId: string, extra: Record<string, unknown> = {}) => [
    { id: 'start', kind: 'script', program: 'noop.sh', next: [{ to: 'sub', forEach: 'inputs.items' }] },
    subCell(playbookId, { inputs: { items: '{{inputs.items}}' }, ...extra }),
  ];
  const allSteps = (f: GovernanceFixture) => (f.db.prepare('SELECT COUNT(*) AS n FROM playbook_run_steps').get() as { n: number }).n;

  it('refuses the child that would pass the children a root may start, with a code of the journal', async () => {
    const f = await boot({ maxChildRunsPerRoot: 3 });
    const leaf = await createApprovedPlaybook(f, [{ id: 'leaf', kind: 'script', program: 'noop.sh' }], { inputs: ITEMS });
    const root = await createApprovedPlaybook(f, fanOutTo(leaf.id), { inputs: ITEMS });

    const run = await runToTheEnd(f, root.id, { items: [1, 2, 3, 4, 5] });

    expect(run).toMatchObject({ status: 'failed', errorCode: 'for_each_iteration_failed' });
    expect(runsOf(f, leaf.id)).toHaveLength(3);
    expect(run.steps.at(-1)).toMatchObject({ status: 'failed', errorCode: 'sub_playbook_limit_exceeded' });
  });

  it('caps a fan-out of three generations at the children a root may start', async () => {
    const f = await boot({ maxChildRunsPerRoot: 5 });
    const leaf = await createApprovedPlaybook(f, [{ id: 'leaf', kind: 'script', program: 'noop.sh' }], { inputs: ITEMS });
    const middle = await createApprovedPlaybook(f, fanOutTo(leaf.id), { inputs: ITEMS });
    const root = await createApprovedPlaybook(f, fanOutTo(middle.id), { inputs: ITEMS });

    const run = await runToTheEnd(f, root.id, { items: [1, 2, 3] });

    expect(run.status).toBe('failed');
    expect((f.db.prepare('SELECT COUNT(*) AS n FROM playbook_runs').get() as { n: number }).n).toBe(1 + 5);
  });

  it('counts the steps of every run of the tree among the step executions of its root', async () => {
    const f = await boot({ maxStepExecutions: 6 });
    const three = [{ id: 'one', kind: 'script', program: 'noop.sh' }, { id: 'two', kind: 'script', program: 'noop.sh' }, { id: 'three', kind: 'script', program: 'noop.sh' }];
    const leaf = await createApprovedPlaybook(f, three, { inputs: ITEMS });
    const root = await createApprovedPlaybook(f, fanOutTo(leaf.id), { inputs: ITEMS });

    const run = await runToTheEnd(f, root.id, { items: [1, 2, 3] });

    expect(run.status).toBe('failed');
    expect(allSteps(f)).toBeLessThanOrEqual(6);
    expect(f.db.prepare("SELECT COUNT(*) AS n FROM playbook_run_steps WHERE error_code = 'step_limit_exceeded'").get()).toEqual({ n: 0 });
  });
});
