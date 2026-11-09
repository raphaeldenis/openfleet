import { afterEach, describe, expect, it } from 'vitest';
import { OTHER_PROJECT_ID, OWN_PROJECT_ID, startGovernanceFixture, type GovernanceFixture } from '../governance/governanceQueue.testkit.js';
import { createInMemorySecretStore, type InMemorySecretStore } from '../secrets/inMemorySecretStore.js';
import { SecretRefRepository } from '../secrets/secretRefRepository.js';
import { PlaybookRepository } from './playbookRepository.js';

/*
 * Guards of the store cells, each with the test that fails when the guard is removed (replay: break the line, run this file, restore).
 *  1. project boundary     playbookStoreCells.ts `projectId: playbook.projectId` -> 'refuses a table of another project ...' (read and write)
 *  2. untrusted identifier TemplateSlot 'store_identifier' -> 'never lets the output of a step into a table or column ...', 'refuses at save ...'
 *  3. read bounds          READ_ROW_CAP / DEFAULT_READ_ROWS / MAX_READ_OUTPUT_CHARS -> 'reads at most ...', 'reads 100 rows when the cell sets no limit', 'refuses to answer rows that outgrow the output cap'
 *  4. attribution          PLAYBOOK_RUN_ACTOR -> 'writes the row as the playbook run and keeps its history'
 *  5. kinds                assertCellsCanRun -> 'refuses a tool cell ...'
 *  6. masking              `masker.mask` on written values -> 'masks the value of a secret before it is written'
 *  7. no replay            recover() -> 'never writes again a store step found running at boot'
 *  8. no row data leaks    failure codes only -> 'puts no row data in the activity log', 'a refused read keeps no row data'
 */
type RunView = {
  id: string; status: string; errorCode: string | null;
  steps: { seq: number; stepId: string; status: string; errorCode: string | null; output: Record<string, unknown> | null }[];
};

let fixture: GovernanceFixture | undefined;
let secretStore: InMemorySecretStore;
afterEach(async () => {
  await fixture?.close();
  fixture = undefined;
});

const READ_ROW_CAP = 1000;
const DEFAULT_READ_ROWS = 100;
const SECRET_NAME = 'STORE_SECRET';
const ROW_CANARY = 'row-canary-built-at-runtime';

const boot = async () => {
  secretStore = createInMemorySecretStore();
  fixture = await startGovernanceFixture({ secrets: { store: secretStore } });
  return fixture;
};

const jsonOf = async <T>(response: Response) => await response.json() as T;
const createPlaybook = async (f: GovernanceFixture, cells: Record<string, unknown>[], extra: Record<string, unknown> = {}) =>
  jsonOf<{ id: string }>(await f.api('/api/playbooks', { method: 'POST', body: JSON.stringify({ projectId: OWN_PROJECT_ID, name: 'P', cells, ...extra }) }));
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
const waitUntil = async (what: string, isDone: () => boolean | Promise<boolean>, timeoutMs = 15_000) => {
  const deadline = Date.now() + timeoutMs;
  while (!(await isDone())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};
const runToTheEnd = async (f: GovernanceFixture, playbookId: string, inputs: Record<string, unknown> = {}) => {
  const started = await f.api(`/api/playbooks/${playbookId}/run`, { method: 'POST', body: JSON.stringify({ inputs }) });
  expect(started.status).toBe(202);
  const { id } = await jsonOf<RunView>(started);
  await waitUntil('the run to end', async () => (await viewOfRun(f, id)).status !== 'running');
  return viewOfRun(f, id);
};
const persistedBy = (f: GovernanceFixture, tables: string[]) => JSON.stringify(tables.map((table) => f.db.prepare(`SELECT * FROM ${table}`).all()));

const human = { kind: 'human', label: 'tester' } as const;
/** A table of the project with a text column `name` and a text column `note`; rows go in through the real service of the daemon. */
const makeTable = async (f: GovernanceFixture, projectId = OWN_PROJECT_ID, extraColumns: { displayName: string; columnType: 'text' | 'number' }[] = []) => {
  const storeId = await f.createTable(projectId, `T-${Math.random().toString(36).slice(2)}`);
  const columnOf = (displayName: string, columnType: 'text' | 'number' = 'text') => f.daemon.stores.addColumn(storeId, { projectId, displayName, columnType }).id;
  const nameId = columnOf('name');
  const noteId = columnOf('note');
  const extraIds = extraColumns.map((column) => columnOf(column.displayName, column.columnType));
  const insert = (cells: Record<string, string>) => f.daemon.stores.insertRow(storeId, { projectId, actor: human, data: Object.fromEntries(Object.entries(cells).map(([column, value]) => [column === 'name' ? nameId : noteId, value])) });
  return { storeId, nameId, noteId, extraIds, insert, rows: () => f.daemon.stores.query(storeId, { projectId }) };
};
const readCell = (id: string, storeID: string, extra: Record<string, unknown> = {}) => ({ id, kind: 'readFromStore', storeID, ...extra });
const writeCell = (id: string, storeID: string, rowMappings: Record<string, string>, extra: Record<string, unknown> = {}) => ({ id, kind: 'writeToStore', storeID, rowMappings, ...extra });

describe('a readFromStore cell reads the table of the project of the playbook', () => {
  it('answers the rows, the columns asked for, filtered and sorted', async () => {
    const f = await boot();
    const table = await makeTable(f);
    table.insert({ name: 'b', note: 'second' });
    table.insert({ name: 'a', note: 'first' });
    table.insert({ name: 'b', note: 'third' });
    const playbook = await createApprovedPlaybook(f, [readCell('read', table.storeId, { columns: [table.noteId], whereColumnID: table.nameId, whereValue: 'b', sortColumnID: table.noteId, sortDescending: true })]);

    const run = await runToTheEnd(f, playbook.id);

    const [step] = run.steps;
    expect(run.status).toBe('succeeded');
    expect(step?.output?.['rowCount']).toBe(2);
    expect((JSON.parse(step?.output?.['output'] as string) as { data: unknown }[]).map((row) => row.data)).toEqual([{ [table.noteId]: 'third' }, { [table.noteId]: 'second' }]);
  });

  it('lets a later step read the number of rows', async () => {
    const f = await boot();
    const table = await makeTable(f);
    table.insert({ name: 'a', note: 'x' });
    const playbook = await createApprovedPlaybook(f, [
      readCell('read', table.storeId, { next: [{ to: 'never', when: [{ lhs: 'steps.read.rowCount', op: 'eq', rhs: '0' }] }, { to: 'after' }] }),
      writeCell('never', table.storeId, { [table.nameId]: 'skipped' }),
      writeCell('after', table.storeId, { [table.nameId]: 'count-{{steps.read.rowCount}}' }),
    ]);

    const run = await runToTheEnd(f, playbook.id);

    expect(run.steps.map((step) => step.stepId)).toEqual(['read', 'after']);
    expect(table.rows().map((row) => row.data[table.nameId])).toContain('count-1');
  });

  it('refuses a table of another project, answers no row and says nothing of the rows', async () => {
    const f = await boot();
    const foreign = await makeTable(f, OTHER_PROJECT_ID);
    foreign.insert({ name: ROW_CANARY, note: 'secret of the other project' });
    const playbook = await createApprovedPlaybook(f, [readCell('read', foreign.storeId)]);

    const run = await runToTheEnd(f, playbook.id);

    expect(run).toMatchObject({ status: 'failed', errorCode: 'store_not_in_project' });
    expect(persistedBy(f, ['playbook_runs', 'playbook_run_steps', 'activity_log'])).not.toContain(ROW_CANARY);
  });

  it('answers the same code for a table that does not exist', async () => {
    const f = await boot();
    const playbook = await createApprovedPlaybook(f, [readCell('read', 'no-such-table')]);

    const run = await runToTheEnd(f, playbook.id);

    expect(run).toMatchObject({ status: 'failed', errorCode: 'store_not_in_project' });
  });

  it('refuses a column the table does not have', async () => {
    const f = await boot();
    const table = await makeTable(f);
    const playbook = await createApprovedPlaybook(f, [readCell('read', table.storeId, { columns: ['no-such-column'] })]);

    const run = await runToTheEnd(f, playbook.id);

    expect(run).toMatchObject({ status: 'failed', errorCode: 'store_column_unknown' });
  });

  it('refuses a filter that names a column without a value, which would read every row', async () => {
    const f = await boot();
    const table = await makeTable(f);
    table.insert({ name: ROW_CANARY, note: 'x' });
    const playbook = await createApprovedPlaybook(f, [readCell('read', table.storeId, { whereColumnID: table.nameId })]);

    const run = await runToTheEnd(f, playbook.id);

    expect(run).toMatchObject({ status: 'failed', errorCode: 'store_filter_incomplete' });
    expect(persistedBy(f, ['playbook_run_steps'])).not.toContain(ROW_CANARY);
  });

  it(`reads ${DEFAULT_READ_ROWS} rows when the cell sets no limit`, async () => {
    const f = await boot();
    const table = await makeTable(f);
    f.daemon.stores.insertRows(table.storeId, { projectId: OWN_PROJECT_ID, actor: human, items: Array.from({ length: DEFAULT_READ_ROWS + 50 }, (_, index) => ({ [table.nameId]: `row-${index}` })) });
    const playbook = await createApprovedPlaybook(f, [readCell('read', table.storeId)]);

    const run = await runToTheEnd(f, playbook.id);

    expect(run.steps[0]?.output?.['rowCount']).toBe(DEFAULT_READ_ROWS);
  });

  it(`reads at most ${READ_ROW_CAP} rows, whatever limit the cell asks for`, async () => {
    const f = await boot();
    const table = await makeTable(f);
    f.daemon.stores.insertRows(table.storeId, { projectId: OWN_PROJECT_ID, actor: human, items: Array.from({ length: READ_ROW_CAP + 5 }, (_, index) => ({ [table.nameId]: String(index) })) });
    const playbook = await createApprovedPlaybook(f, [readCell('read', table.storeId, { limit: 10_000, columns: [table.nameId] })]);

    const run = await runToTheEnd(f, playbook.id);

    expect(run.steps[0]?.output?.['rowCount']).toBe(READ_ROW_CAP);
  });

  it('refuses to answer rows that outgrow the output cap, and keeps none of them', async () => {
    const f = await boot();
    const table = await makeTable(f);
    const bigCell = 'x'.repeat(60 * 1024);
    for (let index = 0; index < 6; index += 1) table.insert({ name: `${ROW_CANARY}-${index}`, note: bigCell });
    const playbook = await createApprovedPlaybook(f, [readCell('read', table.storeId)]);

    const run = await runToTheEnd(f, playbook.id);

    expect(run).toMatchObject({ status: 'failed', errorCode: 'store_read_too_large' });
    expect(persistedBy(f, ['playbook_runs', 'playbook_run_steps', 'activity_log'])).not.toContain(ROW_CANARY);
  });

  it('puts no row data in the activity log', async () => {
    const f = await boot();
    const table = await makeTable(f);
    table.insert({ name: ROW_CANARY, note: 'x' });
    const playbook = await createApprovedPlaybook(f, [readCell('read', table.storeId)]);

    await runToTheEnd(f, playbook.id);

    expect(persistedBy(f, ['activity_log'])).not.toContain(ROW_CANARY);
  });

  it('masks the value of a secret held by a row before the step is stored', async () => {
    const f = await boot();
    const secretValue = `dummy-canary-built-at-runtime-${Date.now()}`;
    const table = await makeTable(f);
    table.insert({ name: 'leaky', note: `before ${secretValue} after` });
    const playbook = await createApprovedPlaybook(f, [
      readCell('read', table.storeId, { next: [{ to: 'holder', when: [{ lhs: 'steps.read.rowCount', op: 'eq', rhs: '-1' }] }] }),
      { id: 'holder', kind: 'http', method: 'GET', url: 'https://example.invalid/', headers: { 'X-Key': `{{secret:${SECRET_NAME}}}` } },
    ]);
    new SecretRefRepository(f.db).declare({ kind: 'playbook', id: playbook.id }, SECRET_NAME);
    await secretStore.set({ kind: 'playbook', id: playbook.id }, SECRET_NAME, secretValue);

    const run = await runToTheEnd(f, playbook.id);

    expect(run.status).toBe('succeeded');
    expect(persistedBy(f, ['playbook_runs', 'playbook_run_steps'])).not.toContain(secretValue);
    expect(run.steps[0]?.output?.['output']).toContain(`[secret:${SECRET_NAME}]`);
  });
});

describe('a writeToStore cell writes one row into the table of the project of the playbook', () => {
  it('writes the row as the playbook run and keeps its history', async () => {
    const f = await boot();
    const table = await makeTable(f);
    const playbook = await createApprovedPlaybook(f, [writeCell('write', table.storeId, { [table.nameId]: 'from {{inputs.who}}', [table.noteId]: 'fixed' })], { inputs: [{ name: 'who', type: 'string', required: true }] });

    const run = await runToTheEnd(f, playbook.id, { who: 'alice' });

    expect(run).toMatchObject({ status: 'succeeded', steps: [{ stepId: 'write', output: { outcome: 'inserted' } }] });
    expect(table.rows().map((row) => row.data)).toEqual([{ [table.nameId]: 'from alice', [table.noteId]: 'fixed' }]);
    const history = f.db.prepare('SELECT actor_kind, actor_label FROM ds_row_history WHERE store_id = ?').all(table.storeId);
    expect(history).toEqual([{ actor_kind: 'trigger', actor_label: `playbook run ${run.id}` }]);
  });

  it('updates the row that holds the natural key when the cell names one', async () => {
    const f = await boot();
    const table = await makeTable(f);
    f.daemon.stores.setNaturalKey(table.storeId, { projectId: OWN_PROJECT_ID, columnId: table.nameId });
    const playbook = await createApprovedPlaybook(f, [writeCell('write', table.storeId, { [table.nameId]: 'same', [table.noteId]: '{{inputs.note}}' }, { naturalKeyColumnID: table.nameId })], { inputs: [{ name: 'note', type: 'string', required: true }] });

    await runToTheEnd(f, playbook.id, { note: 'one' });
    const second = await runToTheEnd(f, playbook.id, { note: 'two' });

    expect(second.steps[0]?.output).toMatchObject({ outcome: 'updated' });
    expect(table.rows().map((row) => row.data)).toEqual([{ [table.nameId]: 'same', [table.noteId]: 'two' }]);
  });

  it('refuses a table of another project and writes nothing there', async () => {
    const f = await boot();
    const foreign = await makeTable(f, OTHER_PROJECT_ID);
    const playbook = await createApprovedPlaybook(f, [writeCell('write', foreign.storeId, { [foreign.nameId]: 'intruder' })]);

    const run = await runToTheEnd(f, playbook.id);

    expect(run).toMatchObject({ status: 'failed', errorCode: 'store_not_in_project' });
    expect(foreign.rows()).toEqual([]);
  });

  it('refuses a column the table does not have and writes nothing', async () => {
    const f = await boot();
    const table = await makeTable(f);
    const playbook = await createApprovedPlaybook(f, [writeCell('write', table.storeId, { 'no-such-column': 'x' })]);

    const run = await runToTheEnd(f, playbook.id);

    expect(run).toMatchObject({ status: 'failed', errorCode: 'store_column_unknown' });
    expect(table.rows()).toEqual([]);
  });

  it('refuses a text written into a number column, and names no value', async () => {
    const f = await boot();
    const table = await makeTable(f, OWN_PROJECT_ID, [{ displayName: 'amount', columnType: 'number' }]);
    const playbook = await createApprovedPlaybook(f, [writeCell('write', table.storeId, { [table.extraIds[0]!]: ROW_CANARY })]);

    const run = await runToTheEnd(f, playbook.id);

    expect(run).toMatchObject({ status: 'failed', errorCode: 'store_value_rejected' });
    expect(persistedBy(f, ['playbook_runs', 'playbook_run_steps', 'activity_log'])).not.toContain(ROW_CANARY);
  });

  it('masks the value of a secret before it is written', async () => {
    const f = await boot();
    const secretValue = `dummy-canary-built-at-runtime-${Date.now()}`;
    const table = await makeTable(f);
    const playbook = await createApprovedPlaybook(f, [
      writeCell('write', table.storeId, { [table.noteId]: 'pasted {{inputs.note}}' }, { next: [{ to: 'holder', when: [{ lhs: 'steps.write.rowId', op: 'eq', rhs: 'never' }] }] }),
      { id: 'holder', kind: 'http', method: 'GET', url: 'https://example.invalid/', headers: { 'X-Key': `{{secret:${SECRET_NAME}}}` } },
    ], { inputs: [{ name: 'note', type: 'string', required: true }] });
    new SecretRefRepository(f.db).declare({ kind: 'playbook', id: playbook.id }, SECRET_NAME);
    await secretStore.set({ kind: 'playbook', id: playbook.id }, SECRET_NAME, secretValue);

    const run = await runToTheEnd(f, playbook.id, { note: secretValue });

    expect(run.status).toBe('succeeded');
    expect(table.rows().map((row) => row.data[table.noteId])).toEqual([`pasted [secret:${SECRET_NAME}]`]);
  });

  it('never writes again a store step found running at boot', async () => {
    const f = await boot();
    const table = await makeTable(f);
    const playbook = await createApprovedPlaybook(f, [writeCell('write', table.storeId, { [table.nameId]: 'once' })]);
    f.db.prepare("INSERT INTO playbook_runs (id, playbook_id, playbook_rev, flow_sha256, status, inputs_json, actor_kind, started_at) VALUES ('run-crashed', ?, 1, 'sha', 'running', '{}', 'admin', 'now')").run(playbook.id);
    f.db.prepare("INSERT INTO playbook_run_steps (run_id, seq, step_id, status, started_at) VALUES ('run-crashed', 1, 'write', 'running', 'now')").run();

    const interruptedRuns = f.daemon.playbookRunner.recover();

    const run = await viewOfRun(f, 'run-crashed');
    expect(interruptedRuns).toBe(1);
    expect(run).toMatchObject({ status: 'needs_review', errorCode: 'interrupted', steps: [{ status: 'needs_review', errorCode: 'interrupted' }] });
    expect(table.rows()).toEqual([]);
  });
});

describe('a table or a column is never named by the output of a step', () => {
  it.each([
    ['the table of a read', (table: { storeId: string }) => readCell('second', '{{steps.first.output}}', { columns: [table.storeId] })],
    ['a column of a read', (table: { storeId: string }) => readCell('second', table.storeId, { whereColumnID: '{{steps.first.output}}', whereValue: 'x' })],
    ['the table of a write', (table: { storeId: string; nameId: string }) => writeCell('second', '{{steps.first.output}}', { [table.nameId]: 'x' })],
    ['a column of a write', (table: { storeId: string }) => writeCell('second', table.storeId, { '{{steps.first.output}}': 'x' })],
  ])('refuses at save the output of a step in %s', async (_label, secondCellOf) => {
    const f = await boot();
    const table = await makeTable(f);

    const answer = await f.api('/api/playbooks', { method: 'POST', body: JSON.stringify({ projectId: OWN_PROJECT_ID, name: 'P', cells: [readCell('first', table.storeId), secondCellOf(table)] }) });

    expect(answer.status).toBeGreaterThanOrEqual(400);
    expect(await answer.json()).toMatchObject({ error: 'untrusted_reference' });
  });

  it.each([
    ['the table of a read', (table: { storeId: string }) => readCell('second', '{{steps.first.output}}', { columns: [table.storeId] })],
    ['the table of a write', (table: { storeId: string; nameId: string }) => writeCell('second', '{{steps.first.output}}', { [table.nameId]: 'x' })],
    ['a column of a write', (table: { storeId: string }) => writeCell('second', table.storeId, { '{{steps.first.output}}': 'x' })],
  ])('never lets the output of a step into %s, for a flow stored outside the save path', async (_label, secondCellOf) => {
    const f = await boot();
    const table = await makeTable(f);
    new PlaybookRepository(f.db).insert({
      id: 'untrusted-identifier', projectId: OWN_PROJECT_ID, name: 'Outside', inputs: [], agentLocked: false, origin: 'native', createdAt: 'now',
      policy: { allowedHosts: [], browserAutoGrant: false, autoDistill: false, maxRunsToKeep: 50 },
      flow: { cells: [readCell('first', table.storeId), secondCellOf(table)] as never },
    });
    expect((await approve(f, 'untrusted-identifier')).status).toBe(200);

    const run = await runToTheEnd(f, 'untrusted-identifier');

    expect(run).toMatchObject({ status: 'failed', errorCode: 'untrusted_reference' });
    expect(table.rows()).toEqual([]);
  });

  it('lets the output of a step into the value of a cell, where it is data', async () => {
    const f = await boot();
    const table = await makeTable(f);
    table.insert({ name: 'seen', note: 'x' });
    const playbook = await createApprovedPlaybook(f, [readCell('first', table.storeId), writeCell('second', table.storeId, { [table.nameId]: 'rows: {{steps.first.rowCount}}' })]);

    const run = await runToTheEnd(f, playbook.id);

    expect(run.status).toBe('succeeded');
  });
});

describe('the cells this runner still does not execute', () => {
  it('refuses a tool cell with a reason, and writes no run', async () => {
    const f = await boot();
    const table = await makeTable(f);
    const playbook = await createApprovedPlaybook(f, [readCell('read', table.storeId), { id: 'call', kind: 'tool', tool: 'list_playbooks' }]);

    const refused = await f.api(`/api/playbooks/${playbook.id}/run`, { method: 'POST', body: JSON.stringify({ inputs: {} }) });

    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ error: 'playbook_not_runnable', message: expect.stringContaining('tool') });
    expect(f.db.prepare('SELECT COUNT(*) AS runs FROM playbook_runs').get()).toEqual({ runs: 0 });
  });
});
