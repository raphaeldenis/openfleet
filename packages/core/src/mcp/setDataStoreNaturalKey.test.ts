import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startTableToolsKit, type TableToolsKit } from './tableTools.testkit.js';

let kit: TableToolsKit;

beforeEach(async () => {
  kit = await startTableToolsKit();
});
afterEach(() => kit.close());

async function storeWithKeyColumnCandidates() {
  const { json: store } = await kit.call('create_data_store', { display_name: 'Backlog' });
  const key = (await kit.call('add_data_store_column', { store: store.id, display_name: 'Key', column_type: 'text' })).json;
  await kit.call('add_data_store_column', { store: store.id, display_name: 'Points', column_type: 'number' });
  return { storeId: store.id as string, keyColumnId: key.id as string };
}

const naturalKeyOf = async (store: string) => (await kit.call('describe_data_store', { store })).json.naturalKeyColumnId;

describe('set_data_store_natural_key', () => {
  it('is one of the tools an agent can list, described with what it does', async () => {
    const tools = await kit.listTools();

    const tool = tools.find(({ name }) => name === 'set_data_store_natural_key');
    expect(tool?.description).toMatch(/natural key/i);
  });

  it('makes a text column, named by display name in any case, the natural key of a store named by display name', async () => {
    const { storeId, keyColumnId } = await storeWithKeyColumnCandidates();

    const result = await kit.call('set_data_store_natural_key', { store: 'backlog', column: 'KEY' });

    expect(result.json).toEqual({ id: storeId, displayName: 'Backlog', naturalKeyColumnId: keyColumnId });
    expect(await naturalKeyOf(storeId)).toBe(keyColumnId);
  });

  it('clears the natural key with a null column', async () => {
    const { storeId } = await storeWithKeyColumnCandidates();
    await kit.call('set_data_store_natural_key', { store: storeId, column: 'key' });

    const result = await kit.call('set_data_store_natural_key', { store: storeId, column: null });

    expect(result.json).toEqual({ id: storeId, displayName: 'Backlog' });
    expect(await naturalKeyOf(storeId)).toBeUndefined();
  });

  it('makes the insert default mode refuse a key a row already holds', async () => {
    const { storeId } = await storeWithKeyColumnCandidates();
    await kit.call('set_data_store_natural_key', { store: storeId, column: 'key' });
    await kit.call('insert_data_store_rows', { store: storeId, rows: [{ key: 'A' }] });

    const result = await kit.call('insert_data_store_rows', { store: storeId, rows: [{ key: 'A' }] });

    expect(result.json).toMatchObject({ inserted: 0, failed: 1 });
  });

  it('refuses a column that is not text', async () => {
    const { storeId } = await storeWithKeyColumnCandidates();

    const result = await kit.call('set_data_store_natural_key', { store: storeId, column: 'points' });

    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/^error invalid_body: .*text column/);
    expect(await naturalKeyOf(storeId)).toBeUndefined();
  });

  it('refuses an unknown column', async () => {
    const { storeId } = await storeWithKeyColumnCandidates();

    const result = await kit.call('set_data_store_natural_key', { store: storeId, column: 'nope' });

    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/nope/);
  });

  it('refuses a column whose values already repeat between rows, and keeps the previous key', async () => {
    const { storeId, keyColumnId } = await storeWithKeyColumnCandidates();
    await kit.call('insert_data_store_rows', { store: storeId, rows: [{ key: 'A' }, { key: 'A' }] });

    const result = await kit.call('set_data_store_natural_key', { store: storeId, column: keyColumnId });

    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/share a value/);
    expect(await naturalKeyOf(storeId)).toBeUndefined();
  });

  it('fails on a store that does not exist', async () => {
    const result = await kit.call('set_data_store_natural_key', { store: 'missing', column: 'key' });

    expect(result.isError).toBe(true);
  });
});
