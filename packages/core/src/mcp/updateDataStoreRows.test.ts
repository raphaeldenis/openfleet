import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startTableToolsKit, type TableToolsKit } from './tableTools.testkit.js';

let kit: TableToolsKit;

beforeEach(async () => {
  kit = await startTableToolsKit();
});
afterEach(async () => {
  vi.restoreAllMocks();
  await kit.close();
});

const STATUS_OPTIONS = [{ id: 'opt-todo', label: 'todo' }, { id: 'opt-done', label: 'Done' }];

/** Backlog keyed by Key with three rows: A (todo, 1 point), B (todo, no points), C (Done, 3 points). */
async function backlogOfThreeRows() {
  const { json: store } = await kit.call('create_data_store', { display_name: 'Backlog' });
  const addColumn = async (args: Record<string, unknown>) => (await kit.call('add_data_store_column', { store: store.id, ...args })).json;
  const key = await addColumn({ display_name: 'Key', column_type: 'text', natural_key: true });
  const title = await addColumn({ display_name: 'Title', column_type: 'text' });
  const points = await addColumn({ display_name: 'Points', column_type: 'number' });
  const status = await addColumn({ display_name: 'Status', column_type: 'select', options: STATUS_OPTIONS });
  const stamp = await addColumn({ display_name: 'Stamp', column_type: 'date', auto_value: 'created_at' });
  const inserted = await kit.call('insert_data_store_rows', {
    store: store.id,
    rows: [{ key: 'A', title: 'a', points: 1, status: 'todo' }, { key: 'B', title: 'b', status: 'todo' }, { key: 'C', title: 'c', points: 3, status: 'Done' }],
  });
  const [rowA, rowB, rowC] = inserted.json.ids as string[];
  const dataOf = async (rowId: string) => (await kit.call('query_data_store', { store: store.id })).json.rows.find((row: { id: string }) => row.id === rowId).data;
  return {
    storeId: store.id as string, rowA: rowA!, rowB: rowB!, rowC: rowC!, dataOf,
    columnIds: { key: key.id as string, title: title.id as string, points: points.id as string, status: status.id as string, stamp: stamp.id as string },
  };
}

describe('update_data_store_rows list mode', () => {
  it('takes values keyed by column display name, a select label and a store name, and reports what changed', async () => {
    const { rowA, columnIds, dataOf } = await backlogOfThreeRows();

    const result = await kit.call('update_data_store_rows', { store: 'backlog', updates: [{ row_id: rowA, values: { TITLE: 'renamed', status: 'DONE', points: '8' } }] });

    expect(result.json).toMatchObject({ updated: 1, failed: 0, failures: [], updatedRowIDs: [rowA], ids: [rowA], count: 1 });
    expect(await dataOf(rowA)).toMatchObject({ [columnIds.title]: 'renamed', [columnIds.status]: 'Done', [columnIds.points]: 8 });
  });

  it('keeps accepting patch in place of values', async () => {
    const { storeId, rowA, columnIds, dataOf } = await backlogOfThreeRows();

    await kit.call('update_data_store_rows', { store: storeId, updates: [{ row_id: rowA, patch: { [columnIds.title]: 'legacy' } }] });

    expect((await dataOf(rowA))[columnIds.title]).toBe('legacy');
  });

  it('commits the good updates and fails the bad ones alone', async () => {
    const { storeId, rowA, rowB, columnIds, dataOf } = await backlogOfThreeRows();

    const result = await kit.call('update_data_store_rows', {
      store: storeId,
      updates: [{ row_id: rowA, values: { title: 'good' } }, { row_id: rowB, values: { status: 'blocked' } }, { row_id: 'no-such-row', values: { title: 'x' } }],
    });

    expect(result.json).toMatchObject({ updated: 1, failed: 2, updatedRowIDs: [rowA] });
    expect(result.json.failures).toEqual([expect.stringMatching(/^row 2: .*blocked/), expect.stringMatching(/^row 3: .*row not found/)]);
    expect((await dataOf(rowA))[columnIds.title]).toBe('good');
    expect((await dataOf(rowB))[columnIds.title]).toBe('b');
  });

  it('lands every value of an update or none of them', async () => {
    const { storeId, rowA, columnIds, dataOf } = await backlogOfThreeRows();

    await kit.call('update_data_store_rows', { store: storeId, updates: [{ row_id: rowA, values: { title: 'half', status: 'blocked' } }] });

    expect((await dataOf(rowA))[columnIds.title]).toBe('a');
  });

  it('fails an update that gives a row the natural key another row holds', async () => {
    const { storeId, rowA, columnIds, dataOf } = await backlogOfThreeRows();

    const result = await kit.call('update_data_store_rows', { store: storeId, updates: [{ row_id: rowA, values: { key: 'B' } }] });

    expect(result.json.failures).toEqual([expect.stringMatching(/^row 1: .*"B"/)]);
    expect((await dataOf(rowA))[columnIds.key]).toBe('A');
  });

  it('fails an update of a daemon-set column and still records the agent for the others', async () => {
    const { storeId, rowA, rowB, columnIds } = await backlogOfThreeRows();

    const result = await kit.call('update_data_store_rows', {
      store: storeId,
      updates: [{ row_id: rowA, values: { stamp: '2031-06-01T00:00:00.000Z' } }, { row_id: rowB, values: { title: 'ok' } }],
    });

    expect(result.json.failures).toEqual([expect.stringMatching(/^row 1: .*set by the daemon/)]);
    const [latest] = kit.storeRepo.rowHistory(rowB, { projectId: 'p1' });
    expect(latest).toMatchObject({ actorKind: 'agent', actorLabel: '⛏️ Gimli', change: { [columnIds.title]: { from: 'b', to: 'ok' } } });
  });
});

describe('update_data_store_row natural key uniqueness', () => {
  it('refuses a key another row holds, and keeps the row as it was', async () => {
    const { storeId, rowA, columnIds, dataOf } = await backlogOfThreeRows();

    const result = await kit.call('update_data_store_row', { store: storeId, row_id: rowA, values: { key: 'B' } });

    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/"B"/);
    expect((await dataOf(rowA))[columnIds.key]).toBe('A');
  });
});

describe('update_data_store_rows one mode per call', () => {
  it.each([
    ['both updates and where/set', { updates: [{ row_id: 'r', values: { title: 'x' } }], where: { key: 'A' }, set: { title: 'x' } }],
    ['neither', {}],
    ['where without set', { where: { key: 'A' } }],
    ['set without where', { set: { title: 'x' } }],
  ])('refuses %s', async (_description, modeArguments) => {
    const { storeId } = await backlogOfThreeRows();

    const result = await kit.call('update_data_store_rows', { store: storeId, ...modeArguments });

    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/^error invalid_body: .*exactly one/);
  });
});

describe('update_data_store_rows filter mode', () => {
  it('updates every row matching all the where equalities, by column name and select label, and reports matched', async () => {
    const { storeId, rowA, rowB, rowC, columnIds, dataOf } = await backlogOfThreeRows();

    const result = await kit.call('update_data_store_rows', { store: storeId, where: { STATUS: 'TODO' }, set: { title: 'bulk' } });

    expect(result.json).toMatchObject({ matched: 2, updated: 2, failed: 0, failures: [] });
    expect([...result.json.updatedRowIDs].sort()).toEqual([rowA, rowB].sort());
    expect((await dataOf(rowC))[columnIds.title]).toBe('c');
  });

  it('ANDs the keys of where', async () => {
    const { storeId, rowA, columnIds, dataOf } = await backlogOfThreeRows();

    const result = await kit.call('update_data_store_rows', { store: storeId, where: { status: 'todo', points: 1 }, set: { title: 'both' } });

    expect(result.json).toMatchObject({ matched: 1, updatedRowIDs: [rowA] });
    expect((await dataOf(rowA))[columnIds.title]).toBe('both');
  });

  it('reads null in where as an empty cell', async () => {
    const { storeId, rowB } = await backlogOfThreeRows();

    const result = await kit.call('update_data_store_rows', { store: storeId, where: { points: null }, set: { title: 'empty points' } });

    expect(result.json).toMatchObject({ matched: 1, updatedRowIDs: [rowB] });
  });

  it('succeeds with matched 0 when no row matches', async () => {
    const { storeId } = await backlogOfThreeRows();

    const result = await kit.call('update_data_store_rows', { store: storeId, where: { key: 'nobody' }, set: { title: 'x' } });

    expect(result.isError).toBe(false);
    expect(result.json).toMatchObject({ matched: 0, updated: 0, failed: 0, failures: [], updatedRowIDs: [] });
  });

  it.each([
    ['an unknown where column', { where: { nope: 'x' }, set: { title: 'changed' } }],
    ['an unknown set column', { where: { status: 'todo' }, set: { title: 'changed', nope: 'x' } }],
    ['an unknown where select option', { where: { status: 'blocked' }, set: { title: 'changed' } }],
    ['an uncoercible where value', { where: { points: 'many' }, set: { title: 'changed' } }],
    ['an uncoercible set value', { where: { status: 'todo' }, set: { title: 'changed', points: 'many' } }],
    ['an unknown set select option', { where: { status: 'todo' }, set: { title: 'changed', status: 'blocked' } }],
    ['a daemon-set column in set', { where: { status: 'todo' }, set: { title: 'changed', stamp: '2031-06-01T00:00:00.000Z' } }],
  ])('rejects the whole call on %s and writes nothing', async (_description, filterArguments) => {
    const { storeId, rowA, columnIds, dataOf } = await backlogOfThreeRows();

    const result = await kit.call('update_data_store_rows', { store: storeId, ...filterArguments });

    expect(result.isError).toBe(true);
    expect((await dataOf(rowA))[columnIds.title]).toBe('a');
  });

  it('rolls everything back when one write fails midway', async () => {
    const { storeId, rowA, rowB, columnIds, dataOf } = await backlogOfThreeRows();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    kit.db.exec(`CREATE TRIGGER refuse_second_row BEFORE UPDATE ON ds_rows WHEN NEW.id = '${rowB}' BEGIN SELECT RAISE(ABORT, 'refused'); END`);

    const result = await kit.call('update_data_store_rows', { store: storeId, where: { status: 'todo' }, set: { title: 'bulk' } });

    expect(result.isError).toBe(true);
    expect((await dataOf(rowA))[columnIds.title]).toBe('a');
    expect((await dataOf(rowB))[columnIds.title]).toBe('b');
  });

  it('refuses to set the natural key when the filter matches several rows', async () => {
    const { storeId, columnIds, dataOf, rowA } = await backlogOfThreeRows();

    const result = await kit.call('update_data_store_rows', { store: storeId, where: { status: 'todo' }, set: { key: 'Z' } });

    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/natural key.*several rows|several rows.*natural key/i);
    expect((await dataOf(rowA))[columnIds.key]).toBe('A');
  });

  it('sets the natural key of the one row matched, and refuses a key another row holds', async () => {
    const { storeId, columnIds, dataOf, rowA } = await backlogOfThreeRows();

    const refused = await kit.call('update_data_store_rows', { store: storeId, where: { key: 'A' }, set: { key: 'B' } });
    const accepted = await kit.call('update_data_store_rows', { store: storeId, where: { key: 'A' }, set: { key: 'A2' } });

    expect(refused.isError).toBe(true);
    expect(accepted.json).toMatchObject({ matched: 1, updated: 1 });
    expect((await dataOf(rowA))[columnIds.key]).toBe('A2');
  });

  it('records the agent as the actor of each row it changed', async () => {
    const { storeId, rowC, columnIds } = await backlogOfThreeRows();

    await kit.call('update_data_store_rows', { store: storeId, where: { key: 'C' }, set: { title: 'by filter' } });

    const [latest] = kit.storeRepo.rowHistory(rowC, { projectId: 'p1' });
    expect(latest).toMatchObject({ actorKind: 'agent', actorLabel: '⛏️ Gimli', change: { [columnIds.title]: { from: 'c', to: 'by filter' } } });
  });
});

describe('update_data_store_rows under the row guard', () => {
  const FIRST_LINE = '2026-10-29T06:57Z [Capitaine] builder lance.';

  async function guardedKanban(options: { guardEnabled: boolean }) {
    if (options.guardEnabled) kit.db.prepare('UPDATE projects SET row_guard_enabled = 1 WHERE id = ?').run('p1');
    const { json: store } = await kit.call('create_data_store', { display_name: 'Kanban' });
    const journal = (await kit.call('add_data_store_column', { store: store.id, display_name: 'journal', column_type: 'text' })).json;
    const inserted = await kit.call('insert_data_store_rows', { store: store.id, rows: [{ journal: FIRST_LINE }] });
    const [rowId] = inserted.json.ids as string[];
    const journalOf = async () => (await kit.call('query_data_store', { store: store.id })).json.rows[0].data[journal.id];
    return { storeId: store.id as string, rowId: rowId!, journalOf };
  }

  it('fails a shortened journal with the guard code and tells the agent to resend the previous journal plus a line', async () => {
    const { storeId, rowId, journalOf } = await guardedKanban({ guardEnabled: true });

    const result = await kit.call('update_data_store_rows', { store: storeId, updates: [{ row_id: rowId, values: { journal: 'overwritten' } }] });

    expect(result.json.failures).toEqual([expect.stringMatching(/^row 1: .*previous journal.*new line/i)]);
    expect(await journalOf()).toBe(FIRST_LINE);
  });

  it('accepts the previous journal followed by a new line', async () => {
    const { storeId, rowId, journalOf } = await guardedKanban({ guardEnabled: true });

    await kit.call('update_data_store_rows', { store: storeId, updates: [{ row_id: rowId, values: { journal: `${FIRST_LINE}\nnext` } }] });

    expect(await journalOf()).toBe(`${FIRST_LINE}\nnext`);
  });

  it('lets the journal be overwritten when the project setting is off', async () => {
    const { storeId, rowId, journalOf } = await guardedKanban({ guardEnabled: false });

    await kit.call('update_data_store_rows', { store: storeId, updates: [{ row_id: rowId, values: { journal: 'overwritten' } }] });

    expect(await journalOf()).toBe('overwritten');
  });
});

describe('row revision over MCP', () => {
  const revsOf = async (storeId: string, tool: 'query_data_store' | 'get_data_store') =>
    Object.fromEntries((await kit.call(tool, { store: storeId })).json.rows.map((row: { id: string; rev: number }) => [row.id, row.rev]));

  it.each(['query_data_store', 'get_data_store'] as const)('shows the revision of every row in %s, raised by a write', async (tool) => {
    const { storeId, rowA, rowB, rowC } = await backlogOfThreeRows();
    await kit.call('update_data_store_rows', { store: storeId, updates: [{ row_id: rowA, values: { title: 'changed' } }] });

    expect(await revsOf(storeId, tool)).toEqual({ [rowA]: 2, [rowB]: 1, [rowC]: 1 });
  });

  it('puts the revision last in a columnar row and names it in the header', async () => {
    const { storeId, rowA, columnIds } = await backlogOfThreeRows();
    await kit.call('update_data_store_rows', { store: storeId, updates: [{ row_id: rowA, values: { title: 'changed' } }] });

    const result = await kit.call('query_data_store', { store: storeId, format: 'columnar', columns: [columnIds.title], where: [{ column: 'Key', op: 'eq', value: 'A' }] });

    expect(result.json.columns).toEqual(['id', 'updatedAt', columnIds.title, 'rev']);
    expect(result.json.names).toEqual(['id', 'updatedAt', 'Title', 'rev']);
    expect(result.json.rows).toEqual([[rowA, expect.any(String), 'changed', 2]]);
  });

  it('writes the updates of a list that expect the current revision', async () => {
    const { storeId, rowA, dataOf, columnIds } = await backlogOfThreeRows();

    const result = await kit.call('update_data_store_rows', { store: storeId, updates: [{ row_id: rowA, values: { title: 'mine' }, expected_rev: 1 }] });

    expect(result.json).toMatchObject({ updated: 1, failed: 0, failures: [] });
    expect((await dataOf(rowA))[columnIds.title]).toBe('mine');
  });

  it('fails a stale update of a list alone, tells the current revision, and commits the others', async () => {
    const { storeId, rowA, rowB, dataOf, columnIds } = await backlogOfThreeRows();
    await kit.call('update_data_store_rows', { store: storeId, updates: [{ row_id: rowA, values: { title: 'theirs' } }] });

    const result = await kit.call('update_data_store_rows', {
      store: storeId,
      updates: [{ row_id: rowA, values: { title: 'mine' }, expected_rev: 1 }, { row_id: rowB, values: { title: 'ok' }, expected_rev: 1 }],
    });

    expect(result.json).toMatchObject({ updated: 1, failed: 1, updatedRowIDs: [rowB] });
    expect(result.json.failures).toEqual([expect.stringMatching(/^row 1: .*changed since.*current rev: 2/)]);
    expect((await dataOf(rowA))[columnIds.title]).toBe('theirs');
    expect((await dataOf(rowB))[columnIds.title]).toBe('ok');
  });

  it('refuses a stale update_data_store_row with stale_revision, the current revision and after_refresh, and changes nothing', async () => {
    const { storeId, rowA, dataOf, columnIds } = await backlogOfThreeRows();
    await kit.call('update_data_store_row', { store: storeId, row_id: rowA, values: { title: 'theirs' } });

    const result = await kit.call('update_data_store_row', { store: storeId, row_id: rowA, values: { title: 'mine' }, expected_rev: 1 });

    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/^error stale_revision: .*current rev: 2.*\(retry: after_refresh/);
    expect((await dataOf(rowA))[columnIds.title]).toBe('theirs');
  });

  it('writes update_data_store_row when it expects the current revision, and still writes without one', async () => {
    const { storeId, rowA, dataOf, columnIds } = await backlogOfThreeRows();

    const expecting = await kit.call('update_data_store_row', { store: storeId, row_id: rowA, values: { title: 'one' }, expected_rev: 1 });
    const notExpecting = await kit.call('update_data_store_row', { store: storeId, row_id: rowA, values: { title: 'two' } });

    expect([expecting.isError, notExpecting.isError]).toEqual([false, false]);
    expect((await dataOf(rowA))[columnIds.title]).toBe('two');
  });
});
