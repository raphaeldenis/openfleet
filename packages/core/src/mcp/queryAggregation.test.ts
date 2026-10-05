import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startTableToolsKit, type TableToolsKit } from './tableTools.testkit.js';

let kit: TableToolsKit;

beforeEach(async () => {
  kit = await startTableToolsKit();
});
afterEach(() => kit.close());

const STATUS_OPTIONS = [{ id: 'opt-todo', label: 'todo' }, { id: 'opt-done', label: 'Done' }];

/** Rows (Title, Points, Status): a (3, todo), b (1, Done), c (5, todo), d (no points, no status). */
async function backlogOfFourRows() {
  const { json: store } = await kit.call('create_data_store', { display_name: 'Backlog' });
  const addColumn = async (args: Record<string, unknown>) => (await kit.call('add_data_store_column', { store: store.id, ...args })).json;
  await addColumn({ display_name: 'Title', column_type: 'text' });
  await addColumn({ display_name: 'Points', column_type: 'number' });
  await addColumn({ display_name: 'Status', column_type: 'select', options: STATUS_OPTIONS });
  await kit.call('insert_data_store_rows', {
    store: store.id,
    rows: [{ title: 'a', points: 3, status: 'todo' }, { title: 'b', points: 1, status: 'Done' }, { title: 'c', points: 5, status: 'todo' }, { title: 'd' }],
  });
  return store.id as string;
}

describe('query_data_store group_by and aggregates', () => {
  it('counts the rows of each group, naming a select group by its label', async () => {
    const storeId = await backlogOfFourRows();

    const { json } = await kit.call('query_data_store', { store: storeId, group_by: ['STATUS'], aggregates: [{ op: 'count' }] });

    expect(json.rows).toEqual([{ Status: 'todo', count: 2 }, { Status: 'Done', count: 1 }, { Status: null, count: 1 }]);
    expect(json).toMatchObject({ truncated: false, count: 3 });
  });

  it('counts the rows of each group when no aggregate is given', async () => {
    const storeId = await backlogOfFourRows();

    const { json } = await kit.call('query_data_store', { store: storeId, group_by: ['status'] });

    expect(json.rows.map((row: Record<string, unknown>) => row.count)).toEqual([2, 1, 1]);
  });

  it('computes sum, avg, min and max of a number column, named by alias or by default', async () => {
    const storeId = await backlogOfFourRows();

    const { json } = await kit.call('query_data_store', {
      store: storeId, group_by: ['status'],
      aggregates: [{ op: 'sum', column: 'points' }, { op: 'avg', column: 'Points', as: 'mean' }, { op: 'min', column: 'points' }, { op: 'max', column: 'points', as: 'top' }],
    });

    expect(json.rows[0]).toEqual({ Status: 'todo', sum_Points: 8, mean: 4, min_Points: 3, top: 5 });
    expect(json.rows[2]).toEqual({ Status: null, sum_Points: 0, mean: null, min_Points: null, top: null });
  });

  it('counts only the non-empty cells of the column a count names', async () => {
    const storeId = await backlogOfFourRows();

    const { json } = await kit.call('query_data_store', { store: storeId, aggregates: [{ op: 'count', column: 'points', as: 'estimated' }, { op: 'count', as: 'all' }] });

    expect(json.rows).toEqual([{ estimated: 3, all: 4 }]);
  });

  it('aggregates only the rows matching where', async () => {
    const storeId = await backlogOfFourRows();

    const { json } = await kit.call('query_data_store', {
      store: storeId, where: [{ column: 'points', op: 'gte', value: 3 }], aggregates: [{ op: 'sum', column: 'points' }],
    });

    expect(json.rows).toEqual([{ sum_Points: 8 }]);
  });

  it('applies limit to the groups', async () => {
    const storeId = await backlogOfFourRows();

    const { json } = await kit.call('query_data_store', { store: storeId, group_by: ['status'], limit: 2 });

    expect(json.rows).toHaveLength(2);
  });

  it.each([
    ['sum of a text column', { group_by: ['status'], aggregates: [{ op: 'sum', column: 'title' }] }, /sum.*number column/i],
    ['sum without a column', { aggregates: [{ op: 'sum' }] }, /sum needs a column/i],
    ['an unknown aggregate column', { aggregates: [{ op: 'sum', column: 'nope' }] }, /nope/],
    ['an unknown group_by column', { group_by: ['nope'] }, /nope/],
  ])('refuses %s', async (_description, aggregation, expectedMessage) => {
    const storeId = await backlogOfFourRows();

    const result = await kit.call('query_data_store', { store: storeId, ...aggregation });

    expect(result.isError).toBe(true);
    expect(result.text).toMatch(expectedMessage);
  });

  it('refuses group_by together with columnar format or a column projection', async () => {
    const storeId = await backlogOfFourRows();

    const columnar = await kit.call('query_data_store', { store: storeId, group_by: ['status'], format: 'columnar' });
    const projected = await kit.call('query_data_store', { store: storeId, group_by: ['status'], select: ['title'] });

    expect(columnar.isError).toBe(true);
    expect(projected.isError).toBe(true);
    expect(columnar.text).toMatch(/group_by.*aggregates.*format/i);
  });
});
