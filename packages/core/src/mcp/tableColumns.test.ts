import type { DsViewConfig, ViewType } from '@openfleet/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startTableToolsKit, type TableToolsKit } from './tableTools.testkit.js';

let kit: TableToolsKit;
beforeEach(async () => { kit = await startTableToolsKit(); });
afterEach(async () => { await kit.close(); });

const createStore = async (display_name = 'Stock') => (await kit.call('create_data_store', { display_name })).json.id as string;
const addColumn = async (store: string, args: Record<string, unknown>) => (await kit.call('add_data_store_column', { store, ...args })).json;
const describeColumns = async (store: string) => (await kit.call('describe_data_store', { store })).json.columns as { id: string; displayName: string; options?: { id: string; label: string; color?: string }[] }[];
const columnNames = async (store: string) => (await describeColumns(store)).map((column) => column.displayName);

describe('update_data_store_column', () => {
  it('renames a column keeping its id, type and cells', async () => {
    const store = await createStore();
    const { id: column_id } = await addColumn(store, { display_name: 'Name', column_type: 'text' });
    await kit.call('insert_data_store_rows', { store, rows: [{ [column_id]: 'Bolt' }] });

    const result = await kit.call('update_data_store_column', { store, column_id, name: 'Product' });

    expect(result.isError).toBe(false);
    expect(result.json).toMatchObject({ id: column_id, displayName: 'Product', columnType: 'text' });
    expect((await kit.call('get_data_store', { store })).json.rows[0].data).toEqual({ [column_id]: 'Bolt' });
  });

  it('refuses a name another column already carries', async () => {
    const store = await createStore();
    await addColumn(store, { display_name: 'Name', column_type: 'text' });
    const { id: column_id } = await addColumn(store, { display_name: 'Qty', column_type: 'number' });

    const result = await kit.call('update_data_store_column', { store, column_id, name: 'name' });

    expect(result.isError).toBe(true);
    expect(result.text).toContain('The name "name" is already taken');
    expect(await columnNames(store)).toEqual(['Name', 'Qty']);
  });

  it('replaces options keeping the id of an entry matched by id, then by label, and giving a new id to the others', async () => {
    const store = await createStore();
    const status = await addColumn(store, { display_name: 'Status', column_type: 'select', options: [{ id: 'todo', label: 'To do' }, { id: 'done', label: 'Done' }, { id: 'old', label: 'Old' }] });

    const result = await kit.call('update_data_store_column', {
      store, column_id: status.id,
      options: [{ id: 'done', label: 'Finished', color: '#0a0' }, { label: 'To do' }, { label: 'Blocked', color: '#f00' }],
    });

    expect(result.isError).toBe(false);
    expect(result.json.options).toEqual([
      { id: 'done', label: 'Finished', color: '#0a0' },
      { id: 'todo', label: 'To do' },
      { id: expect.any(String), label: 'Blocked', color: '#f00' },
    ]);
    expect(result.json.options[2].id).not.toMatch(/^(todo|done|old)$/);
    expect((await describeColumns(store))[0]?.options).toEqual(result.json.options);
  });

  it('keeps existing cells readable when their option survives a replacement', async () => {
    const store = await createStore();
    const status = await addColumn(store, { display_name: 'Status', column_type: 'select', options: [{ id: 'todo', label: 'To do' }, { id: 'done', label: 'Done' }] });
    await kit.call('insert_data_store_rows', { store, rows: [{ [status.id]: 'done' }] });

    await kit.call('update_data_store_column', { store, column_id: status.id, options: [{ id: 'done', label: 'Finished' }] });

    expect((await kit.call('get_data_store', { store })).json.rows[0].data).toEqual({ [status.id]: 'Finished' });
  });

  it('refuses dropping an option a row holds and changes nothing, not even the name', async () => {
    const store = await createStore();
    const status = await addColumn(store, { display_name: 'Status', column_type: 'select', options: [{ id: 'todo', label: 'To do' }, { id: 'done', label: 'Done' }] });
    await kit.call('insert_data_store_rows', { store, rows: [{ [status.id]: 'done' }] });

    const result = await kit.call('update_data_store_column', { store, column_id: status.id, name: 'State', options: [{ id: 'todo', label: 'To do' }] });

    expect(result.isError).toBe(true);
    expect(result.text).toContain('Rows still hold the options being removed (done)');
    expect((await describeColumns(store))[0]).toMatchObject({ displayName: 'Status', options: [{ id: 'todo' }, { id: 'done' }] });
  });

  it('refuses an option id the column does not own', async () => {
    const store = await createStore();
    const status = await addColumn(store, { display_name: 'Status', column_type: 'select', options: [{ id: 'todo', label: 'To do' }] });

    const result = await kit.call('update_data_store_column', { store, column_id: status.id, options: [{ id: 'elsewhere', label: 'To do' }] });

    expect(result.isError).toBe(true);
    expect(result.text).toContain('Option id elsewhere does not belong to this column');
    expect((await describeColumns(store))[0]?.options).toEqual([{ id: 'todo', label: 'To do' }]);
  });

  it('refuses new options that share a label, whatever the case, and changes nothing', async () => {
    const store = await createStore();
    const status = await addColumn(store, { display_name: 'Status', column_type: 'select', options: [{ id: 'todo', label: 'To do' }] });

    const identicalLabels = await kit.call('update_data_store_column', { store, column_id: status.id, options: [{ label: 'Blocked' }, { label: 'Blocked' }] });
    const caseVariantLabels = await kit.call('update_data_store_column', { store, column_id: status.id, options: [{ label: 'Blocked' }, { label: 'blocked' }] });

    expect(identicalLabels.isError).toBe(true);
    expect(identicalLabels.text).toContain('Option labels must be unique');
    expect(caseVariantLabels.isError).toBe(true);
    expect(caseVariantLabels.text).toContain('Option labels must be unique');
    expect((await describeColumns(store))[0]?.options).toEqual([{ id: 'todo', label: 'To do' }]);
  });

  it('takes the colors from the replacement list: a matched option without color loses it, with a color keeps the new one', async () => {
    const store = await createStore();
    const status = await addColumn(store, { display_name: 'Status', column_type: 'select', options: [{ id: 'todo', label: 'To do', color: '#00f' }, { id: 'done', label: 'Done', color: '#0a0' }] });

    const result = await kit.call('update_data_store_column', { store, column_id: status.id, options: [{ id: 'todo', label: 'To do' }, { label: 'Done', color: '#808' }] });

    expect(result.isError).toBe(false);
    expect(result.json.options).toEqual([{ id: 'todo', label: 'To do' }, { id: 'done', label: 'Done', color: '#808' }]);
  });

  it('refuses an update that changes nothing', async () => {
    const store = await createStore();
    const { id: column_id } = await addColumn(store, { display_name: 'Name', column_type: 'text' });

    const result = await kit.call('update_data_store_column', { store, column_id });

    expect(result.isError).toBe(true);
    expect(result.text).toContain('Nothing to update');
  });

  it('refuses options on a column of another family than select', async () => {
    const store = await createStore();
    const { id: column_id } = await addColumn(store, { display_name: 'Name', column_type: 'text' });

    const result = await kit.call('update_data_store_column', { store, column_id, options: [{ label: 'A' }] });

    expect(result.isError).toBe(true);
    expect(result.text).toContain('Only a select column takes options');
    expect((await describeColumns(store))[0]).not.toHaveProperty('options');
  });

  it('makes a text column the natural key, then clears it', async () => {
    const store = await createStore();
    const { id: column_id } = await addColumn(store, { display_name: 'Name', column_type: 'text' });

    const set = await kit.call('update_data_store_column', { store, column_id, natural_key: true });
    const keyAfterSet = (await kit.call('describe_data_store', { store })).json.naturalKeyColumnId;
    const cleared = await kit.call('update_data_store_column', { store, column_id, natural_key: false });
    const keyAfterClear = (await kit.call('describe_data_store', { store })).json.naturalKeyColumnId;

    expect(set.isError).toBe(false);
    expect(keyAfterSet).toBe(column_id);
    expect(cleared.isError).toBe(false);
    expect(keyAfterClear).toBeUndefined();
  });

  it('leaves another column\'s natural key alone when natural_key false targets a non-key column', async () => {
    const store = await createStore();
    const key = await addColumn(store, { display_name: 'Name', column_type: 'text', natural_key: true });
    const other = await addColumn(store, { display_name: 'Note', column_type: 'text' });

    await kit.call('update_data_store_column', { store, column_id: other.id, natural_key: false });

    expect((await kit.call('describe_data_store', { store })).json.naturalKeyColumnId).toBe(key.id);
  });

  it('refuses a natural key whose values repeat and rolls the rename back with it', async () => {
    const store = await createStore();
    const { id: column_id } = await addColumn(store, { display_name: 'Name', column_type: 'text' });
    await kit.call('insert_data_store_rows', { store, rows: [{ [column_id]: 'Bolt' }, { [column_id]: 'Bolt' }] });

    const result = await kit.call('update_data_store_column', { store, column_id, name: 'Product', natural_key: true });

    expect(result.isError).toBe(true);
    expect(result.text).toContain('already share a value');
    expect(await columnNames(store)).toEqual(['Name']);
  });

  it('refuses a natural key on a column that is not text', async () => {
    const store = await createStore();
    const { id: column_id } = await addColumn(store, { display_name: 'Qty', column_type: 'number' });

    const result = await kit.call('update_data_store_column', { store, column_id, natural_key: true });

    expect(result.isError).toBe(true);
    expect(result.text).toContain('The natural key must be a text column');
  });

  it('refuses an unknown column naming it', async () => {
    const store = await createStore();

    const result = await kit.call('update_data_store_column', { store, column_id: 'missing', name: 'X' });

    expect(result.isError).toBe(true);
    expect(result.text).toContain('invalid_body');
    expect(result.text).toContain('Unknown columns: missing');
  });
});

describe('delete_data_store_column', () => {
  it('removes the column and its cells and records the cleared cell in the row history', async () => {
    const store = await createStore();
    const name = await addColumn(store, { display_name: 'Name', column_type: 'text' });
    const qty = await addColumn(store, { display_name: 'Qty', column_type: 'number' });
    const inserted = await kit.call('insert_data_store_rows', { store, rows: [{ [name.id]: 'Bolt', [qty.id]: 5 }, { [name.id]: 'Nut' }] });

    const result = await kit.call('delete_data_store_column', { store, column_id: qty.id });

    expect(result.isError).toBe(false);
    expect(result.json).toEqual({ deleted: qty.id });
    expect((await describeColumns(store)).map((column) => column.id)).toEqual([name.id]);
    const rows = (await kit.call('get_data_store', { store })).json.rows as { id: string; data: Record<string, unknown> }[];
    expect(rows.map((row) => row.data).sort((a, b) => String(a[name.id]).localeCompare(String(b[name.id])))).toEqual([{ [name.id]: 'Bolt' }, { [name.id]: 'Nut' }]);
    expect(kit.storeRepo.rowHistory(inserted.json.ids[0], { projectId: 'p1' })[0]).toMatchObject({ actorKind: 'agent', change: { [qty.id]: { from: 5, to: null } } });
    expect(kit.storeRepo.rowHistory(inserted.json.ids[1], { projectId: 'p1' })).toHaveLength(1);
  });

  it('adds the next column after the last remaining one', async () => {
    const store = await createStore();
    const first = await addColumn(store, { display_name: 'A', column_type: 'text' });
    const second = await addColumn(store, { display_name: 'B', column_type: 'text' });
    await addColumn(store, { display_name: 'C', column_type: 'text' });

    await kit.call('delete_data_store_column', { store, column_id: second.id });
    await addColumn(store, { display_name: 'D', column_type: 'text' });

    const columns = await describeColumns(store);
    expect(columns.map((column) => column.displayName)).toEqual(['A', 'C', 'D']);
    expect(columns[0]?.id).toBe(first.id);
  });

  it('refuses the natural key column and deletes it once the key is cleared', async () => {
    const store = await createStore();
    const key = await addColumn(store, { display_name: 'Name', column_type: 'text', natural_key: true });

    const refused = await kit.call('delete_data_store_column', { store, column_id: key.id });
    await kit.call('set_data_store_natural_key', { store, column: null });
    const deleted = await kit.call('delete_data_store_column', { store, column_id: key.id });

    expect(refused.isError).toBe(true);
    expect(refused.text).toContain('natural key');
    expect(deleted.isError).toBe(false);
    expect(await columnNames(store)).toEqual([]);
  });

  it('refuses a column a view uses and keeps its cells', async () => {
    const store = await createStore();
    const status = await addColumn(store, { display_name: 'Status', column_type: 'select', options: [{ id: 'todo', label: 'To do' }] });
    kit.stores.createView(store, { projectId: 'p1', displayName: 'Board', viewType: 'kanban', config: { groupByColumnId: status.id } });
    await kit.call('insert_data_store_rows', { store, rows: [{ [status.id]: 'todo' }] });

    const result = await kit.call('delete_data_store_column', { store, column_id: status.id });

    expect(result.isError).toBe(true);
    expect(result.text).toContain('Board');
    expect(await columnNames(store)).toEqual(['Status']);
    expect((await kit.call('get_data_store', { store })).json.rows[0].data).toEqual({ [status.id]: 'To do' });
  });

  it('refuses an unknown column naming it', async () => {
    const store = await createStore();

    const result = await kit.call('delete_data_store_column', { store, column_id: 'missing' });

    expect(result.isError).toBe(true);
    expect(result.text).toContain('invalid_body');
    expect(result.text).toContain('Unknown columns: missing');
  });

  const viewsReferencing: [string, (columnId: string) => { viewType: ViewType; config: DsViewConfig }][] = [
    ['a where clause', (columnId) => ({ viewType: 'grid', config: { where: [{ columnId, op: 'eq', value: 'todo' }] } })],
    ['an orderBy term', (columnId) => ({ viewType: 'grid', config: { orderBy: [{ columnId, dir: 'asc' }] } })],
    ['a cardFields entry', (columnId) => ({ viewType: 'grid', config: { cardFields: [columnId] } })],
    ['a groupBy column', (columnId) => ({ viewType: 'kanban', config: { groupByColumnId: columnId } })],
    ['a card title column', (columnId) => ({ viewType: 'grid', config: { cardTitleColumnId: columnId } })],
  ];

  it.each(viewsReferencing)('refuses a column that %s of a view references', async (_reference, viewFor) => {
    const store = await createStore();
    const status = await addColumn(store, { display_name: 'Status', column_type: 'select', options: [{ id: 'todo', label: 'To do' }] });
    kit.stores.createView(store, { projectId: 'p1', displayName: 'Board', ...viewFor(status.id) });

    const result = await kit.call('delete_data_store_column', { store, column_id: status.id });

    expect(result.isError).toBe(true);
    expect(result.text).toContain('is used by the view "Board"');
    expect(await columnNames(store)).toEqual(['Status']);
  });
});

describe('reorder_data_store_columns', () => {
  it('applies a permutation and shows it in the schema', async () => {
    const store = await createStore();
    const a = await addColumn(store, { display_name: 'A', column_type: 'text' });
    const b = await addColumn(store, { display_name: 'B', column_type: 'text' });
    const c = await addColumn(store, { display_name: 'C', column_type: 'text' });

    const result = await kit.call('reorder_data_store_columns', { store, column_ids: [c.id, a.id, b.id] });

    expect(result.isError).toBe(false);
    expect(result.json.columns.map((column: { displayName: string }) => column.displayName)).toEqual(['C', 'A', 'B']);
    expect(await columnNames(store)).toEqual(['C', 'A', 'B']);
  });

  it('refuses a list that misses, repeats or invents a column, names the difference and changes nothing', async () => {
    const store = await createStore();
    const a = await addColumn(store, { display_name: 'A', column_type: 'text' });
    const b = await addColumn(store, { display_name: 'B', column_type: 'text' });

    const missing = await kit.call('reorder_data_store_columns', { store, column_ids: [b.id] });
    const repeated = await kit.call('reorder_data_store_columns', { store, column_ids: [b.id, b.id, a.id] });
    const unknown = await kit.call('reorder_data_store_columns', { store, column_ids: [b.id, a.id, 'ghost'] });

    expect(missing.isError).toBe(true);
    expect(missing.text).toContain(`missing: [${a.id}]`);
    expect(repeated.isError).toBe(true);
    expect(repeated.text).toContain(`repeated: [${b.id}]`);
    expect(unknown.isError).toBe(true);
    expect(unknown.text).toContain('unknown: [ghost]');
    expect(await columnNames(store)).toEqual(['A', 'B']);
  });
});
