import { afterEach, describe, expect, it } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import { openDatabase } from '../db/database.js';
import { ProjectRepository } from '../projects/projectRepository.js';
import { DataStoreRepository, RowNotFoundError, StoreNotFoundError } from './dataStoreRepository.js';
import { AmbiguousNaturalKeyError, DataStoreService, InvalidColumnDefinitionError, NoNaturalKeyError } from './dataStoreService.js';

const scope = { projectId: 'p1' } as const;
const human = { kind: 'human', label: 'You' } as const;

const openDatabases: DatabaseSync[] = [];
afterEach(() => openDatabases.splice(0).forEach((db) => db.close()));

function setup() {
  const db = openDatabase(':memory:');
  openDatabases.push(db);
  const projects = new ProjectRepository(db);
  projects.insert({ id: 'p1', name: 'One', docsFolderPath: null, createdAt: 't0' });
  projects.insert({ id: 'p2', name: 'Two', docsFolderPath: null, createdAt: 't0' });
  const repo = new DataStoreRepository(db);
  let counter = 0;
  const service = new DataStoreService({ repo, db, clock: () => '2026-01-01T00:00:00.000Z', newId: () => `id-${++counter}` });
  const store = service.createStore({ ...scope, displayName: 'backlog' });
  const idColumn = service.addColumn(store.id, { ...scope, displayName: 'id', columnType: 'text' });
  const priorityColumn = service.addColumn(store.id, { ...scope, displayName: 'priority', columnType: 'number' });
  return { repo, service, store, idColumn, priorityColumn };
}

describe('a data store natural key', () => {
  it('is absent on a new store', () => {
    const { repo, store } = setup();

    expect(repo.findStore(store.id)?.naturalKeyColumnId).toBeUndefined();
  });

  it('is the text column the store was given, and is cleared with null', () => {
    const { repo, service, store, idColumn } = setup();

    service.setNaturalKey(store.id, { ...scope, columnId: idColumn.id });
    const withKey = repo.findStore(store.id)?.naturalKeyColumnId;
    service.setNaturalKey(store.id, { ...scope, columnId: null });
    const afterClearing = repo.findStore(store.id)?.naturalKeyColumnId;

    expect(withKey).toBe(idColumn.id);
    expect(afterClearing).toBeUndefined();
  });

  it('refuses a column that is not text', () => {
    const { service, store, priorityColumn } = setup();

    const setNumberColumn = () => service.setNaturalKey(store.id, { ...scope, columnId: priorityColumn.id });

    expect(setNumberColumn).toThrow(InvalidColumnDefinitionError);
  });

  it('refuses a column of another store or one that does not exist', () => {
    const { service, store } = setup();
    const otherStore = service.createStore({ ...scope, displayName: 'other' });
    const foreignColumn = service.addColumn(otherStore.id, { ...scope, displayName: 'id', columnType: 'text' });

    const setForeignColumn = () => service.setNaturalKey(store.id, { ...scope, columnId: foreignColumn.id });
    const setUnknownColumn = () => service.setNaturalKey(store.id, { ...scope, columnId: 'nope' });

    expect(setForeignColumn).toThrow(InvalidColumnDefinitionError);
    expect(setUnknownColumn).toThrow(InvalidColumnDefinitionError);
  });

  it('cannot be set on a store of another project', () => {
    const { service, store, idColumn } = setup();

    const setFromOtherProject = () => service.setNaturalKey(store.id, { projectId: 'p2', columnId: idColumn.id });

    expect(setFromOtherProject).toThrow(StoreNotFoundError);
  });
});

describe('finding a row by natural key', () => {
  it('returns the row whose natural key cell equals the key exactly', () => {
    const { service, store, idColumn } = setup();
    service.setNaturalKey(store.id, { ...scope, columnId: idColumn.id });
    const [first, second] = service.insertRows(store.id, { ...scope, actor: human, items: [{ [idColumn.id]: 'IT-1' }, { [idColumn.id]: 'IT-2' }] });

    const found = service.findRowByNaturalKey(store.id, { ...scope, key: 'IT-2' });

    expect(first!.id).not.toBe(second!.id);
    expect(found.id).toBe(second!.id);
  });

  it('does not match a key that differs by case', () => {
    const { service, store, idColumn } = setup();
    service.setNaturalKey(store.id, { ...scope, columnId: idColumn.id });
    service.insertRows(store.id, { ...scope, actor: human, items: [{ [idColumn.id]: 'IT-1' }] });

    const findLowerCase = () => service.findRowByNaturalKey(store.id, { ...scope, key: 'it-1' });

    expect(findLowerCase).toThrow(RowNotFoundError);
  });

  it('refuses a key no row holds', () => {
    const { service, store, idColumn } = setup();
    service.setNaturalKey(store.id, { ...scope, columnId: idColumn.id });

    const findMissing = () => service.findRowByNaturalKey(store.id, { ...scope, key: 'IT-404' });

    expect(findMissing).toThrow(RowNotFoundError);
  });

  it('refuses a key held by several rows', () => {
    const { repo, service, store, idColumn } = setup();
    service.setNaturalKey(store.id, { ...scope, columnId: idColumn.id });
    for (const id of ['legacy-first', 'legacy-second']) repo.insertRow(store.id, { id, actor: human, at: '2026-01-01T00:00:00.000Z', data: { [idColumn.id]: 'IT-1' } });

    const findDuplicated = () => service.findRowByNaturalKey(store.id, { ...scope, key: 'IT-1' });

    expect(findDuplicated).toThrow(AmbiguousNaturalKeyError);
  });

  it('refuses a store that has no natural key', () => {
    const { service, store } = setup();

    const findWithoutKey = () => service.findRowByNaturalKey(store.id, { ...scope, key: 'IT-1' });

    expect(findWithoutKey).toThrow(NoNaturalKeyError);
  });

  it('cannot reach a store of another project', () => {
    const { service, store, idColumn } = setup();
    service.setNaturalKey(store.id, { ...scope, columnId: idColumn.id });

    const findFromOtherProject = () => service.findRowByNaturalKey(store.id, { projectId: 'p2', key: 'IT-1' });

    expect(findFromOtherProject).toThrow(StoreNotFoundError);
  });
});
