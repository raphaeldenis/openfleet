import { afterEach, beforeEach, expect, it } from 'vitest';
import { startTableToolsKit, type TableToolsKit } from './tableTools.testkit.js';

let kit: TableToolsKit;
beforeEach(async () => { kit = await startTableToolsKit(); });
afterEach(async () => { await kit.close(); });

it('creates and describes rich formats while keeping their base types', async () => {
  const { json: store } = await kit.call('create_data_store', { display_name: 'Formats' });
  const definitions = [
    { display_name: 'When', column_type: 'date', format: 'datetime' },
    { display_name: 'Details', column_type: 'text', format: 'longText' },
    { display_name: 'Link', column_type: 'text', format: 'url', natural_key: true },
    { display_name: 'Position', column_type: 'number', format: 'rank' },
  ];

  for (const definition of definitions) {
    const result = await kit.call('add_data_store_column', { store: store.id, ...definition });
    expect(result.isError).toBe(false);
    expect(result.json).toMatchObject({ columnType: definition.column_type, format: definition.format });
  }
  const legacy = await kit.call('add_data_store_column', { store: store.id, display_name: 'Legacy', column_type: 'text' });
  const description = await kit.call('describe_data_store', { store: store.id });

  expect(legacy.json).not.toHaveProperty('format');
  expect(description.json.columns.map((column: { format?: string }) => column.format)).toEqual(['datetime', 'longText', 'url', 'rank', undefined]);
});

it('refuses incompatible formats without creating a column', async () => {
  const { json: store } = await kit.call('create_data_store', { display_name: 'Formats' });

  const result = await kit.call('add_data_store_column', { store: store.id, display_name: 'Bad', column_type: 'text', format: 'rank' });
  const description = await kit.call('describe_data_store', { store: store.id });

  expect(result.isError).toBe(true);
  expect(description.json.columns).toEqual([]);
});

it('requires an explicit datetime offset and keeps numeric ranking and chronological ordering', async () => {
  const { json: store } = await kit.call('create_data_store', { display_name: 'Formats' });
  const { json: when } = await kit.call('add_data_store_column', { store: store.id, display_name: 'When', column_type: 'date', format: 'datetime' });
  const { json: rank } = await kit.call('add_data_store_column', { store: store.id, display_name: 'Rank', column_type: 'number', format: 'rank' });

  const rejected = await kit.call('insert_data_store_rows', { store: store.id, rows: [{ When: '2026-10-06T10:00:00' }] });
  const inserted = await kit.call('insert_data_store_rows', { store: store.id, rows: [
    { When: '2026-10-06T10:00:00+02:00', Rank: '10' },
    { When: '2026-10-06T09:00:00Z', Rank: '2' },
  ] });
  const byTime = await kit.call('query_data_store', { store: store.id, order_by: [{ column: 'When', dir: 'asc' }] });
  const byRank = await kit.call('query_data_store', { store: store.id, order_by: [{ column: 'Rank', dir: 'asc' }] });
  const total = await kit.call('query_data_store', { store: store.id, select: [{ agg: 'sum', column: 'Rank' }] });

  expect(rejected.text).toContain('Invalid');
  expect(inserted.isError).toBe(false);
  expect(byTime.json.rows.map((row: { data: Record<string, unknown> }) => row.data[when.id])).toEqual(['2026-10-06T10:00:00+02:00', '2026-10-06T09:00:00Z']);
  expect(byRank.json.rows.map((row: { data: Record<string, unknown> }) => row.data[rank.id])).toEqual([2, 10]);
  expect(total.json.rows).toEqual([{ sum_Rank: 12 }]);
});

it('keeps daemon-created datetime values read-only', async () => {
  const { json: store } = await kit.call('create_data_store', { display_name: 'Stamped' });
  const { json: column } = await kit.call('add_data_store_column', {
    store: store.id, display_name: 'Created', column_type: 'date', format: 'datetime', auto_value: 'created_at',
  });
  await kit.call('insert_data_store_rows', { store: store.id, rows: [{}] });
  const rows = await kit.call('query_data_store', { store: store.id });

  const rejected = await kit.call('update_data_store_row', { store: store.id, row_id: rows.json.rows[0].id, values: { Created: '2026-10-06T00:00:00Z' } });

  expect(rows.json.rows[0].data[column.id]).toBe('2026-01-01T00:00:00.000Z');
  expect(rejected.isError).toBe(true);
});
