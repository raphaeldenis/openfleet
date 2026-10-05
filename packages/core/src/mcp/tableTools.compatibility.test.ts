import { afterEach, beforeEach, expect, it } from 'vitest';
import { startTableToolsKit, type TableToolsKit } from './tableTools.testkit.js';

let kit: TableToolsKit;
beforeEach(async () => { kit = await startTableToolsKit(); });
afterEach(async () => { await kit.close(); });

async function numberedStore() {
  const { json: store } = await kit.call('create_data_store', { display_name: 'Numbers' });
  await kit.call('add_data_store_column', { store: store.id, display_name: 'Number', column_type: 'number' });
  await kit.call('insert_data_store_rows', { store: store.id, rows: Array.from({ length: 105 }, (_, Number) => ({ Number })) });
  return store.id as string;
}

it('pages rows and aggregate groups stably and reports limit truncation', async () => {
  const store = await numberedStore();

  const first = await kit.call('query_data_store', { store, order_by: [{ column: 'Number', dir: 'asc' }] });
  const next = await kit.call('query_data_store', { store, order_by: [{ column: 'Number', dir: 'asc' }], offset: 100 });
  const groups = await kit.call('query_data_store', { store, group_by: ['Number'] });
  const nextGroups = await kit.call('query_data_store', { store, group_by: ['Number'], offset: 100 });

  expect(first.json).toMatchObject({ count: 100, total: 105, truncated: true, next_offset: 100 });
  expect(next.json).toMatchObject({ count: 5, total: 105, truncated: false, next_offset: null });
  expect(next.json.rows.map((row: { id: string }) => row.id)).not.toContain(first.json.rows[0].id);
  expect(groups.json).toMatchObject({ count: 100, total: 105, truncated: true, next_offset: 100 });
  expect(nextGroups.json).toMatchObject({ count: 5, total: 105, truncated: false, next_offset: null });
});

it('accepts Scape aggregate select objects', async () => {
  const store = await numberedStore();

  const aggregate = await kit.call('query_data_store', { store, select: [{ agg: 'count' }] });

  expect(aggregate.isError).toBe(false);
  expect(aggregate.json.rows).toEqual([{ count: 105 }]);
});

it('discovers project store schemas and natural keys without a store', async () => {
  const store = await numberedStore();
  const { json: keyColumn } = await kit.call('add_data_store_column', { store, display_name: 'Key', column_type: 'text', natural_key: true });

  const discovery = await kit.call('describe_data_store', {});
  const scoped = await kit.call('describe_data_store', { project: 'p1' });
  const foreign = await kit.call('describe_data_store', { project: 'p2' });

  expect(discovery.isError).toBe(false);
  expect(scoped.json).toEqual(discovery.json);
  expect(foreign.isError).toBe(true);
  expect(discovery.json.stores[0].naturalKeyColumnId).toBe(keyColumn.id);
  expect(discovery.json.stores).toEqual([expect.objectContaining({ id: store, rowCount: 105, columns: expect.arrayContaining([expect.objectContaining({ displayName: 'Number' })]) })]);
});

it('reports exhausted offsets and zero limits without repeating rows', async () => {
  const store = await numberedStore();

  const exhausted = await kit.call('query_data_store', { store, offset: 105 });
  const zero = await kit.call('query_data_store', { store, limit: 0 });
  const columnar = await kit.call('query_data_store', { store, offset: 100, format: 'columnar' });

  expect(exhausted.json).toMatchObject({ rows: [], total: 105, next_offset: null, truncated: false });
  expect(zero.json).toMatchObject({ rows: [], total: 105, next_offset: null, truncated: true });
  expect(columnar.json).toMatchObject({ count: 5, total: 105, next_offset: null, truncated: false });
});
