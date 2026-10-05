import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startTableToolsKit, type TableToolsKit } from './tableTools.testkit.js';

let kit: TableToolsKit;

beforeEach(async () => {
  kit = await startTableToolsKit();
});
afterEach(() => kit.close());

const STATUS_OPTIONS = [{ id: 'opt-todo', label: 'todo' }, { id: 'opt-doing', label: 'Doing' }, { id: 'opt-done', label: 'Done' }];

/** Rows (Title, Points, Status): first (3, todo), second (1, Done), third (2, Doing), fourth (no points, no status). */
async function backlogOfFourRows() {
  const { json: store } = await kit.call('create_data_store', { display_name: 'Backlog' });
  const addColumn = async (args: Record<string, unknown>) => (await kit.call('add_data_store_column', { store: store.id, ...args })).json;
  const title = await addColumn({ display_name: 'Title', column_type: 'text' });
  const points = await addColumn({ display_name: 'Points', column_type: 'number' });
  const status = await addColumn({ display_name: 'Status', column_type: 'select', options: STATUS_OPTIONS });
  await kit.call('insert_data_store_rows', {
    store: store.id,
    rows: [{ title: 'first', points: 3, status: 'todo' }, { title: 'second', points: 1, status: 'Done' }, { title: 'third', points: 2, status: 'Doing' }, { title: 'fourth' }],
  });
  const titlesOf = (result: { json: { rows: { data: Record<string, unknown> }[] } }) => result.json.rows.map((row) => row.data[title.id]);
  return { storeId: store.id as string, columnIds: { title: title.id as string, points: points.id as string, status: status.id as string }, titlesOf };
}

describe('query_data_store column and value resolution', () => {
  it('finds the store by display name and takes where and order_by columns by display name in any case', async () => {
    const { titlesOf } = await backlogOfFourRows();

    const result = await kit.call('query_data_store', {
      store: 'BACKLOG', where: [{ column: 'POINTS', op: 'gte', value: 2 }], order_by: [{ column: 'points', dir: 'asc' }],
    });

    expect(titlesOf(result)).toEqual(['third', 'first']);
  });

  it('keeps accepting columnId in where and order_by', async () => {
    const { storeId, columnIds, titlesOf } = await backlogOfFourRows();

    const result = await kit.call('query_data_store', {
      store: storeId, where: [{ columnId: columnIds.points, op: 'lt', value: 3 }], order_by: [{ columnId: columnIds.points, dir: 'desc' }],
    });

    expect(titlesOf(result)).toEqual(['third', 'second']);
  });

  it('matches a select where value by option label in any case, or by id', async () => {
    const { storeId, titlesOf } = await backlogOfFourRows();

    const byLabel = await kit.call('query_data_store', { store: storeId, where: [{ column: 'status', op: 'eq', value: 'DONE' }] });
    const byId = await kit.call('query_data_store', { store: storeId, where: [{ column: 'status', op: 'eq', value: 'opt-done' }] });

    expect(titlesOf(byLabel)).toEqual(['second']);
    expect(titlesOf(byId)).toEqual(['second']);
  });

  it('reads a numeric string as a number in where', async () => {
    const { storeId, titlesOf } = await backlogOfFourRows();

    const result = await kit.call('query_data_store', { store: storeId, where: [{ column: 'points', op: 'eq', value: '3' }] });

    expect(titlesOf(result)).toEqual(['first']);
  });

  it('accepts ne as not-equal, and in as one of several values', async () => {
    const { storeId, titlesOf } = await backlogOfFourRows();

    const notDone = await kit.call('query_data_store', { store: storeId, where: [{ column: 'status', op: 'ne', value: 'done' }] });
    const oneOf = await kit.call('query_data_store', { store: storeId, where: [{ column: 'status', op: 'in', value: ['todo', 'doing'] }] });

    expect(titlesOf(notDone)).toEqual(['first', 'third', 'fourth']);
    expect(titlesOf(oneOf)).toEqual(['first', 'third']);
  });

  it('keeps accepting neq', async () => {
    const { storeId, titlesOf } = await backlogOfFourRows();

    const result = await kit.call('query_data_store', { store: storeId, where: [{ column: 'status', op: 'neq', value: 'done' }] });

    expect(titlesOf(result)).toEqual(['first', 'third', 'fourth']);
  });

  it('refuses an in whose value is not a list', async () => {
    const { storeId } = await backlogOfFourRows();

    const result = await kit.call('query_data_store', { store: storeId, where: [{ column: 'status', op: 'in', value: 'todo' }] });

    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/in.*list/i);
  });

  it.each([
    ['an unknown column', { column: 'nope', op: 'eq', value: 'x' }, /nope/],
    ['an unknown select option', { column: 'status', op: 'eq', value: 'blocked' }, /blocked.*valid options: todo, Doing, Done/],
    ['an uncoercible number', { column: 'points', op: 'eq', value: 'many' }, /many/],
  ])('refuses %s in where', async (_description, clause, expectedMessage) => {
    const { storeId } = await backlogOfFourRows();

    const result = await kit.call('query_data_store', { store: storeId, where: [clause] });

    expect(result.isError).toBe(true);
    expect(result.text).toMatch(expectedMessage);
  });

  it('refuses a where clause that names no column', async () => {
    const { storeId } = await backlogOfFourRows();

    const result = await kit.call('query_data_store', { store: storeId, where: [{ op: 'eq', value: 'x' }] });

    expect(result.isError).toBe(true);
  });
});

describe('query_data_store select cells', () => {
  it('returns the option label of a select cell in rows format', async () => {
    const { storeId, columnIds } = await backlogOfFourRows();

    const { json } = await kit.call('query_data_store', { store: storeId });

    expect(json.rows.map((row: { data: Record<string, unknown> }) => row.data[columnIds.status])).toEqual(['todo', 'Done', 'Doing', undefined]);
  });

  it('returns the option label of a select cell in columnar format', async () => {
    const { storeId } = await backlogOfFourRows();

    const { json } = await kit.call('query_data_store', { store: storeId, format: 'columnar', columns: ['status'] });

    expect(json.rows.map((row: unknown[]) => row.at(-1))).toEqual(['todo', 'Done', 'Doing', null]);
  });

  it('keeps the raw value of a select cell whose option no longer exists', async () => {
    const { storeId, columnIds } = await backlogOfFourRows();
    kit.db.prepare(`UPDATE ds_rows SET data_json = json_set(data_json, '$."${columnIds.status}"', 'retired-option') WHERE json_extract(data_json, '$."${columnIds.title}"') = 'first'`).run();

    const { json } = await kit.call('query_data_store', { store: storeId, limit: 1 });

    expect(json.rows[0].data[columnIds.status]).toBe('retired-option');
  });
});

describe('query_data_store select projection', () => {
  it('takes select as the list of columns to keep, like columns', async () => {
    const { storeId, columnIds } = await backlogOfFourRows();

    const { json } = await kit.call('query_data_store', { store: storeId, select: ['TITLE'], limit: 1 });

    expect(json.rows[0].data).toEqual({ [columnIds.title]: 'first' });
  });

  it('refuses both select and columns', async () => {
    const { storeId } = await backlogOfFourRows();

    const result = await kit.call('query_data_store', { store: storeId, select: ['title'], columns: ['title'] });

    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/either select or columns/);
  });
});

describe('describe_data_store', () => {
  it('finds the store by display name in any case', async () => {
    const { storeId } = await backlogOfFourRows();

    const { json } = await kit.call('describe_data_store', { store: 'bAcKlOg' });

    expect(json).toMatchObject({ id: storeId, displayName: 'Backlog' });
    expect(json.columns.map((column: { displayName: string }) => column.displayName)).toEqual(['Title', 'Points', 'Status']);
  });
});
