import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startTableToolsKit, type TableToolsKit } from './tableTools.testkit.js';

let kit: TableToolsKit;

beforeEach(async () => {
  kit = await startTableToolsKit();
});
afterEach(() => kit.close());

const STATUS_OPTIONS = [{ id: 'opt-todo', label: 'todo' }, { id: 'opt-done', label: 'Done' }];

async function createBacklog({ withNaturalKey }: { withNaturalKey: boolean }) {
  const { json: store } = await kit.call('create_data_store', { display_name: 'Backlog' });
  const addColumn = async (args: Record<string, unknown>) => (await kit.call('add_data_store_column', { store: store.id, ...args })).json;
  const key = await addColumn({ display_name: 'Key', column_type: 'text', natural_key: withNaturalKey });
  const title = await addColumn({ display_name: 'Title', column_type: 'text' });
  const points = await addColumn({ display_name: 'Points', column_type: 'number' });
  const due = await addColumn({ display_name: 'Due', column_type: 'date' });
  const status = await addColumn({ display_name: 'Status', column_type: 'select', options: STATUS_OPTIONS });
  const rows = async () => (await kit.call('query_data_store', { store: store.id })).json.rows as { id: string; data: Record<string, unknown> }[];
  return { storeId: store.id as string, columnIds: { key: key.id, title: title.id, points: points.id, due: due.id, status: status.id }, rows };
}

describe('insert_data_store_rows column and value resolution', () => {
  it('finds the store by display name and keys cells by column display name in any case, or by column id', async () => {
    const { columnIds, rows } = await createBacklog({ withNaturalKey: false });

    const result = await kit.call('insert_data_store_rows', { store: 'backlog', rows: [{ TITLE: 'by name', [columnIds.points]: 3 }] });

    expect(result.json).toMatchObject({ inserted: 1, updated: 0, failed: 0, failures: [], mode: 'create' });
    expect((await rows())[0]!.data).toEqual({ [columnIds.title]: 'by name', [columnIds.points]: 3 });
  });

  it('still returns the inserted row ids and count', async () => {
    const { storeId } = await createBacklog({ withNaturalKey: false });

    const result = await kit.call('insert_data_store_rows', { store: storeId, rows: [{ title: 'a' }, { title: 'b' }] });

    expect(result.json).toMatchObject({ ids: [expect.any(String), expect.any(String)], count: 2 });
  });

  it('coerces a numeric string into a number', async () => {
    const { storeId, columnIds, rows } = await createBacklog({ withNaturalKey: false });

    await kit.call('insert_data_store_rows', { store: storeId, rows: [{ points: ' 4.5 ' }] });

    expect((await rows())[0]!.data[columnIds.points]).toBe(4.5);
  });

  it('turns a select option label in any case into its id, and keeps an id', async () => {
    const { storeId, columnIds } = await createBacklog({ withNaturalKey: false });

    await kit.call('insert_data_store_rows', { store: storeId, rows: [{ status: 'DONE' }, { status: 'opt-todo' }] });

    const storedStatuses = kit.storeRepo.listRows(storeId).map((row) => row.data[columnIds.status]);
    expect(storedStatuses).toEqual(['opt-done', 'opt-todo']);
  });

  it('fails a row with an unknown select option, listing the valid ones, and writes nothing for it', async () => {
    const { storeId, rows } = await createBacklog({ withNaturalKey: false });

    const result = await kit.call('insert_data_store_rows', { store: storeId, rows: [{ status: 'blocked' }] });

    expect(result.json.failed).toBe(1);
    expect(result.json.failures).toEqual([expect.stringMatching(/^row 1: .*blocked.*valid options: todo, Done/)]);
    expect(await rows()).toEqual([]);
  });

  it('fails a row that names a display name shared by two columns, asking for the id', async () => {
    const { storeId, rows } = await createBacklog({ withNaturalKey: false });
    const { json: deadline } = await kit.call('add_data_store_column', { store: storeId, display_name: 'Échéance', column_type: 'text' });
    // SQLite's NOCASE only folds ASCII, so a store can hold two names that differ by a non-ASCII capital.
    kit.db.prepare('INSERT INTO ds_columns (id, store_id, display_name, column_type, sort_order, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run('twin-deadline', storeId, 'échéance', 'text', 99, 't0');

    const result = await kit.call('insert_data_store_rows', { store: storeId, rows: [{ ÉCHÉANCE: 'x' }, { 'twin-deadline': 'y', [deadline.id]: 'z' }] });

    expect(result.json.inserted).toBe(1);
    expect(result.json.failures).toEqual([expect.stringMatching(/^row 1: .*ÉCHÉANCE.*ambiguous.*use the column id/i)]);
    expect((await rows()).map((row) => row.data)).toEqual([{ 'twin-deadline': 'y', [deadline.id]: 'z' }]);
  });
});

describe('insert_data_store_rows partial batch', () => {
  it('commits the good rows and fails the bad ones alone, numbering the failures', async () => {
    const { storeId, columnIds, rows } = await createBacklog({ withNaturalKey: false });

    const result = await kit.call('insert_data_store_rows', { store: storeId, rows: [{ title: 'one' }, { nope: 'x' }, { title: 'three' }, { points: 'many' }] });

    expect(result.json).toMatchObject({ inserted: 2, failed: 2 });
    expect(result.json.failures).toEqual([expect.stringMatching(/^row 2: .*nope/), expect.stringMatching(/^row 4: /)]);
    expect((await rows()).map((row) => row.data[columnIds.title])).toEqual(['one', 'three']);
  });

  it('lands every value of a row or none of them', async () => {
    const { storeId, rows } = await createBacklog({ withNaturalKey: false });

    await kit.call('insert_data_store_rows', { store: storeId, rows: [{ title: 'fine', status: 'blocked' }] });

    expect(await rows()).toEqual([]);
  });

  it('refuses the whole call when the store does not exist', async () => {
    const result = await kit.call('insert_data_store_rows', { store: 'missing', rows: [{}] });

    expect(result.isError).toBe(true);
  });
});

describe('insert_data_store_rows natural key modes', () => {
  async function backlogWithRowA() {
    const backlog = await createBacklog({ withNaturalKey: true });
    await kit.call('insert_data_store_rows', { store: backlog.storeId, rows: [{ key: 'A', title: 'original', points: 1 }] });
    return backlog;
  }

  it('create mode, the default, fails a colliding row and leaves the existing row untouched', async () => {
    const { storeId, columnIds, rows } = await backlogWithRowA();

    const result = await kit.call('insert_data_store_rows', { store: storeId, rows: [{ key: 'A', title: 'overwritten' }, { key: 'B', title: 'fresh' }] });

    expect(result.json).toMatchObject({ inserted: 1, updated: 0, failed: 1, mode: 'create' });
    expect(result.json.failures).toEqual([expect.stringMatching(/^row 1: .*"A"/)]);
    expect((await rows()).map((row) => row.data[columnIds.title])).toEqual(['original', 'fresh']);
  });

  it('fails the second of two rows of one batch that share a new key', async () => {
    const { storeId, rows } = await createBacklog({ withNaturalKey: true });

    const result = await kit.call('insert_data_store_rows', { store: storeId, rows: [{ key: 'N', title: '1' }, { key: 'N', title: '2' }] });

    expect(result.json).toMatchObject({ inserted: 1, failed: 1 });
    expect(await rows()).toHaveLength(1);
  });

  it('upsert mode overwrites only the supplied columns of the colliding row and inserts the others', async () => {
    const { storeId, columnIds, rows } = await backlogWithRowA();

    const result = await kit.call('insert_data_store_rows', { store: storeId, mode: 'upsert', rows: [{ key: 'A', title: 'rewritten' }, { key: 'B', title: 'fresh' }] });

    expect(result.json).toMatchObject({ inserted: 1, updated: 1, failed: 0, mode: 'upsert' });
    const [rowA, rowB] = await rows();
    expect(rowA!.data).toEqual({ [columnIds.key]: 'A', [columnIds.title]: 'rewritten', [columnIds.points]: 1 });
    expect(rowB!.data[columnIds.title]).toBe('fresh');
  });

  it('update mode overwrites the colliding row and fails a row whose key is absent', async () => {
    const { storeId, columnIds, rows } = await backlogWithRowA();

    const result = await kit.call('insert_data_store_rows', { store: storeId, mode: 'update', rows: [{ key: 'A', title: 'changed' }, { key: 'Z', title: 'ghost' }] });

    expect(result.json).toMatchObject({ inserted: 0, updated: 1, failed: 1, mode: 'update' });
    expect(result.json.failures).toEqual([expect.stringMatching(/^row 2: .*"Z"/)]);
    const stored = await rows();
    expect(stored).toHaveLength(1);
    expect(stored[0]!.data[columnIds.title]).toBe('changed');
  });

  it('upsert and update fail a row that carries no key value', async () => {
    const { storeId } = await backlogWithRowA();

    const upsert = await kit.call('insert_data_store_rows', { store: storeId, mode: 'upsert', rows: [{ title: 'keyless' }] });
    const update = await kit.call('insert_data_store_rows', { store: storeId, mode: 'update', rows: [{ title: 'keyless' }] });

    expect(upsert.json.failures).toEqual([expect.stringMatching(/^row 1: .*natural key/i)]);
    expect(update.json.failures).toEqual([expect.stringMatching(/^row 1: .*natural key/i)]);
  });

  it('records the agent as the actor of an upsert update', async () => {
    const { storeId, columnIds } = await backlogWithRowA();

    const { json } = await kit.call('insert_data_store_rows', { store: storeId, mode: 'upsert', rows: [{ key: 'A', title: 'rewritten' }] });

    const [latest] = kit.storeRepo.rowHistory(json.updatedRowIDs[0], { projectId: 'p1' });
    expect(latest).toMatchObject({ actorKind: 'agent', actorLabel: '⛏️ Gimli', change: { [columnIds.title]: { from: 'original', to: 'rewritten' } } });
  });

  it('on a store with no natural key, create and upsert insert plainly and update is rejected', async () => {
    const { storeId, rows } = await createBacklog({ withNaturalKey: false });

    const create = await kit.call('insert_data_store_rows', { store: storeId, rows: [{ title: 'same' }, { title: 'same' }] });
    const upsert = await kit.call('insert_data_store_rows', { store: storeId, mode: 'upsert', rows: [{ title: 'same' }] });
    const update = await kit.call('insert_data_store_rows', { store: storeId, mode: 'update', rows: [{ title: 'same' }] });

    expect(create.json.inserted).toBe(2);
    expect(upsert.json.inserted).toBe(1);
    expect(update.isError).toBe(true);
    expect(update.text).toMatch(/no natural key/i);
    expect(await rows()).toHaveLength(3);
  });
});
