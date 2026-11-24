import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { OWN_PROJECT_ID, OTHER_PROJECT_ID, startGovernanceFixture, type GovernanceFixture } from '../governance/governanceQueue.testkit.js';
import { createManualTimers, deferred, until, type ManualTimers } from '../integrations/manualTimers.testkit.js';
import { createFakeTauriParent, type FakeTauriParent } from '../secrets/fakeTauriParent.testkit.js';
import type { OperatorAction } from '../secrets/nonceLedger.js';
import { createInMemorySecretStore, type InMemorySecretStore } from '../secrets/inMemorySecretStore.js';
import { SecretRefRepository } from '../secrets/secretRefRepository.js';

/*
 * Guards of the manual cell, each with the test that fails when the guard is removed (replay: break the line, run this file, restore).
 *  1. parked, not running     `parkOnManualStep` / countRunning -> 'does not count a parked run ...'
 *  2. single use              `UPDATE ... WHERE status = 'pending'` -> 'refuses a second answer ...'
 *  3. human proof             `humanProof.consume` in resumeManualStep -> the five 'refuses the answer ... proof' cases
 *  4. bound to run and seq    OperatorBinding of `playbook.resume_manual` -> 'with the nonce of another run', 'with the nonce of another step'
 *  5. expiry                  `expiresAt` -> 'refuses an answer after the expiry ...', 'fails a wait that expired ...'
 *  6. parked cap              `maxParkedRunsPerProject` -> 'refuses a new run beyond the cap ...'
 *  7. approval at resume      `assertStillApproved` + `flowSha256` in resumeManualStep -> 'refuses to resume a playbook edited while waiting ...'
 *  8. secrets re-resolved     `resolveSecretsOf` in resumeManualStep -> 'resolves the secrets again at the answer ...'
 *  9. no persisted secret     masker on the prompt -> 'persists no secret value while the run waits'
 * 10. no replay after crash   interruptEverythingRunning leaves waiting_manual alone -> 'keeps a parked run parked across a boot ...'
 * 11. rejected                decision 'rejected' -> 'ends the run failed when the human rejects'
 */
type RunView = {
  id: string; status: string; errorCode: string | null;
  steps: { seq: number; stepId: string; status: string; errorCode: string | null; output: Record<string, unknown> | null }[];
};

const START_OF_TEST_TIME = Date.parse('2026-11-12T10:00:00.000Z');
const SECOND = 1000;
const HUMAN_PROOF_HEADER = 'x-human-proof';
const RESUME_ACTION = 'playbook.resume_manual';
const SECRET_NAME = 'GATE_SECRET';

let fixture: GovernanceFixture | undefined;
let parent: FakeTauriParent;
let secretStore: InMemorySecretStore;
let timers: ManualTimers;
let now: number;
afterEach(async () => {
  await fixture?.close();
  fixture = undefined;
});

const boot = async (limits: { maxConcurrentRuns?: number; maxRunsNeedingReview?: number; maxParkedRunsPerProject?: number; maxForEachIterations?: number; maxChildRunsPerRoot?: number; maxStepExecutions?: number } = {}) => {
  now = START_OF_TEST_TIME;
  parent = createFakeTauriParent();
  secretStore = createInMemorySecretStore();
  timers = createManualTimers();
  fixture = await startGovernanceFixture({
    secrets: { store: secretStore, parent: parent.link },
    playbooks: { clock: () => new Date(now).toISOString(), startTimer: timers.startTimer, ...limits },
  });
  return fixture;
};

const jsonOf = async <T>(response: Response) => await response.json() as T;
const createPlaybook = async (f: GovernanceFixture, cells: Record<string, unknown>[], extra: Record<string, unknown> = {}) =>
  jsonOf<{ id: string; contentRev: number }>(await f.api('/api/playbooks', { method: 'POST', body: JSON.stringify({ projectId: OWN_PROJECT_ID, name: 'P', cells, ...extra }) }));
const approve = async (f: GovernanceFixture, playbookId: string) => {
  const { digest } = await jsonOf<{ digest: string }>(await f.api(`/api/playbooks/${playbookId}/approval`));
  return f.api(`/api/playbooks/${playbookId}/approve`, { method: 'POST', body: JSON.stringify({ digest }) });
};
const createApprovedPlaybook = async (f: GovernanceFixture, cells: Record<string, unknown>[], extra: Record<string, unknown> = {}) => {
  const playbook = await createPlaybook(f, cells, extra);
  expect((await approve(f, playbook.id)).status).toBe(200);
  return playbook;
};
const viewOfRun = async (f: GovernanceFixture, runId: string) => jsonOf<RunView>(await f.api(`/api/playbook-runs/${runId}`));
const statusOfRun = (f: GovernanceFixture, runId: string) => (f.db.prepare('SELECT status FROM playbook_runs WHERE id = ?').get(runId) as { status: string }).status;
const persistedBy = (f: GovernanceFixture, tables: string[]) => JSON.stringify(tables.map((table) => f.db.prepare(`SELECT * FROM ${table}`).all()));

const startRun = async (f: GovernanceFixture, playbookId: string, inputs: Record<string, unknown> = {}) => {
  const started = await f.api(`/api/playbooks/${playbookId}/run`, { method: 'POST', body: JSON.stringify({ inputs }) });
  return { status: started.status, body: await started.json() as RunView & { error?: string } };
};
const runUntilParked = async (f: GovernanceFixture, playbookId: string, inputs: Record<string, unknown> = {}) => {
  const started = await startRun(f, playbookId, inputs);
  expect(started.status).toBe(202);
  await until(() => statusOfRun(f, started.body.id) !== 'running');
  return started.body.id;
};

const human = { kind: 'human', label: 'tester' } as const;
const makeTable = async (f: GovernanceFixture) => {
  const storeId = await f.createTable(OWN_PROJECT_ID, `T-${randomUUID()}`);
  const noteId = f.daemon.stores.addColumn(storeId, { projectId: OWN_PROJECT_ID, displayName: 'note', columnType: 'text' }).id;
  return { storeId, noteId, rows: () => f.daemon.stores.query(storeId, { projectId: OWN_PROJECT_ID }), insert: (note: string) => f.daemon.stores.insertRow(storeId, { projectId: OWN_PROJECT_ID, actor: human, data: { [noteId]: note } }) };
};

const manualCell = (id: string, extra: Record<string, unknown> = {}) => ({ id, kind: 'manual', prompt: 'Ship it?', ...extra });
const writeCell = (id: string, storeID: string, noteId: string, note: string) => ({ id, kind: 'writeToStore', storeID, rowMappings: { [noteId]: note } });

const nonceFor = (runId: string, seq: number, action: OperatorAction = RESUME_ACTION) =>
  parent.mintOperatorNonce({ action, scope: { kind: 'playbook_run', id: runId }, name: String(seq) });
const answer = (f: GovernanceFixture, runId: string, seq: number, { decision = 'approve', proof }: { decision?: string; proof?: string } = {}) =>
  f.api(`/api/playbook-runs/${runId}/steps/${seq}/resume`, { method: 'POST', body: JSON.stringify({ decision }), headers: proof === undefined ? {} : { [HUMAN_PROOF_HEADER]: proof } });
const answerWithProof = (f: GovernanceFixture, runId: string, seq = 1, decision = 'approve') => answer(f, runId, seq, { decision, proof: nonceFor(runId, seq) });
const eventually = async (f: GovernanceFixture, runId: string, status: string) => { await until(() => statusOfRun(f, runId) === status); return viewOfRun(f, runId); };

describe('a manual cell parks the run until a human answers', () => {
  it('parks the run and its step as waiting_manual, keeps the masked prompt and ends nothing', async () => {
    const f = await boot();
    const table = await makeTable(f);
    const playbook = await createApprovedPlaybook(f, [manualCell('gate', { prompt: 'Ship {{inputs.who}}?' }), writeCell('after', table.storeId, table.noteId, 'shipped')], { inputs: [{ name: 'who', type: 'string', required: true }] });

    const runId = await runUntilParked(f, playbook.id, { who: 'v2' });

    const run = await viewOfRun(f, runId);
    expect(run.status).toBe('waiting_manual');
    expect(run.steps.map((step) => [step.stepId, step.status])).toEqual([['gate', 'waiting_manual']]);
    expect(f.db.prepare('SELECT prompt_masked, status FROM playbook_manual_requests WHERE run_id = ?').get(runId)).toEqual({ prompt_masked: 'Ship v2?', status: 'pending' });
    expect(table.rows()).toHaveLength(0);
  });

  it('does not count a parked run among the running runs nor among the runs awaiting a review', async () => {
    const f = await boot({ maxConcurrentRuns: 1, maxRunsNeedingReview: 1 });
    const first = await createApprovedPlaybook(f, [manualCell('gate')]);
    const second = await createApprovedPlaybook(f, [manualCell('gate')]);

    await runUntilParked(f, first.id);
    const secondStart = await startRun(f, second.id);

    expect(secondStart.status).toBe(202);
  });

  it('resumes the run once on an approval and goes on with the next cell', async () => {
    const f = await boot();
    const table = await makeTable(f);
    const playbook = await createApprovedPlaybook(f, [manualCell('gate'), writeCell('after', table.storeId, table.noteId, 'shipped')]);
    const runId = await runUntilParked(f, playbook.id);

    const response = await answerWithProof(f, runId);

    expect(response.status).toBe(200);
    const run = await eventually(f, runId, 'succeeded');
    expect(run.steps.map((step) => [step.seq, step.stepId, step.status])).toEqual([[1, 'gate', 'succeeded'], [2, 'after', 'succeeded']]);
    expect(run.steps[0]?.output).toEqual({ decision: 'approved' });
    expect(table.rows().map((row) => row.data[table.noteId])).toEqual(['shipped']);
  });

  it('chooses the edge on the decision of the approval being answered: the branch on `approved` runs, the fallback does not', async () => {
    const f = await boot();
    const table = await makeTable(f);
    const playbook = await createApprovedPlaybook(f, [
      manualCell('gate', { next: [{ to: 'ship', when: [{ lhs: 'steps.gate.decision', op: 'eq', rhs: 'approved' }] }, { to: 'fallback' }] }),
      { ...writeCell('ship', table.storeId, table.noteId, 'shipped'), next: [] },
      writeCell('fallback', table.storeId, table.noteId, 'fallback'),
    ]);
    const runId = await runUntilParked(f, playbook.id);

    const response = await answerWithProof(f, runId);

    expect(response.status).toBe(200);
    const run = await eventually(f, runId, 'succeeded');
    expect(run.steps.map((step) => [step.stepId, step.status])).toEqual([['gate', 'succeeded'], ['ship', 'succeeded']]);
    expect(table.rows().map((row) => row.data[table.noteId])).toEqual(['shipped']);
  });

  it('lets the cell after the approval read the decision of the approval being answered', async () => {
    const f = await boot();
    const table = await makeTable(f);
    const playbook = await createApprovedPlaybook(f, [manualCell('gate'), writeCell('after', table.storeId, table.noteId, 'decision={{steps.gate.decision}}')]);
    const runId = await runUntilParked(f, playbook.id);

    await answerWithProof(f, runId);

    const run = await eventually(f, runId, 'succeeded');
    expect(run.steps.map((step) => [step.stepId, step.status])).toEqual([['gate', 'succeeded'], ['after', 'succeeded']]);
    expect(table.rows().map((row) => row.data[table.noteId])).toEqual(['decision=approved']);
  });

  it('ends the run failed when the human rejects a gate that has a branch on `approved`, and runs neither branch', async () => {
    const f = await boot();
    const table = await makeTable(f);
    const playbook = await createApprovedPlaybook(f, [
      manualCell('gate', { next: [{ to: 'ship', when: [{ lhs: 'steps.gate.decision', op: 'eq', rhs: 'approved' }] }, { to: 'fallback' }] }),
      { ...writeCell('ship', table.storeId, table.noteId, 'shipped'), next: [] },
      writeCell('fallback', table.storeId, table.noteId, 'fallback'),
    ]);
    const runId = await runUntilParked(f, playbook.id);

    const response = await answerWithProof(f, runId, 1, 'reject');

    expect(response.status).toBe(200);
    const run = await viewOfRun(f, runId);
    expect(run.status).toBe('failed');
    expect(run.steps.map((step) => [step.stepId, step.status])).toEqual([['gate', 'failed']]);
    expect(table.rows()).toHaveLength(0);
  });

  it('ends the run failed when the human rejects, and goes no further', async () => {
    const f = await boot();
    const table = await makeTable(f);
    const playbook = await createApprovedPlaybook(f, [manualCell('gate'), writeCell('after', table.storeId, table.noteId, 'shipped')]);
    const runId = await runUntilParked(f, playbook.id);

    const response = await answerWithProof(f, runId, 1, 'reject');

    expect(response.status).toBe(200);
    const run = await viewOfRun(f, runId);
    expect(run).toMatchObject({ status: 'failed', errorCode: 'manual_rejected' });
    expect(run.steps.map((step) => [step.stepId, step.status, step.errorCode])).toEqual([['gate', 'failed', 'manual_rejected']]);
    expect(table.rows()).toHaveLength(0);
  });

  it('refuses a second answer and resumes the run only once', async () => {
    const f = await boot();
    const table = await makeTable(f);
    const playbook = await createApprovedPlaybook(f, [manualCell('gate'), writeCell('after', table.storeId, table.noteId, 'shipped')]);
    const runId = await runUntilParked(f, playbook.id);
    expect((await answerWithProof(f, runId)).status).toBe(200);
    await eventually(f, runId, 'succeeded');

    const second = await answerWithProof(f, runId);

    expect(second.status).toBe(409);
    expect(await second.json()).toMatchObject({ error: 'manual_already_answered' });
    expect(table.rows()).toHaveLength(1);
  });

  it('refuses two answers sent at the same time: exactly one resumes the run', async () => {
    const f = await boot();
    const table = await makeTable(f);
    const playbook = await createApprovedPlaybook(f, [manualCell('gate'), writeCell('after', table.storeId, table.noteId, 'shipped')]);
    const runId = await runUntilParked(f, playbook.id);

    const statuses = (await Promise.all([answerWithProof(f, runId), answerWithProof(f, runId)])).map((response) => response.status).sort();

    expect(statuses).toEqual([200, 409]);
    await eventually(f, runId, 'succeeded');
    expect(table.rows()).toHaveLength(1);
  });
});

describe('the answer to a manual cell is a human gesture', () => {
  const refusals: [string, (runId: string) => string | undefined][] = [
    ['no proof at all', () => undefined],
    ['a proof that was never minted', () => 'never-minted-proof-0123456789'],
    ['the nonce of another run', () => nonceFor('another-run', 1)],
    ['the nonce of another step', (runId) => nonceFor(runId, 2)],
    ['the nonce of another action', (runId) => nonceFor(runId, 1, 'set')],
  ];
  it.each(refusals)('refuses the answer with %s, and the run stays parked', async (_name, proofOf) => {
    const f = await boot();
    const table = await makeTable(f);
    const playbook = await createApprovedPlaybook(f, [manualCell('gate'), writeCell('after', table.storeId, table.noteId, 'shipped')]);
    const runId = await runUntilParked(f, playbook.id);

    const response = await answer(f, runId, 1, { proof: proofOf(runId) });

    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ error: 'human_proof_required' });
    expect(statusOfRun(f, runId)).toBe('waiting_manual');
    expect(table.rows()).toHaveLength(0);
  });

  it('refuses a proof that was already spent', async () => {
    const f = await boot();
    const playbook = await createApprovedPlaybook(f, [manualCell('first'), manualCell('second')]);
    const runId = await runUntilParked(f, playbook.id);
    const proof = nonceFor(runId, 1);
    expect((await answer(f, runId, 1, { proof })).status).toBe(200);
    await until(() => (f.db.prepare('SELECT COUNT(*) AS n FROM playbook_manual_requests WHERE run_id = ?').get(runId) as { n: number }).n === 2);
    await until(() => statusOfRun(f, runId) === 'waiting_manual');

    const replay = await answer(f, runId, 2, { proof });

    expect(replay.status).toBe(401);
    expect(statusOfRun(f, runId)).toBe('waiting_manual');
  });

  it('refuses the answer sent with the token of an agent: the route is under the admin token only', async () => {
    const f = await boot();
    const playbook = await createApprovedPlaybook(f, [manualCell('gate')]);
    const runId = await runUntilParked(f, playbook.id);
    const agentBearer = (f.db.prepare('SELECT mcp_token FROM sessions WHERE id = ?').get(f.lead.id) as { mcp_token: string }).mcp_token;

    const response = await fetch(`${f.daemon.server.url}/api/playbook-runs/${runId}/steps/1/resume`, {
      method: 'POST', body: JSON.stringify({ decision: 'approve' }), headers: { 'content-type': 'application/json', authorization: `Bearer ${agentBearer}`, [HUMAN_PROOF_HEADER]: nonceFor(runId, 1) },
    });

    expect(response.status).toBe(401);
    expect(statusOfRun(f, runId)).toBe('waiting_manual');
  });
});

describe('a wait is bounded', () => {
  it('refuses an answer after the expiry with manual_wait_expired and does not resume the run', async () => {
    const f = await boot();
    const table = await makeTable(f);
    const playbook = await createApprovedPlaybook(f, [manualCell('gate', { timeoutSeconds: 60 }), writeCell('after', table.storeId, table.noteId, 'shipped')]);
    const runId = await runUntilParked(f, playbook.id);
    now += 61 * SECOND;

    const response = await answerWithProof(f, runId);

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: 'manual_wait_expired' });
    expect(await viewOfRun(f, runId)).toMatchObject({ status: 'failed', errorCode: 'manual_wait_expired' });
    expect(table.rows()).toHaveLength(0);
  });

  it('ends the wait at the very instant it is due: an answer at that instant is refused', async () => {
    const f = await boot();
    const playbook = await createApprovedPlaybook(f, [manualCell('gate', { timeoutSeconds: 60 })]);
    const runId = await runUntilParked(f, playbook.id);
    now += 60 * SECOND;

    const response = await answerWithProof(f, runId);

    expect(await response.json()).toMatchObject({ error: 'manual_wait_expired' });
  });

  it('answers on the last second of the wait', async () => {
    const f = await boot();
    const playbook = await createApprovedPlaybook(f, [manualCell('gate', { timeoutSeconds: 60 })]);
    const runId = await runUntilParked(f, playbook.id);
    now += 59 * SECOND;

    expect((await answerWithProof(f, runId)).status).toBe(200);
  });

  it('fails a wait that expired when the next run starts, and frees its place', async () => {
    const f = await boot({ maxParkedRunsPerProject: 1 });
    const playbook = await createApprovedPlaybook(f, [manualCell('gate', { timeoutSeconds: 60 })]);
    const other = await createApprovedPlaybook(f, [manualCell('gate')]);
    const expiring = await runUntilParked(f, playbook.id);
    now += 61 * SECOND;

    const start = await startRun(f, other.id);

    expect(start.status).toBe(202);
    expect(await viewOfRun(f, expiring)).toMatchObject({ status: 'failed', errorCode: 'manual_wait_expired' });
  });

  it('refuses a new run beyond the cap of parked runs of the project, and writes nothing', async () => {
    const f = await boot({ maxParkedRunsPerProject: 2 });
    const playbooks = await Promise.all([1, 2, 3].map(() => createApprovedPlaybook(f, [manualCell('gate')])));
    await runUntilParked(f, playbooks[0]!.id);
    await runUntilParked(f, playbooks[1]!.id);
    const runsBefore = (f.db.prepare('SELECT COUNT(*) AS n FROM playbook_runs').get() as { n: number }).n;

    const refused = await startRun(f, playbooks[2]!.id);

    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({ error: 'playbook_waiting_backlog' });
    expect((f.db.prepare('SELECT COUNT(*) AS n FROM playbook_runs').get() as { n: number }).n).toBe(runsBefore);
  });

  it('fails the step of a run that reaches its manual cell when the project is at the cap, so the cap holds for runs started before it was reached', async () => {
    const f = await boot({ maxParkedRunsPerProject: 1 });
    const waitsFirst = await createApprovedPlaybook(f, [{ id: 'wait', kind: 'waitFor', pollMs: 1000, predicate: [{ lhs: 'wait.elapsedMs', op: 'gte', rhs: 5000 }] }, manualCell('gate')]);
    const parksAtOnce = await createApprovedPlaybook(f, [manualCell('gate')]);
    const late = (await startRun(f, waitsFirst.id)).body.id;
    await until(() => timers.armedCount() === 1);
    await runUntilParked(f, parksAtOnce.id);

    now += 5 * SECOND;
    timers.elapseAll();
    await until(() => statusOfRun(f, late) !== 'running');

    expect(await viewOfRun(f, late)).toMatchObject({ status: 'failed', errorCode: 'playbook_waiting_backlog' });
  });

  it('counts the parked runs per project: another project is not held back', async () => {
    const f = await boot({ maxParkedRunsPerProject: 1 });
    const own = await createApprovedPlaybook(f, [manualCell('gate')]);
    const foreign = jsonOf<{ id: string }>(await f.api('/api/playbooks', { method: 'POST', body: JSON.stringify({ projectId: OTHER_PROJECT_ID, name: 'F', cells: [manualCell('gate')] }) }));
    await approve(f, (await foreign).id);
    await runUntilParked(f, own.id);

    const start = await startRun(f, (await foreign).id);

    expect(start.status).toBe(202);
  });
});

describe('the run is checked again when the human answers', () => {
  it.each([
    ['its cells', { cells: [manualCell('gate'), manualCell('extra')] }],
    ['its policy (the hosts it may call)', { policy: { allowedHosts: ['example.test'] } }],
  ])('refuses to resume a playbook whose %s were edited while it waited, and ends the run in review', async (_what, edit) => {
    const f = await boot();
    const table = await makeTable(f);
    const playbook = await createApprovedPlaybook(f, [manualCell('gate'), writeCell('after', table.storeId, table.noteId, 'shipped')]);
    const runId = await runUntilParked(f, playbook.id);
    const edited = await f.api(`/api/playbooks/${playbook.id}`, { method: 'PUT', body: JSON.stringify({ expectedRev: playbook.contentRev, ...edit }) });
    expect(edited.status).toBe(200);

    const response = await answerWithProof(f, runId);

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: 'playbook_unapproved' });
    expect(await viewOfRun(f, runId)).toMatchObject({ status: 'needs_review', errorCode: 'playbook_changed_while_waiting' });
    expect(table.rows()).toHaveLength(0);
  });

  it('refuses to resume a playbook that was edited and approved again while it waited: it is not the content that was read', async () => {
    const f = await boot();
    const table = await makeTable(f);
    const playbook = await createApprovedPlaybook(f, [manualCell('gate'), writeCell('after', table.storeId, table.noteId, 'shipped')]);
    const runId = await runUntilParked(f, playbook.id);
    await f.api(`/api/playbooks/${playbook.id}`, { method: 'PUT', body: JSON.stringify({ expectedRev: playbook.contentRev, cells: [manualCell('gate'), writeCell('after', table.storeId, table.noteId, 'something else')] }) });
    expect((await approve(f, playbook.id)).status).toBe(200);

    const response = await answerWithProof(f, runId);

    expect(response.status).toBe(409);
    expect(await viewOfRun(f, runId)).toMatchObject({ status: 'needs_review', errorCode: 'playbook_changed_while_waiting' });
    expect(table.rows()).toHaveLength(0);
  });
});

const secretHolder = { id: 'holder', kind: 'http', method: 'GET', url: 'https://example.invalid/', headers: { 'X-Key': `{{secret:${SECRET_NAME}}}` } };
/** A playbook whose answer must read a secret: a manual cell, a write, and a never-taken edge to a cell that references the secret. */
const playbookWithASecret = async (f: GovernanceFixture, value: string, manualExtra: Record<string, unknown> = {}) => {
  const table = await makeTable(f);
  const neverTaken = [{ to: 'holder', when: [{ lhs: 'steps.gate.decision', op: 'eq', rhs: 'never' }] }];
  const playbook = await createApprovedPlaybook(f, [
    manualCell('gate', { prompt: 'Ship {{inputs.who}}?', ...manualExtra }), { ...writeCell('after', table.storeId, table.noteId, 'shipped'), next: neverTaken }, secretHolder,
  ], { inputs: [{ name: 'who', type: 'string', required: false }] });
  new SecretRefRepository(f.db).declare({ kind: 'playbook', id: playbook.id }, SECRET_NAME);
  await secretStore.set({ kind: 'playbook', id: playbook.id }, SECRET_NAME, value);
  return { playbook, table };
};

/** Holds every read of a secret until `release`: an answer then stops at the reading of its secrets, and the test acts in that window. */
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

describe('the answer is committed after the secrets are read, on what the playbook and the daemon are then', () => {
  it('cancels the answer of a playbook edited while its secrets are read, and puts the run in review', async () => {
    const f = await boot();
    const { playbook, table } = await playbookWithASecret(f, `dummy-canary-built-at-runtime-${randomUUID()}`);
    const runId = await runUntilParked(f, playbook.id, { who: 'v2' });
    const held = holdSecretReads();
    const answering = answerWithProof(f, runId);
    await held.reached(1);

    const edited = await f.api(`/api/playbooks/${playbook.id}`, { method: 'PUT', body: JSON.stringify({ expectedRev: playbook.contentRev, policy: { allowedHosts: ['example.test'] } }) });
    held.release();
    const response = await answering;

    expect(edited.status).toBe(200);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: 'playbook_unapproved' });
    expect(await viewOfRun(f, runId)).toMatchObject({ status: 'needs_review', errorCode: 'playbook_changed_while_waiting' });
    expect(table.rows()).toHaveLength(0);
  });

  it.each([['after', 61], ['at the very instant', 60]])('refuses an answer whose wait ends %s while its secrets are read: manual_wait_expired, and the run is not resumed', async (_when, secondsLate) => {
    const f = await boot();
    const { playbook, table } = await playbookWithASecret(f, `dummy-canary-built-at-runtime-${randomUUID()}`, { timeoutSeconds: 60 });
    const runId = await runUntilParked(f, playbook.id, { who: 'v2' });
    now += 30 * SECOND;
    const held = holdSecretReads();
    const answering = answerWithProof(f, runId);
    await held.reached(1);

    now = START_OF_TEST_TIME + secondsLate * SECOND;
    held.release();
    const response = await answering;

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: 'manual_wait_expired' });
    expect(await viewOfRun(f, runId)).toMatchObject({ status: 'failed', errorCode: 'manual_wait_expired' });
    expect(table.rows()).toHaveLength(0);
  });

  it('answers a wait that is still open one second before it ends, even when the secrets are slow', async () => {
    const f = await boot();
    const { playbook } = await playbookWithASecret(f, `dummy-canary-built-at-runtime-${randomUUID()}`, { timeoutSeconds: 60 });
    const runId = await runUntilParked(f, playbook.id, { who: 'v2' });
    const held = holdSecretReads();
    const answering = answerWithProof(f, runId);
    await held.reached(1);

    now = START_OF_TEST_TIME + 59 * SECOND;
    held.release();

    expect((await answering).status).toBe(200);
  });

  it('lets only one of two parked runs that answer together take the only place among the runs at once; the other stays parked, its question pending', async () => {
    const f = await boot({ maxConcurrentRuns: 1 });
    const first = await playbookWithASecret(f, `dummy-canary-built-at-runtime-${randomUUID()}`);
    const second = await playbookWithASecret(f, `dummy-canary-built-at-runtime-${randomUUID()}`);
    const firstRun = await runUntilParked(f, first.playbook.id, { who: 'a' });
    const secondRun = await runUntilParked(f, second.playbook.id, { who: 'b' });
    const held = holdSecretReads();
    const answers = Promise.all([answerWithProof(f, firstRun), answerWithProof(f, secondRun)]);
    await held.reached(2);

    held.release();
    const responses = await answers;

    const statuses = responses.map((response) => response.status).sort();
    expect(statuses).toEqual([200, 409]);
    const refused = responses.find((response) => response.status === 409)!;
    expect(await refused.json()).toMatchObject({ error: 'playbook_run_busy' });
    expect(f.db.prepare("SELECT COUNT(*) AS n FROM playbook_manual_requests WHERE status = 'pending'").get()).toEqual({ n: 1 });
    expect(f.db.prepare("SELECT COUNT(*) AS n FROM playbook_runs WHERE status = 'waiting_manual'").get()).toEqual({ n: 1 });
  });

  it('refuses an answer that loses the last place to a run started while its secrets are read, and leaves its question pending', async () => {
    const f = await boot({ maxConcurrentRuns: 1 });
    const { playbook } = await playbookWithASecret(f, `dummy-canary-built-at-runtime-${randomUUID()}`);
    const waiting = await createApprovedPlaybook(f, [{ id: 'wait', kind: 'waitFor', pollMs: 1000, predicate: [{ lhs: 'wait.elapsedMs', op: 'lt', rhs: 0 }] }]);
    const runId = await runUntilParked(f, playbook.id, { who: 'v2' });
    const held = holdSecretReads();
    const answering = answerWithProof(f, runId);
    await held.reached(1);

    const started = await startRun(f, waiting.id);
    held.release();
    const response = await answering;

    expect(started.status).toBe(202);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: 'playbook_run_busy' });
    expect(statusOfRun(f, runId)).toBe('waiting_manual');
    expect(f.db.prepare('SELECT status FROM playbook_manual_requests WHERE run_id = ?').get(runId)).toEqual({ status: 'pending' });
  });
});

describe('secrets', () => {

  it('persists no secret value while the run waits, even when an input and the prompt carry it', async () => {
    const f = await boot();
    const value = `dummy-canary-built-at-runtime-${randomUUID()}`;
    const { playbook } = await playbookWithASecret(f, value);

    const runId = await runUntilParked(f, playbook.id, { who: value });

    expect(persistedBy(f, ['playbook_runs', 'playbook_run_steps', 'playbook_manual_requests'])).not.toContain(value);
    expect(f.db.prepare('SELECT prompt_masked FROM playbook_manual_requests WHERE run_id = ?').get(runId)).toEqual({ prompt_masked: `Ship [secret:${SECRET_NAME}]?` });
  });

  it('resolves the secrets again at the answer: a secret cleared while waiting refuses the resume, and the run stays parked', async () => {
    const f = await boot();
    const { playbook } = await playbookWithASecret(f, `dummy-canary-built-at-runtime-${randomUUID()}`);
    const runId = await runUntilParked(f, playbook.id, { who: 'v2' });
    await secretStore.clear({ kind: 'playbook', id: playbook.id }, SECRET_NAME);

    const response = await answerWithProof(f, runId);

    expect(await response.json()).toMatchObject({ error: 'secret_not_connected_on_this_device' });
    expect(statusOfRun(f, runId)).toBe('waiting_manual');
  });
});

describe('a boot', () => {
  it('keeps a parked run parked, and still marks a step found running as needs_review', async () => {
    const f = await boot();
    const playbook = await createApprovedPlaybook(f, [manualCell('gate')]);
    const runId = await runUntilParked(f, playbook.id);
    f.db.prepare("INSERT INTO playbook_runs (id, playbook_id, playbook_rev, flow_sha256, status, inputs_json, actor_kind, started_at) VALUES ('crashed', ?, 1, 'x', 'running', '{}', 'admin', 'now')").run(playbook.id);

    const interrupted = f.daemon.playbookRunner.recover();

    expect(interrupted).toBe(1);
    expect(statusOfRun(f, runId)).toBe('waiting_manual');
    expect(statusOfRun(f, 'crashed')).toBe('needs_review');
  });

  it('lets the human answer a run that was parked before the boot', async () => {
    const f = await boot();
    const table = await makeTable(f);
    const playbook = await createApprovedPlaybook(f, [manualCell('gate'), writeCell('after', table.storeId, table.noteId, 'shipped')]);
    const runId = await runUntilParked(f, playbook.id);
    f.daemon.playbookRunner.recover();

    expect((await answerWithProof(f, runId)).status).toBe(200);

    await eventually(f, runId, 'succeeded');
    expect(table.rows()).toHaveLength(1);
  });
});

describe('the forEach iterations of a run are counted across an answer to a manual step', () => {
  const quickWait = (id: string, extra: Record<string, unknown> = {}) => ({ id, kind: 'waitFor', predicate: [{ lhs: 'wait.elapsedMs', op: 'gte', rhs: 0 }], ...extra });

  it('refuses a second batch that the iterations already journaled before the answer leave no room for', async () => {
    const f = await boot({ maxForEachIterations: 3 });
    const playbook = await createApprovedPlaybook(f, [
      quickWait('start', { next: [{ to: 'one', forEach: 'inputs.items' }] }),
      quickWait('one', { next: [{ to: 'ask' }] }),
      manualCell('ask', { next: [{ to: 'two', forEach: 'inputs.items' }] }),
      quickWait('two'),
    ], { inputs: [{ name: 'items', type: 'json', required: false }] });
    const runId = await runUntilParked(f, playbook.id, { items: [1, 2] });

    expect((await answerWithProof(f, runId, 4)).status).toBe(200);

    const run = await eventually(f, runId, 'failed');
    expect(run).toMatchObject({ errorCode: 'for_each_limit_exceeded' });
    expect(run.steps.filter((step) => step.stepId === 'two')).toHaveLength(0);
  });
});

describe('the budget of the tree of a run holds across an answer to a manual step', () => {
  const quickWait = (id: string, extra: Record<string, unknown> = {}) => ({ id, kind: 'waitFor', predicate: [{ lhs: 'wait.elapsedMs', op: 'gte', rhs: 0 }], ...extra });
  const ITEMS_INPUT = [{ name: 'items', type: 'json', required: false }];
  const MANUAL_STEP_SEQ = 5;

  /** A root that calls the same leaf for each of 3 items, asks a human, then calls it again for each of the 3 items: its journal holds start, one, one, one, ask (5 steps) before the answer. */
  const rootCallingALeafOnBothSidesOfAQuestion = async (f: GovernanceFixture) => {
    const leaf = await createApprovedPlaybook(f, [quickWait('leaf')]);
    const root = await createApprovedPlaybook(f, [
      quickWait('start', { next: [{ to: 'one', forEach: 'inputs.items' }] }),
      { id: 'one', kind: 'subPlaybook', playbookId: leaf.id, next: [{ to: 'ask' }] },
      manualCell('ask', { next: [{ to: 'two', forEach: 'inputs.items' }] }),
      { id: 'two', kind: 'subPlaybook', playbookId: leaf.id },
    ], { inputs: ITEMS_INPUT });
    return { leaf, root };
  };
  const runsOf = (f: GovernanceFixture, playbookId: string) => (f.db.prepare('SELECT COUNT(*) AS n FROM playbook_runs WHERE playbook_id = ?').get(playbookId) as { n: number }).n;
  const stepsOfAllRuns = (f: GovernanceFixture) => (f.db.prepare('SELECT COUNT(*) AS n FROM playbook_run_steps').get() as { n: number }).n;

  it('counts the children started before the answer among the children a root may start', async () => {
    const f = await boot({ maxChildRunsPerRoot: 4 });
    const { leaf, root } = await rootCallingALeafOnBothSidesOfAQuestion(f);
    const runId = await runUntilParked(f, root.id, { items: [1, 2, 3] });

    expect((await answerWithProof(f, runId, MANUAL_STEP_SEQ)).status).toBe(200);

    const run = await eventually(f, runId, 'failed');
    expect(runsOf(f, leaf.id)).toBe(4);
    expect(run.steps.at(-1)).toMatchObject({ stepId: 'two', status: 'failed', errorCode: 'sub_playbook_limit_exceeded' });
  });

  it('counts the steps of the children run before the answer among the step executions of the tree', async () => {
    const f = await boot({ maxStepExecutions: 9 });
    const { root } = await rootCallingALeafOnBothSidesOfAQuestion(f);
    const runId = await runUntilParked(f, root.id, { items: [1, 2, 3] });

    expect((await answerWithProof(f, runId, MANUAL_STEP_SEQ)).status).toBe(200);

    await eventually(f, runId, 'failed');
    expect(stepsOfAllRuns(f)).toBeLessThanOrEqual(9);
  });

  it('keeps the count of a root that waited across a boot, whatever the runs of its children became', async () => {
    const f = await boot({ maxChildRunsPerRoot: 4 });
    const { leaf, root } = await rootCallingALeafOnBothSidesOfAQuestion(f);
    const runId = await runUntilParked(f, root.id, { items: [1, 2, 3] });
    f.db.prepare('DELETE FROM playbook_runs WHERE playbook_id = ?').run(leaf.id);
    f.daemon.playbookRunner.recover();

    expect((await answerWithProof(f, runId, MANUAL_STEP_SEQ)).status).toBe(200);

    const run = await eventually(f, runId, 'failed');
    expect(runsOf(f, leaf.id)).toBe(1);
    expect(run.steps.at(-1)).toMatchObject({ stepId: 'two', errorCode: 'sub_playbook_limit_exceeded' });
  });
});

describe('a playbook with a run that waits for a human cannot be deleted', () => {
  it('refuses the deletion with playbook_run_busy while the run waits, and allows it once the run is rejected', async () => {
    const f = await boot();
    const playbook = await createApprovedPlaybook(f, [manualCell('gate')]);
    const runId = await runUntilParked(f, playbook.id);
    const deletion = () => f.api(`/api/playbooks/${playbook.id}?expectedRev=${playbook.contentRev}`, { method: 'DELETE' });

    const whileWaiting = await deletion();
    expect((await answerWithProof(f, runId, 1, 'reject')).status).toBe(200);
    const afterTheEnd = await deletion();

    expect(whileWaiting.status).toBe(409);
    expect(await whileWaiting.json()).toMatchObject({ error: 'playbook_run_busy' });
    expect(afterTheEnd.status).toBe(200);
  });

  it('deletes the playbook when the first operation after the end of the wait is the deletion: the overdue wait is ended first', async () => {
    const f = await boot();
    const playbook = await createApprovedPlaybook(f, [manualCell('gate', { timeoutSeconds: 60 })]);
    const runId = await runUntilParked(f, playbook.id);
    now += 61 * SECOND;

    const deletion = await f.api(`/api/playbooks/${playbook.id}?expectedRev=${playbook.contentRev}`, { method: 'DELETE' });

    expect(deletion.status).toBe(200);
    expect(f.db.prepare('SELECT COUNT(*) AS n FROM playbook_runs WHERE id = ?').get(runId)).toEqual({ n: 0 });
  });
});

describe('the tree budget journaled when the run parked is validated when the answer reads it back', () => {
  const PARKED_STEP_SEQ = 1;
  const INCONSISTENT_JOURNAL = 'parked_tree_budget_invalid';
  const journalTheParkedOutput = (f: GovernanceFixture, runId: string, output: unknown) =>
    f.db.prepare('UPDATE playbook_run_steps SET output_json_masked = ? WHERE run_id = ? AND seq = ?').run(JSON.stringify(output), runId, PARKED_STEP_SEQ);
  const parkedWith = async (output: unknown) => {
    const f = await boot();
    const table = await makeTable(f);
    const playbook = await createApprovedPlaybook(f, [manualCell('gate'), writeCell('after', table.storeId, table.noteId, 'shipped')]);
    const runId = await runUntilParked(f, playbook.id);
    journalTheParkedOutput(f, runId, output);
    return { f, runId, table };
  };

  it.each([
    ['a budget inside the bounds', { treeBudget: { stepsExecuted: 1, childrenStarted: 0 } }],
    ['a budget exactly on the caps', { treeBudget: { stepsExecuted: 1000, childrenStarted: 100 } }],
    ['no budget (a run parked before the budget was journaled)', {}],
  ])('resumes the run with %s', async (_what, output) => {
    const { f, runId } = await parkedWith(output);

    const response = await answerWithProof(f, runId);

    expect(response.status).toBe(200);
  });

  it('resumes from the steps of the run itself when the budget is absent', async () => {
    const { f, runId, table } = await parkedWith({});

    await answerWithProof(f, runId);

    await eventually(f, runId, 'succeeded');
    expect(table.rows()).toHaveLength(1);
  });

  it.each([
    ['a negative count of steps', { stepsExecuted: -1, childrenStarted: 0 }],
    ['a negative count of children', { stepsExecuted: 1, childrenStarted: -1 }],
    ['a count of steps over the cap', { stepsExecuted: 1001, childrenStarted: 0 }],
    ['a count of children over the cap', { stepsExecuted: 1, childrenStarted: 101 }],
    ['a count that is not an integer', { stepsExecuted: 1.5, childrenStarted: 0 }],
    ['a budget with a missing count', { stepsExecuted: 1 }],
    ['a budget that is not an object', 'many'],
  ])('puts the run in review and writes nothing on %s', async (_what, treeBudget) => {
    const { f, runId, table } = await parkedWith({ treeBudget });

    const response = await answerWithProof(f, runId);

    expect(response.ok).toBe(false);
    expect(await viewOfRun(f, runId)).toMatchObject({ status: 'needs_review', errorCode: INCONSISTENT_JOURNAL });
    expect(f.db.prepare('SELECT status FROM playbook_manual_requests WHERE run_id = ?').get(runId)).toEqual({ status: 'cancelled' });
    expect(table.rows()).toHaveLength(0);
  });
});

describe('a secret that cannot be masked at the answer refuses the answer without consuming it', () => {
  const UNMASKABLE_VALUE = 'ab';
  const SINGLE_PLACE = { maxConcurrentRuns: 1 };

  it('leaves the question pending and the run waiting, frees the place, and accepts the answer once the secret is maskable again', async () => {
    const f = await boot(SINGLE_PLACE);
    const secretValue = `dummy-canary-built-at-runtime-${randomUUID()}`;
    const { playbook, table } = await playbookWithASecret(f, secretValue);
    const runId = await runUntilParked(f, playbook.id, { who: 'v2' });
    await secretStore.set({ kind: 'playbook', id: playbook.id }, SECRET_NAME, UNMASKABLE_VALUE);

    const refused = await answerWithProof(f, runId);

    expect(refused.ok).toBe(false);
    expect(await viewOfRun(f, runId)).toMatchObject({ status: 'waiting_manual', errorCode: null });
    expect(f.db.prepare('SELECT status FROM playbook_manual_requests WHERE run_id = ?').get(runId)).toEqual({ status: 'pending' });
    const another = await createApprovedPlaybook(f, [manualCell('gate')]);
    expect((await startRun(f, another.id)).status).toBe(202);

    await secretStore.set({ kind: 'playbook', id: playbook.id }, SECRET_NAME, secretValue);
    expect((await answerWithProof(f, runId)).status).toBe(200);
    await eventually(f, runId, 'succeeded');
    expect(table.rows()).toHaveLength(1);
  });

  describe('the refusals of the answer keep their order when the secret turns out too short after a slow read', () => {
    const answeringWithASecretThatBecomesUnmaskable = async (manualExtra: Record<string, unknown> = {}) => {
      const f = await boot();
      const { playbook } = await playbookWithASecret(f, `dummy-canary-built-at-runtime-${randomUUID()}`, manualExtra);
      const runId = await runUntilParked(f, playbook.id, { who: 'v2' });
      const held = holdSecretReads();
      const answering = answerWithProof(f, runId);
      await held.reached(1);
      await secretStore.set({ kind: 'playbook', id: playbook.id }, SECRET_NAME, UNMASKABLE_VALUE);
      return { f, playbook, runId, held, answering };
    };

    it('answers manual_wait_expired, and ends the run, when the wait ended while the secret was read', async () => {
      const { f, runId, held, answering } = await answeringWithASecretThatBecomesUnmaskable({ timeoutSeconds: 60 });

      now = START_OF_TEST_TIME + 61 * SECOND;
      held.release();
      const response = await answering;

      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ error: 'manual_wait_expired' });
      expect(await viewOfRun(f, runId)).toMatchObject({ status: 'failed', errorCode: 'manual_wait_expired' });
    });

    it('answers playbook_unapproved, and puts the run in review, when the playbook was edited while the secret was read', async () => {
      const { f, playbook, runId, held, answering } = await answeringWithASecretThatBecomesUnmaskable();

      await f.api(`/api/playbooks/${playbook.id}`, { method: 'PUT', body: JSON.stringify({ expectedRev: playbook.contentRev, policy: { allowedHosts: ['example.test'] } }) });
      held.release();
      const response = await answering;

      expect(await response.json()).toMatchObject({ error: 'playbook_unapproved' });
      expect(await viewOfRun(f, runId)).toMatchObject({ status: 'needs_review', errorCode: 'playbook_changed_while_waiting' });
    });

    it('answers manual_already_answered when another decision closed the question while the secret was read', async () => {
      const { f, runId, held, answering } = await answeringWithASecretThatBecomesUnmaskable();

      expect((await answerWithProof(f, runId, 1, 'reject')).status).toBe(200);
      held.release();
      const response = await answering;

      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ error: 'manual_already_answered' });
    });
  });
});

describe('the tree budget read back from an unreadable or unexpected journal', () => {
  const PARKED_STEP_SEQ = 1;
  const parkedWithRawOutput = async (rawOutput: string | null) => {
    const f = await boot();
    const table = await makeTable(f);
    const playbook = await createApprovedPlaybook(f, [manualCell('gate'), writeCell('after', table.storeId, table.noteId, 'shipped')]);
    const runId = await runUntilParked(f, playbook.id);
    f.db.prepare('UPDATE playbook_run_steps SET output_json_masked = ? WHERE run_id = ? AND seq = ?').run(rawOutput, runId, PARKED_STEP_SEQ);
    return { f, runId, table };
  };

  it('rejects the question even when the journal of the parked step cannot be read', async () => {
    const { f, runId } = await parkedWithRawOutput('{not json');

    const response = await answerWithProof(f, runId, PARKED_STEP_SEQ, 'reject');

    expect(response.status).toBe(200);
    expect(await viewOfRun(f, runId)).toMatchObject({ status: 'failed', errorCode: 'manual_rejected' });
  });

  it('puts the run in review, and closes the question, when an approval finds a journal that cannot be read', async () => {
    const { f, runId, table } = await parkedWithRawOutput('{not json');

    const response = await answerWithProof(f, runId);

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: 'manual_already_answered' });
    expect(f.db.prepare('SELECT status, error_code FROM playbook_runs WHERE id = ?').get(runId)).toEqual({ status: 'needs_review', error_code: 'parked_tree_budget_invalid' });
    expect(f.db.prepare('SELECT status FROM playbook_manual_requests WHERE run_id = ?').get(runId)).toEqual({ status: 'cancelled' });
    expect(table.rows()).toHaveLength(0);
  });

  it.each([['an array', '[]'], ['a text', '"budget"'], ['a number', '7'], ['a boolean', 'true']])('puts the run in review when the journal of the parked step is %s', async (_what, rawOutput) => {
    const { f, runId, table } = await parkedWithRawOutput(rawOutput);

    const response = await answerWithProof(f, runId);

    expect(response.ok).toBe(false);
    expect(await viewOfRun(f, runId)).toMatchObject({ status: 'needs_review', errorCode: 'parked_tree_budget_invalid' });
    expect(table.rows()).toHaveLength(0);
  });

  it('still resumes a run parked before the budget was journaled: no output at all', async () => {
    const { f, runId } = await parkedWithRawOutput(null);

    expect((await answerWithProof(f, runId)).status).toBe(200);
  });
});

describe('a refused deletion of a playbook settles no wait of another project', () => {
  const parkedInAnotherProjectAndOverdue = async () => {
    const f = await boot();
    const foreign = await createApprovedPlaybook(f, [manualCell('gate', { timeoutSeconds: 60 })], { projectId: OTHER_PROJECT_ID });
    const foreignRunId = await runUntilParked(f, foreign.id);
    const own = await createApprovedPlaybook(f, [manualCell('gate')]);
    now = START_OF_TEST_TIME + 61 * SECOND;
    return { f, foreignRunId, own };
  };

  it('leaves the overdue wait of another project as it is when the revision of the deletion is stale', async () => {
    const { f, foreignRunId, own } = await parkedInAnotherProjectAndOverdue();

    const refused = await f.api(`/api/playbooks/${own.id}?expectedRev=${own.contentRev + 5}`, { method: 'DELETE' });

    expect(refused.status).toBe(409);
    expect(statusOfRun(f, foreignRunId)).toBe('waiting_manual');
  });

  it('leaves the overdue wait of another project as it is when the deletion succeeds', async () => {
    const { f, foreignRunId, own } = await parkedInAnotherProjectAndOverdue();

    const deleted = await f.api(`/api/playbooks/${own.id}?expectedRev=${own.contentRev}`, { method: 'DELETE' });

    expect(deleted.status).toBe(200);
    expect(statusOfRun(f, foreignRunId)).toBe('waiting_manual');
  });
});

describe('an answer whose resume cannot be prepared leaves no run behind', () => {
  it('puts the run in review, closes the question and frees the place when the journal of an earlier step is unreadable', async () => {
    const f = await boot({ maxConcurrentRuns: 1 });
    const playbook = await createApprovedPlaybook(f, [manualCell('first'), manualCell('second')]);
    const other = await createApprovedPlaybook(f, [manualCell('gate')]);
    const runId = await runUntilParked(f, playbook.id);
    expect((await answerWithProof(f, runId, 1)).status).toBe(200);
    await until(() => (f.db.prepare('SELECT COUNT(*) AS n FROM playbook_manual_requests WHERE run_id = ?').get(runId) as { n: number }).n === 2);
    await until(() => statusOfRun(f, runId) === 'waiting_manual');
    f.db.prepare("UPDATE playbook_run_steps SET output_json_masked = '{not json' WHERE run_id = ? AND seq = 1").run(runId);

    const response = await answerWithProof(f, runId, 2);

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: 'playbook_conflict' });
    expect(statusOfRun(f, runId)).toBe('needs_review');
    expect(f.db.prepare('SELECT error_code FROM playbook_runs WHERE id = ?').get(runId)).toEqual({ error_code: 'resume_preparation_failed' });
    expect(f.db.prepare('SELECT status FROM playbook_manual_requests WHERE run_id = ? AND seq = 2').get(runId)).toEqual({ status: 'cancelled' });
    expect((await startRun(f, other.id)).status).toBe(202);
  });

  describe('when the journal of the parked step does not point at the manual cell of the flow', () => {
    const parkedWithTheJournalEdited = async (edit: (f: GovernanceFixture, runId: string) => void) => {
      const f = await boot();
      const table = await makeTable(f);
      const playbook = await createApprovedPlaybook(f, [manualCell('gate'), writeCell('after', table.storeId, table.noteId, 'shipped')]);
      const runId = await runUntilParked(f, playbook.id);
      edit(f, runId);
      return { f, runId, table };
    };
    const expectTheRunInReviewWithTheQuestionClosed = async ({ f, runId, table }: Awaited<ReturnType<typeof parkedWithTheJournalEdited>>) => {
      const response = await answerWithProof(f, runId, 1);

      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ error: 'playbook_conflict' });
      expect(f.db.prepare('SELECT status, error_code FROM playbook_runs WHERE id = ?').get(runId)).toEqual({ status: 'needs_review', error_code: 'resume_preparation_failed' });
      expect(f.db.prepare('SELECT status FROM playbook_manual_requests WHERE run_id = ? AND seq = 1').get(runId)).toEqual({ status: 'cancelled' });
      expect(table.rows()).toHaveLength(0);
    };

    it('puts the run in review when the journal no longer holds the parked step', async () => {
      const parked = await parkedWithTheJournalEdited((f, runId) => {
        f.db.exec('PRAGMA foreign_keys = OFF');
        f.db.prepare('UPDATE playbook_run_steps SET seq = 99 WHERE run_id = ? AND seq = 1').run(runId);
        f.db.exec('PRAGMA foreign_keys = ON');
      });

      await expectTheRunInReviewWithTheQuestionClosed(parked);
    });

    it('puts the run in review when the parked step names a cell the flow does not hold', async () => {
      const parked = await parkedWithTheJournalEdited((f, runId) => {
        f.db.prepare("UPDATE playbook_run_steps SET step_id = 'ghost' WHERE run_id = ? AND seq = 1").run(runId);
      });

      await expectTheRunInReviewWithTheQuestionClosed(parked);
    });

    it('puts the run in review when the parked step names a cell that is not a manual cell', async () => {
      const parked = await parkedWithTheJournalEdited((f, runId) => {
        f.db.prepare("UPDATE playbook_run_steps SET step_id = 'after' WHERE run_id = ? AND seq = 1").run(runId);
      });

      await expectTheRunInReviewWithTheQuestionClosed(parked);
    });
  });
});

describe('the answer of a rejection does not depend on the retention of runs', () => {
  it('answers the rejected run even when the retention of the playbook purged it as soon as it ended', async () => {
    const f = await boot();
    const playbook = await createApprovedPlaybook(f, [manualCell('gate')], { policy: { maxRunsToKeep: 1 } });
    const olderRunId = await runUntilParked(f, playbook.id);
    f.db.prepare("INSERT INTO playbook_runs (id, playbook_id, playbook_rev, flow_sha256, status, inputs_json, actor_kind, started_at, ended_at) VALUES ('newer', ?, 1, 'sha', 'succeeded', '{}', 'admin', '2999-01-01T00:00:00.000Z', '2999-01-01T00:00:01.000Z')").run(playbook.id);

    const response = await answerWithProof(f, olderRunId, 1, 'reject');

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ id: olderRunId, status: 'failed', errorCode: 'manual_rejected' });
    expect(f.db.prepare('SELECT 1 FROM playbook_runs WHERE id = ?').get(olderRunId)).toBeUndefined();
  });
});

describe('the approval of the playbook is checked again when the wait ends while it is checked', () => {
  it('answers manual_wait_expired and ends the run as failed, instead of announcing a review that the journal does not hold', async () => {
    const f = await boot();
    const playbook = await createApprovedPlaybook(f, [manualCell('gate', { timeoutSeconds: 60 }), manualCell('after')]);
    const runId = await runUntilParked(f, playbook.id);
    const edited = await f.api(`/api/playbooks/${playbook.id}`, { method: 'PUT', body: JSON.stringify({ expectedRev: playbook.contentRev, policy: { allowedHosts: ['example.test'] } }) });
    expect(edited.status).toBe(200);
    const approvals = (f.daemon.playbookRunner as unknown as { deps: { approvals: { assertStillApproved: (playbook: unknown) => unknown } } }).deps.approvals;
    const verifyTheApproval = approvals.assertStillApproved.bind(approvals);
    approvals.assertStillApproved = (checked) => {
      now = START_OF_TEST_TIME + 61 * SECOND;
      return verifyTheApproval(checked);
    };

    const response = await answerWithProof(f, runId);

    expect(await response.json()).toMatchObject({ error: 'manual_wait_expired' });
    expect(f.db.prepare('SELECT status FROM playbook_manual_requests WHERE run_id = ?').get(runId)).toEqual({ status: 'expired' });
    expect(f.db.prepare('SELECT status, error_code FROM playbook_runs WHERE id = ?').get(runId)).toEqual({ status: 'failed', error_code: 'manual_wait_expired' });
  });
});
