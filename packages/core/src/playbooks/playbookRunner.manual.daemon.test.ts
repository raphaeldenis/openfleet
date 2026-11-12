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

const boot = async (limits: { maxConcurrentRuns?: number; maxRunsNeedingReview?: number; maxParkedRunsPerProject?: number } = {}) => {
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
