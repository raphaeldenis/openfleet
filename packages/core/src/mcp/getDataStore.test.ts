import { afterEach, beforeEach, expect, it } from 'vitest';
import { startTableToolsKit, type TableToolsKit } from './tableTools.testkit.js';

let kit: TableToolsKit;
beforeEach(async () => { kit = await startTableToolsKit(); });
afterEach(async () => { await kit.close(); });

async function textStore(values: string[]) {
  const { json: store } = await kit.call('create_data_store', { display_name: 'Stories' });
  const { json: column } = await kit.call('add_data_store_column', { store: store.id, display_name: 'Story', column_type: 'text', format: 'longText' });
  const rows = values.map(value => {
    const row = kit.stores.saveRow(store.id, { projectId: 'p1', data: {}, actor: { kind: 'human', label: 'Fixture' }, mode: 'create' }).row;
    kit.db.prepare('UPDATE ds_rows SET data_json = ? WHERE id = ?').run(JSON.stringify({ [column.id]: value }), row.id);
    return row;
  });
  return { store: store.id as string, column, ids: rows.map(row => row.id) };
}

it('advertises the tool and pages newest rows with binary id ties and cap-only truncation', async () => {
  const { store, column, ids } = await textStore(['first', 'second', 'third']);
  kit.db.prepare('UPDATE ds_rows SET updated_at = ? WHERE id = ?').run('2026-10-07T00:00:00.000Z', ids[2]!);
  const first = await kit.call('get_data_store', { store: 'Stories', limit: 1 });
  const next = await kit.call('get_data_store', { store, limit: 1, offset: 1 });
  const last = await kit.call('get_data_store', { store, offset: 2 });
  const exhausted = await kit.call('get_data_store', { store, offset: 3 });
  expect((await kit.listTools()).map(tool => tool.name)).toContain('get_data_store');
  expect(first.json).toMatchObject({ columns: [column], rows: [{ id: ids[2], data: { [column.id]: 'third' } }], totalRowCount: 3, returned: 1, offset: 0, next_offset: 1, truncated: false });
  expect(next.json.rows[0].id).toBe([...ids.slice(0, 2)].sort()[0]);
  expect(next.json).toMatchObject({ offset: 1, next_offset: 2, returned: 1, truncated: false });
  expect(last.json).toMatchObject({ returned: 1, next_offset: null, truncated: false });
  expect(exhausted.json).toMatchObject({ rows: [], returned: 0, next_offset: null, truncated: false });
});

it('defaults to 100 rows and validates pagination and unknown projections', async () => {
  const { store } = await textStore(Array.from({ length: 105 }, (_, index) => String(index)));
  expect((await kit.call('get_data_store', { store })).json).toMatchObject({ returned: 100, next_offset: 100, totalRowCount: 105, truncated: false });
  for (const args of [{ limit: 1001 }, { limit: -1 }, { offset: -1 }, { offset: 0.5 }]) {
    expect((await kit.call('get_data_store', { store, ...args })).isError).toBe(true);
  }
  const unknown = await kit.call('get_data_store', { store, columns: ['missing'] });
  const queryUnknown = await kit.call('query_data_store', { store, columns: ['missing'] });
  expect(unknown.text).toBe(queryUnknown.text);
});

it('orders tied timestamps by binary ids instead of insertion order', async () => {
  const { store, ids } = await textStore(Array.from({ length: 12 }, (_, index) => String(index)));
  const page = await kit.call('get_data_store', { store });
  expect(page.json.rows.map((row: { id: string }) => row.id)).toEqual([...ids].sort());
});

it('returns typed select schema and reads option labels through the shared row view', async () => {
  const { store } = await textStore([]);
  const options = [{ id: 'ready', label: 'Ready', color: '#00ff00' }];
  const { json: status } = await kit.call('add_data_store_column', { store, display_name: 'Status', column_type: 'select', options });
  await kit.call('insert_data_store_rows', { store, rows: [{ Status: 'Ready' }] });
  const page = await kit.call('get_data_store', { store, columns: ['Status'] });
  expect(page.json.columns).toEqual([status]);
  expect(page.json.rows[0].data).toEqual({ [status.id]: 'Ready' });
});

it('projects schema and cells by display name or id, including an empty projection', async () => {
  const { store, column } = await textStore(['hello']);
  const projected = await kit.call('get_data_store', { store, columns: ['sToRy', column.id] });
  const queried = await kit.call('query_data_store', { store, columns: [column.id] });
  expect(projected.json.columns).toEqual([column]);
  expect(projected.json.rows).toEqual(queried.json.rows);
  expect((await kit.call('get_data_store', { store, columns: [] })).json).toMatchObject({ columns: [], rows: [{ data: {} }] });
});

it('cuts before the second overflowing row and resumes at the retained count', async () => {
  const { store } = await textStore(['é'.repeat(300_000), 'é'.repeat(300_000)]);
  const page = await kit.call('get_data_store', { store });
  expect(page.json).toMatchObject({ returned: 1, totalRowCount: 2, truncated: true, next_offset: 1 });
  expect(Buffer.byteLength(page.text, 'utf8')).toBeLessThanOrEqual(1024 * 1024);
  expect((await kit.call('get_data_store', { store, offset: 1 })).json).toMatchObject({ returned: 1, truncated: false, next_offset: null });
});

it('refuses an oversized first row or schema with actionable invalid_body wording', async () => {
  const { store, column } = await textStore(['é'.repeat(600_000)]);
  const oversizedRow = await kit.call('get_data_store', { store });
  expect(oversizedRow.isError).toBe(true);
  expect(oversizedRow.text).toMatch(/error invalid_body:.*fewer columns.*smaller limit/);
  kit.db.prepare('UPDATE ds_columns SET display_name = ? WHERE id = ?').run('é'.repeat(600_000), column.id);
  const oversizedSchema = await kit.call('get_data_store', { store, offset: 1 });
  expect(oversizedSchema.isError).toBe(true);
  expect(oversizedSchema.text).toMatch(/error invalid_body:/);
});

it('conceals foreign stores using the same refusal as a missing store', async () => {
  const { store } = await textStore([]);
  kit.db.prepare('INSERT INTO projects (id, name, created_at) VALUES (?, ?, ?)').run('p2', 'Two', 't0');
  kit.db.prepare('UPDATE data_stores SET project_id = ? WHERE id = ?').run('p2', store);
  const foreign = await kit.call('get_data_store', { store });
  expect(foreign.text).toContain('error store_not_found:');
  expect(foreign.text).toBe((await kit.call('get_data_store', { store: 'missing' })).text);
});
