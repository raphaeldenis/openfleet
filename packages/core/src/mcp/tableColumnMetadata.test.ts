import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startTableToolsKit, type TableToolsKit } from './tableTools.testkit.js';

let kit: TableToolsKit;
beforeEach(async () => { kit = await startTableToolsKit(); });
afterEach(async () => { await kit.close(); });

const createStore = async (display_name = 'Stock') => (await kit.call('create_data_store', { display_name })).json.id as string;
const addColumn = async (store: string, args: Record<string, unknown>) => (await kit.call('add_data_store_column', { store, ...args })).json;
const describedColumn = async (store: string, columnId: string) =>
  ((await kit.call('describe_data_store', { store })).json.columns as { id: string; columnType: string }[]).find((column) => column.id === columnId)!;
const update = (store: string, column_id: string, changes: Record<string, unknown>) => kit.call('update_data_store_column', { store, column_id, ...changes });

describe('update_data_store_column metadata', () => {
  it('persists required, display width, wrap, format and config and reads them back through describe and get', async () => {
    const store = await createStore();
    const price = await addColumn(store, { display_name: 'Price', column_type: 'number' });

    const result = await update(store, price.id, {
      required: true, display_width: 240, wrap_mode: 'wrap', wrap_max_lines: 3, format: 'rank', config: { symbol: '€', decimals: 2, ratingMax: 5, ratingIcon: 'star' },
    });

    const expected = { required: true, displayWidth: 240, wrap: { mode: 'wrap', maxLines: 3 }, format: 'rank', config: { symbol: '€', decimals: 2, ratingMax: 5, ratingIcon: 'star' } };
    expect(result.isError).toBe(false);
    expect(result.json).toMatchObject(expected);
    expect(await describedColumn(store, price.id)).toMatchObject(expected);
    expect(((await kit.call('get_data_store', { store })).json.columns as { id: string }[]).find((column) => column.id === price.id)).toMatchObject(expected);
  });

  it('clears display column, format, config and width, and resets wrap with truncate', async () => {
    const store = await createStore();
    const label = await addColumn(store, { display_name: 'Label', column_type: 'text' });
    const price = await addColumn(store, { display_name: 'Price', column_type: 'number' });
    await update(store, price.id, { required: true, display_column_id: label.id, format: 'rank', config: { decimals: 1 }, display_width: 100, wrap_mode: 'wrap', wrap_max_lines: 2 });

    const cleared = await update(store, price.id, { required: false, clear_display_column_id: true, clear_format: true, clear_config: true, clear_display_width: true, wrap_mode: 'truncate' });

    expect(cleared.isError).toBe(false);
    for (const field of ['displayColumnId', 'format', 'config', 'displayWidth', 'wrap']) expect(cleared.json).not.toHaveProperty(field);
    expect(cleared.json.required ?? false).toBe(false);
    expect(await describedColumn(store, price.id)).toEqual(cleared.json);
  });

  it('keeps an untouched metadata field when another one changes', async () => {
    const store = await createStore();
    const price = await addColumn(store, { display_name: 'Price', column_type: 'number' });
    await update(store, price.id, { display_width: 300, required: true });

    const renamed = await update(store, price.id, { name: 'Cost' });

    expect(renamed.json).toMatchObject({ displayName: 'Cost', displayWidth: 300, required: true });
  });

  it.each([
    ['a width under 60', { display_width: 59 }],
    ['a width over 1200', { display_width: 1201 }],
    ['wrap lines under 1', { wrap_mode: 'wrap', wrap_max_lines: 0 }],
    ['wrap lines over 100', { wrap_mode: 'wrap', wrap_max_lines: 101 }],
    ['wrap lines with truncate', { wrap_mode: 'truncate', wrap_max_lines: 2 }],
    ['wrap lines without a wrap mode', { wrap_max_lines: 2 }],
    ['a symbol over 8 characters', { config: { symbol: '123456789' } }],
    ['decimals over 10', { config: { decimals: 11 } }],
    ['negative decimals', { config: { decimals: -1 } }],
    ['ratingMax over 10', { config: { ratingMax: 11 } }],
    ['ratingMax under 1', { config: { ratingMax: 0 } }],
    ['a ratingIcon over 32 characters', { config: { ratingIcon: 'x'.repeat(33) } }],
    ['an unknown config key', { config: { colour: 'red' } }],
    ['config together with clear_config', { config: { decimals: 1 }, clear_config: true }],
    ['a format with its clear flag', { format: 'rank', clear_format: true }],
    ['a width with its clear flag', { display_width: 100, clear_display_width: true }],
    ['a display column with its clear flag', { display_column_id: 'x', clear_display_column_id: true }],
  ])('refuses %s and changes nothing', async (_label, changes) => {
    const store = await createStore();
    const price = await addColumn(store, { display_name: 'Price', column_type: 'number' });
    const before = await describedColumn(store, price.id);

    const result = await update(store, price.id, { required: true, ...changes });

    expect(result.isError).toBe(true);
    expect(await describedColumn(store, price.id)).toEqual(before);
  });

  it('refuses a format that does not match the column type', async () => {
    const store = await createStore();
    const label = await addColumn(store, { display_name: 'Label', column_type: 'text' });

    const result = await update(store, label.id, { required: true, format: 'rank' });

    expect(result.isError).toBe(true);
    expect(result.text).toContain('The format must match the column type');
    expect(await describedColumn(store, label.id)).not.toHaveProperty('required');
  });

  it('refuses a config on a column that is not a number', async () => {
    const store = await createStore();
    const label = await addColumn(store, { display_name: 'Label', column_type: 'text' });

    const result = await update(store, label.id, { config: { symbol: '$' } });

    expect(result.isError).toBe(true);
    expect(await describedColumn(store, label.id)).not.toHaveProperty('config');
  });

  it('refuses a display column that is unknown or the column itself, leaving the rest of the change undone', async () => {
    const store = await createStore();
    const price = await addColumn(store, { display_name: 'Price', column_type: 'number' });

    const unknown = await update(store, price.id, { required: true, display_column_id: 'missing' });
    const itself = await update(store, price.id, { required: true, display_column_id: price.id });

    expect(unknown.isError).toBe(true);
    expect(itself.isError).toBe(true);
    expect(await describedColumn(store, price.id)).not.toHaveProperty('required');
  });

  it('accepts a display column given by display name and stores its id', async () => {
    const store = await createStore();
    const label = await addColumn(store, { display_name: 'Label', column_type: 'text' });
    const price = await addColumn(store, { display_name: 'Price', column_type: 'number' });

    const result = await update(store, price.id, { display_column_id: 'label' });

    expect(result.json.displayColumnId).toBe(label.id);
  });

  it('blocks deleting a column another column uses as its display column, then allows it once cleared', async () => {
    const store = await createStore();
    const label = await addColumn(store, { display_name: 'Label', column_type: 'text' });
    const price = await addColumn(store, { display_name: 'Price', column_type: 'number' });
    await update(store, price.id, { display_column_id: label.id });

    const blocked = await kit.call('delete_data_store_column', { store, column_id: label.id });
    await update(store, price.id, { clear_display_column_id: true });
    const allowed = await kit.call('delete_data_store_column', { store, column_id: label.id });

    expect(blocked.isError).toBe(true);
    expect(blocked.text).toContain('display column');
    expect(allowed.isError).toBe(false);
  });

  it('keeps a column type unchanged when a retype is attempted', async () => {
    const store = await createStore();
    const label = await addColumn(store, { display_name: 'Label', column_type: 'text' });

    const retypeOnly = await update(store, label.id, { column_type: 'number' });
    const retypeWithChange = await update(store, label.id, { column_type: 'number', required: true });

    expect(retypeOnly.isError).toBe(true);
    expect(retypeWithChange.json.columnType).toBe('text');
    expect((await describedColumn(store, label.id)).columnType).toBe('text');
  });

  it('refuses a column of a store of another project and writes nothing', async () => {
    kit.db.prepare("INSERT INTO projects (id, name, created_at) VALUES ('p2', 'Two', 't0')").run();
    const foreignStore = kit.stores.createStore({ projectId: 'p2', displayName: 'Foreign' });
    const foreignColumn = kit.stores.addColumn(foreignStore.id, { projectId: 'p2', displayName: 'Qty', columnType: 'number' });

    const result = await update(foreignStore.id, foreignColumn.id, { required: true, display_width: 200 });

    expect(result.isError).toBe(true);
    expect(kit.storeRepo.listColumns(foreignStore.id)[0]).not.toHaveProperty('required');
    expect(kit.storeRepo.listColumns(foreignStore.id)[0]).not.toHaveProperty('displayWidth');
  });

  it('refuses an option color that is not #RGB, #RRGGBB or #RRGGBBAA, and accepts those three', async () => {
    const store = await createStore();
    const status = await addColumn(store, { display_name: 'Status', column_type: 'select', options: [{ id: 'a', label: 'A' }] });

    const named = await update(store, status.id, { options: [{ label: 'A', color: 'green' }] });
    const badHex = await update(store, status.id, { options: [{ label: 'A', color: '#12345' }] });
    const accepted = await update(store, status.id, { options: [{ label: 'A', color: '#abc' }, { label: 'B', color: '#A1B2C3' }, { label: 'C', color: '#A1B2C3D4' }] });

    expect(named.isError).toBe(true);
    expect(badHex.isError).toBe(true);
    expect(accepted.json.options.map((option: { color: string }) => option.color)).toEqual(['#abc', '#A1B2C3', '#A1B2C3D4']);
  });

  it('refuses more than 500 options and accepts exactly 500', async () => {
    const store = await createStore();
    const status = await addColumn(store, { display_name: 'Status', column_type: 'select', options: [{ id: 'a', label: 'A' }] });
    const optionsOf = (count: number) => Array.from({ length: count }, (_, index) => ({ label: `Option ${index}` }));

    const tooMany = await update(store, status.id, { options: optionsOf(501) });
    const exactly = await update(store, status.id, { options: optionsOf(500) });

    expect(tooMany.isError).toBe(true);
    expect(exactly.isError).toBe(false);
    expect(exactly.json.options).toHaveLength(500);
  });
});
