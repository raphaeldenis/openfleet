import { describe, expect, it } from 'vitest';
import { openDatabase } from '../db/database.js';
import { ProjectRepository } from '../projects/projectRepository.js';
import { DataStoreRepository } from './dataStoreRepository.js';
import { DataStoreService, type ObservedRowWrite } from './dataStoreService.js';

const scope = { projectId: 'p1' } as const;
const human = { kind: 'human', label: 'You' } as const;

function setup() {
  const db = openDatabase(':memory:');
  new ProjectRepository(db).insert({ id: 'p1', name: 'One', docsFolderPath: null, createdAt: 't0' });
  let counter = 0;
  const service = new DataStoreService({ repo: new DataStoreRepository(db), db, clock: () => '2026-01-01T00:00:00.000Z', newId: () => `id-${++counter}` });
  const store = service.createStore({ ...scope, displayName: 'backlog' });
  const column = service.addColumn(store.id, { ...scope, displayName: 'status', columnType: 'text' });
  const heard: ObservedRowWrite[] = [];
  const rowData = (rowId: string) => (db.prepare('SELECT data_json FROM ds_rows WHERE id = ?').get(rowId) as { data_json: string }).data_json;
  const observeWith = (onWrite: (write: ObservedRowWrite) => void) => service.observeRowWrites({ observeRowWrite: onWrite });
  observeWith((write) => heard.push(write));
  return { service, store, column, heard, rowData, observeWith };
}

describe('the row write observer of the data store service', () => {
  it('hears a row update once the row holds the patch', () => {
    const { service, store, column, rowData, observeWith } = setup();
    const row = service.insertRow(store.id, { ...scope, data: { [column.id]: 'draft' }, actor: human });
    let storedWhenHeard: string | undefined;
    observeWith(() => { storedWhenHeard = rowData(row.id); });

    service.updateRow(store.id, row.id, { ...scope, patch: { [column.id]: 'approved' }, actor: human });

    expect(storedWhenHeard).toContain('approved');
  });

  it('hears nothing when the update fails because the row does not exist', () => {
    const { service, store, column, heard } = setup();

    expect(() => service.updateRow(store.id, 'no-such-row', { ...scope, patch: { [column.id]: 'approved' }, actor: human })).toThrow();

    expect(heard).toEqual([]);
  });

  it('hears nothing of a batch of updates that fails on its second row', () => {
    const { service, store, column, heard } = setup();
    const row = service.insertRow(store.id, { ...scope, data: { [column.id]: 'draft' }, actor: human });
    heard.length = 0;

    expect(() => service.updateRows(store.id, { ...scope, actor: human, items: [{ rowId: row.id, patch: { [column.id]: 'approved' } }, { rowId: 'no-such-row', patch: { [column.id]: 'approved' } }] })).toThrow();

    expect(heard).toEqual([]);
  });

  it('hears each row of a batch that succeeds', () => {
    const { service, store, column, heard } = setup();

    service.insertRows(store.id, { ...scope, actor: human, items: [{ [column.id]: 'a' }, { [column.id]: 'b' }] });

    expect(heard.map(({ cells }) => cells[column.id])).toEqual(['a', 'b']);
  });
});
