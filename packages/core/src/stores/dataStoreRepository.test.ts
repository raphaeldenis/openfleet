import { describe, expect, it } from 'vitest';
import type { RowActorKind } from '@openfleet/shared';
import { openDatabase } from '../db/database.js';
import { ProjectRepository } from '../projects/projectRepository.js';
import { DataStoreRepository, DuplicateNameError, RowNotFoundError, StoreNotFoundError, UnknownColumnError } from './dataStoreRepository.js';

const owningProject = { projectId: 'p1' } as const;
const human = { kind: 'human', label: 'You' } as const;
const agent = { kind: 'agent', label: '⛏️ Gimli · T6' } as const;

function openRepositoryWithDatabase() {
  const db = openDatabase(':memory:');
  const projects = new ProjectRepository(db);
  projects.insert({ id: 'p1', name: 'One', docsFolderPath: null, createdAt: 't0' });
  projects.insert({ id: 'p2', name: 'Two', docsFolderPath: null, createdAt: 't0' });
  return { db, repository: new DataStoreRepository(db) };
}

function openRepository() {
  return openRepositoryWithDatabase().repository;
}

function thrownBy(work: () => unknown): unknown {
  try {
    work();
  } catch (error) {
    return error;
  }
  return undefined;
}

function createBacklogWithStatusColumn(repository: DataStoreRepository) {
  const store = repository.createStore({ id: 's1', projectId: 'p1', displayName: 'backlog', at: 't0' });
  const status = repository.addColumn(store.id, {
    id: 'c-status',
    displayName: 'status',
    columnType: 'select',
    options: [{ id: 'todo', label: 'todo' }, { id: 'done', label: 'done' }],
    at: 't0',
  });
  return { store, status };
}

describe('DataStoreRepository', () => {
  describe('stores and columns', () => {
    it('creates a store and lists its columns in the order they were added', () => {
      const repository = openRepository();
      const store = repository.createStore({ id: 's1', projectId: 'p1', displayName: 'backlog', at: 't0' });

      repository.addColumn(store.id, { id: 'c1', displayName: 'title', columnType: 'text', at: 't1' });
      repository.addColumn(store.id, { id: 'c2', displayName: 'priority', columnType: 'number', at: 't2' });

      expect(store).toEqual({ id: 's1', projectId: 'p1', displayName: 'backlog', createdAt: 't0', updatedAt: 't0' });
      expect(repository.listColumns(store.id)).toEqual([
        { id: 'c1', storeId: 's1', displayName: 'title', columnType: 'text', options: null, sortOrder: 0 },
        { id: 'c2', storeId: 's1', displayName: 'priority', columnType: 'number', options: null, sortOrder: 1 },
      ]);
    });

    it('keeps the options of a select column', () => {
      const repository = openRepository();
      const { store, status } = createBacklogWithStatusColumn(repository);

      expect(repository.listColumns(store.id)).toEqual([status]);
      expect(status.options).toEqual([{ id: 'todo', label: 'todo' }, { id: 'done', label: 'done' }]);
    });

    it('lists columns added at the same timestamp with descending ids in insertion order', () => {
      const repository = openRepository();
      const { store } = createBacklogWithStatusColumn(repository);
      repository.addColumn(store.id, { id: 'c-z', displayName: 'first', columnType: 'text', at: 't0' });
      repository.addColumn(store.id, { id: 'c-y', displayName: 'second', columnType: 'text', at: 't0' });
      repository.addColumn(store.id, { id: 'c-x', displayName: 'third', columnType: 'text', at: 't0' });

      const columnIdsInListOrder = repository.listColumns(store.id).map((column) => column.id);

      expect(columnIdsInListOrder).toEqual(['c-status', 'c-z', 'c-y', 'c-x']);
    });

    it('lists only its own columns and rows when several stores exist', () => {
      const repository = openRepository();
      const { store, status } = createBacklogWithStatusColumn(repository);
      const otherStore = repository.createStore({ id: 's2', projectId: 'p1', displayName: 'other', at: 't0' });
      const otherColumn = repository.addColumn(otherStore.id, { id: 'c-other', displayName: 'notes', columnType: 'text', at: 't0' });
      const row = repository.insertRow(store.id, { id: 'r1', data: { [status.id]: 'todo' }, actor: human, at: 't1' });
      const otherRow = repository.insertRow(otherStore.id, { id: 'r2', data: { [otherColumn.id]: 'hi' }, actor: human, at: 't1' });

      expect(repository.listColumns(store.id)).toEqual([status]);
      expect(repository.listColumns(otherStore.id)).toEqual([otherColumn]);
      expect(repository.listRows(store.id)).toEqual([row]);
      expect(repository.listRows(otherStore.id)).toEqual([otherRow]);
    });

    it('finds a store by id together with its project', () => {
      const repository = openRepository();
      const { store } = createBacklogWithStatusColumn(repository);

      expect(repository.findStore(store.id)).toEqual(store);
      expect(repository.findStore(store.id)?.projectId).toBe('p1');
      expect(repository.findStore('ghost-store')).toBeUndefined();
    });

    it('throws a typed not-found when adding a column to a store that does not exist', () => {
      const repository = openRepository();

      const addition = () => repository.addColumn('ghost-store', { id: 'c1', displayName: 'title', columnType: 'text', at: 't1' });

      expect(addition).toThrow(StoreNotFoundError);
    });

    it('throws a typed duplicate-name error carrying the name when a project already has a store of that name, whatever the case', () => {
      const repository = openRepository();
      createBacklogWithStatusColumn(repository);

      const creation = () => repository.createStore({ id: 's2', projectId: 'p1', displayName: 'BACKLOG', at: 't1' });

      const error = thrownBy(creation);
      expect(error).toBeInstanceOf(DuplicateNameError);
      expect(error).toMatchObject({ displayName: 'BACKLOG' });
      expect((error as Error).message).not.toMatch(/constraint|index/i);
    });

    it('lets two projects each have a store of the same name', () => {
      const repository = openRepository();
      createBacklogWithStatusColumn(repository);

      const otherProjectStore = repository.createStore({ id: 's2', projectId: 'p2', displayName: 'backlog', at: 't1' });

      expect(otherProjectStore.projectId).toBe('p2');
    });

    it('throws a typed duplicate-name error carrying the name when a store already has a column of that name, whatever the case', () => {
      const repository = openRepository();
      const { store } = createBacklogWithStatusColumn(repository);

      const addition = () => repository.addColumn(store.id, { id: 'c2', displayName: 'STATUS', columnType: 'text', at: 't1' });

      const error = thrownBy(addition);
      expect(error).toBeInstanceOf(DuplicateNameError);
      expect(error).toMatchObject({ displayName: 'STATUS' });
      expect((error as Error).message).not.toMatch(/constraint|index/i);
    });

    it('leaves other constraint failures, such as a duplicate id, as the raw database error', () => {
      const repository = openRepository();
      const { store } = createBacklogWithStatusColumn(repository);

      const creation = () => repository.createStore({ id: store.id, projectId: 'p1', displayName: 'another', at: 't1' });

      expect(creation).toThrow(/constraint/i);
      expect(creation).not.toThrow(DuplicateNameError);
    });
  });

  describe('insertRow', () => {
    it('stores the row and writes one history entry of kind create with its actor', () => {
      const repository = openRepository();
      const { store, status } = createBacklogWithStatusColumn(repository);

      const row = repository.insertRow(store.id, { id: 'r1', data: { [status.id]: 'todo' }, actor: human, at: 't1' });

      expect(row).toEqual({ id: 'r1', storeId: 's1', data: { [status.id]: 'todo' }, createdAt: 't1', updatedAt: 't1' });
      expect(repository.listRows(store.id)).toEqual([row]);
      expect(repository.rowHistory(row.id, owningProject)).toEqual([
        expect.objectContaining({ rowId: 'r1', actorKind: 'human', actorLabel: 'You', change: { kind: 'create' }, createdAt: 't1' }),
      ]);
    });

    it('throws a typed not-found for a store that does not exist, before looking at the columns', () => {
      const repository = openRepository();

      const insertion = () => repository.insertRow('ghost-store', { id: 'r1', data: { 'c-ghost': 'x' }, actor: human, at: 't1' });

      expect(insertion).toThrow(StoreNotFoundError);
      expect(repository.rowHistory('r1', owningProject)).toEqual([]);
    });

    it('refuses data keyed by a column the store does not have, and stores nothing', () => {
      const repository = openRepository();
      const { store } = createBacklogWithStatusColumn(repository);

      const insertion = () => repository.insertRow(store.id, { id: 'r1', data: { 'c-ghost': 'x' }, actor: human, at: 't1' });

      expect(insertion).toThrow(UnknownColumnError);
      expect(repository.listRows(store.id)).toEqual([]);
    });

    it('returns exactly the row listRows returns, cells normalized the way JSON stores them', () => {
      const repository = openRepository();
      const { store } = createBacklogWithStatusColumn(repository);
      const payload = repository.addColumn(store.id, { id: 'c-payload', displayName: 'payload', columnType: 'json', at: 't0' });
      const data = { [payload.id]: { when: new Date(0), notANumber: Number.NaN, negativeZero: -0, dropped: undefined } };

      const row = repository.insertRow(store.id, { id: 'r1', data, actor: human, at: 't1' });

      expect(row.data).toEqual({ [payload.id]: { when: '1970-01-01T00:00:00.000Z', notANumber: null, negativeZero: 0 } });
      expect(repository.listRows(store.id)).toEqual([row]);
    });

    it('drops a cell set to undefined instead of storing it', () => {
      const repository = openRepository();
      const { store, status } = createBacklogWithStatusColumn(repository);

      const row = repository.insertRow(store.id, { id: 'r1', data: { [status.id]: undefined }, actor: human, at: 't1' });

      expect(row.data).toEqual({});
      expect(Object.keys(row.data)).toEqual([]);
      expect(repository.listRows(store.id)).toEqual([row]);
    });
  });

  describe('updateRow', () => {
    it('records the actor alongside a from/to diff and merges the patch into the row', () => {
      const repository = openRepository();
      const { store, status } = createBacklogWithStatusColumn(repository);
      const row = repository.insertRow(store.id, { id: 'r1', data: { [status.id]: 'todo' }, actor: human, at: 't1' });

      const updated = repository.updateRow(row.id, { storeId: store.id, patch: { [status.id]: 'done' }, actor: agent, at: 't2' });

      const [latest] = repository.rowHistory(row.id, owningProject);
      expect(latest).toMatchObject({ actorKind: 'agent', actorLabel: '⛏️ Gimli · T6', change: { [status.id]: { from: 'todo', to: 'done' } }, createdAt: 't2' });
      expect(updated).toEqual({ id: 'r1', storeId: 's1', data: { [status.id]: 'done' }, createdAt: 't1', updatedAt: 't2' });
      expect(repository.listRows(store.id)).toEqual([updated]);
    });

    it('omits the keys whose value does not change from the diff', () => {
      const repository = openRepository();
      const { store, status } = createBacklogWithStatusColumn(repository);
      const title = repository.addColumn(store.id, { id: 'c-title', displayName: 'title', columnType: 'text', at: 't0' });
      const row = repository.insertRow(store.id, { id: 'r1', data: { [status.id]: 'todo', [title.id]: 'ship it' }, actor: human, at: 't1' });

      repository.updateRow(row.id, { storeId: store.id, patch: { [status.id]: 'done', [title.id]: 'ship it' }, actor: human, at: 't2' });

      const [latest] = repository.rowHistory(row.id, owningProject);
      expect(latest!.change).toEqual({ [status.id]: { from: 'todo', to: 'done' } });
    });

    it('records a previously empty cell as changing from null', () => {
      const repository = openRepository();
      const { store, status } = createBacklogWithStatusColumn(repository);
      const row = repository.insertRow(store.id, { id: 'r1', data: {}, actor: human, at: 't1' });

      repository.updateRow(row.id, { storeId: store.id, patch: { [status.id]: 'todo' }, actor: human, at: 't2' });

      const [latest] = repository.rowHistory(row.id, owningProject);
      expect(latest!.change).toEqual({ [status.id]: { from: null, to: 'todo' } });
    });

    it('treats a structurally equal json value as unchanged', () => {
      const repository = openRepository();
      const { store } = createBacklogWithStatusColumn(repository);
      const payload = repository.addColumn(store.id, { id: 'c-payload', displayName: 'payload', columnType: 'json', at: 't0' });
      const row = repository.insertRow(store.id, { id: 'r1', data: { [payload.id]: { a: 1, b: [2] } }, actor: human, at: 't1' });

      repository.updateRow(row.id, { storeId: store.id, patch: { [payload.id]: { a: 1, b: [2] } }, actor: human, at: 't2' });

      expect(repository.rowHistory(row.id, owningProject)).toHaveLength(1);
    });

    it('writes no history entry and leaves updated_at alone when the patch changes nothing', () => {
      const repository = openRepository();
      const { store, status } = createBacklogWithStatusColumn(repository);
      const row = repository.insertRow(store.id, { id: 'r1', data: { [status.id]: 'todo' }, actor: human, at: 't1' });

      const unchanged = repository.updateRow(row.id, { storeId: store.id, patch: { [status.id]: 'todo' }, actor: agent, at: 't2' });

      expect(unchanged).toEqual(row);
      expect(repository.rowHistory(row.id, owningProject)).toHaveLength(1);
      expect(repository.listRows(store.id)[0]!.updatedAt).toBe('t1');
    });

    it('throws a typed not-found for a row that does not exist and writes no history', () => {
      const repository = openRepository();

      const update = () => repository.updateRow('ghost', { storeId: 's1', patch: {}, actor: human, at: 't1' });

      expect(update).toThrow(RowNotFoundError);
      expect(repository.rowHistory('ghost', owningProject)).toEqual([]);
    });

    it('refuses a patch keyed by a column the store does not have, and changes nothing', () => {
      const repository = openRepository();
      const { store, status } = createBacklogWithStatusColumn(repository);
      const row = repository.insertRow(store.id, { id: 'r1', data: { [status.id]: 'todo' }, actor: human, at: 't1' });

      const update = () => repository.updateRow(row.id, { storeId: store.id, patch: { [status.id]: 'done', 'c-ghost': 1 }, actor: human, at: 't2' });

      expect(update).toThrow(UnknownColumnError);
      expect(repository.listRows(store.id)).toEqual([row]);
      expect(repository.rowHistory(row.id, owningProject)).toHaveLength(1);
    });

    it('keeps the cells the patch does not mention', () => {
      const repository = openRepository();
      const { store, status } = createBacklogWithStatusColumn(repository);
      const title = repository.addColumn(store.id, { id: 'c-title', displayName: 'title', columnType: 'text', at: 't0' });
      const row = repository.insertRow(store.id, { id: 'r1', data: { [status.id]: 'todo', [title.id]: 'ship it' }, actor: human, at: 't1' });

      const updated = repository.updateRow(row.id, { storeId: store.id, patch: { [status.id]: 'done' }, actor: human, at: 't2' });

      expect(updated.data).toEqual({ [status.id]: 'done', [title.id]: 'ship it' });
      expect(repository.listRows(store.id)).toEqual([updated]);
    });

    it('refuses a row that belongs to another store, and writes nothing', () => {
      const repository = openRepository();
      const { store, status } = createBacklogWithStatusColumn(repository);
      const otherStore = repository.createStore({ id: 's2', projectId: 'p2', displayName: 'other', at: 't0' });
      const row = repository.insertRow(store.id, { id: 'r1', data: { [status.id]: 'todo' }, actor: human, at: 't1' });

      const update = () => repository.updateRow(row.id, { storeId: otherStore.id, patch: { [status.id]: 'done' }, actor: agent, at: 't2' });

      expect(update).toThrow(RowNotFoundError);
      expect(repository.listRows(store.id)).toEqual([row]);
      expect(repository.rowHistory(row.id, owningProject)).toHaveLength(1);
    });

    it('treats a cell set to undefined as no change: nothing is written and updated_at stays', () => {
      const repository = openRepository();
      const { store, status } = createBacklogWithStatusColumn(repository);
      const row = repository.insertRow(store.id, { id: 'r1', data: { [status.id]: 'todo' }, actor: human, at: 't1' });

      const unchanged = repository.updateRow(row.id, { storeId: store.id, patch: { [status.id]: undefined }, actor: agent, at: 't2' });

      expect(unchanged).toEqual(row);
      expect(repository.rowHistory(row.id, owningProject)).toHaveLength(1);
      expect(repository.listRows(store.id)).toEqual([row]);
    });

    it('clears a cell only through an explicit null', () => {
      const repository = openRepository();
      const { store, status } = createBacklogWithStatusColumn(repository);
      const row = repository.insertRow(store.id, { id: 'r1', data: { [status.id]: 'todo' }, actor: human, at: 't1' });

      const cleared = repository.updateRow(row.id, { storeId: store.id, patch: { [status.id]: null }, actor: human, at: 't2' });

      const [latest] = repository.rowHistory(row.id, owningProject);
      expect(latest!.change).toEqual({ [status.id]: { from: 'todo', to: null } });
      expect(cleared.data).toEqual({ [status.id]: null });
    });

    it('returns exactly the row listRows returns, cells normalized the way JSON stores them', () => {
      const repository = openRepository();
      const { store } = createBacklogWithStatusColumn(repository);
      const payload = repository.addColumn(store.id, { id: 'c-payload', displayName: 'payload', columnType: 'json', at: 't0' });
      const row = repository.insertRow(store.id, { id: 'r1', data: {}, actor: human, at: 't1' });

      const updated = repository.updateRow(row.id, { storeId: store.id, patch: { [payload.id]: { when: new Date(0), negativeZero: -0 } }, actor: human, at: 't2' });

      expect(updated.data).toEqual({ [payload.id]: { when: '1970-01-01T00:00:00.000Z', negativeZero: 0 } });
      expect(repository.listRows(store.id)).toEqual([updated]);
    });

    it('records a json cell change when a nested value changes, when the type changes, and not when only the key order differs', () => {
      const repository = openRepository();
      const { store } = createBacklogWithStatusColumn(repository);
      const payload = repository.addColumn(store.id, { id: 'c-payload', displayName: 'payload', columnType: 'json', at: 't0' });
      const row = repository.insertRow(store.id, { id: 'r1', data: { [payload.id]: { a: 1, b: 2 } }, actor: human, at: 't1' });
      const patchPayloadWith = (value: unknown, at: string) => repository.updateRow(row.id, { storeId: store.id, patch: { [payload.id]: value }, actor: human, at });
      const changesInHistory = () => repository.rowHistory(row.id, owningProject).map((entry) => entry.change);

      patchPayloadWith({ b: 2, a: 1 }, 't2');
      expect(changesInHistory()).toHaveLength(1);

      patchPayloadWith({ a: 2, b: 2 }, 't3');
      expect(changesInHistory()[0]).toEqual({ [payload.id]: { from: { a: 1, b: 2 }, to: { a: 2, b: 2 } } });

      patchPayloadWith(1, 't4');
      patchPayloadWith('1', 't5');
      expect(changesInHistory()[0]).toEqual({ [payload.id]: { from: 1, to: '1' } });
      expect(changesInHistory()).toHaveLength(4);
    });

    it.each(['__proto__', 'constructor'])('records a change on a column whose id is %s like on any other column', (columnId) => {
      const repository = openRepository();
      const { store } = createBacklogWithStatusColumn(repository);
      repository.addColumn(store.id, { id: columnId, displayName: 'odd', columnType: 'text', at: 't0' });
      const row = repository.insertRow(store.id, { id: 'r1', data: {}, actor: human, at: 't1' });

      const updated = repository.updateRow(row.id, { storeId: store.id, patch: Object.fromEntries([[columnId, 'x']]), actor: human, at: 't2' });

      const [latest] = repository.rowHistory(row.id, owningProject);
      expect(Object.entries(latest!.change)).toEqual([[columnId, { from: null, to: 'x' }]]);
      expect(Object.entries(updated.data)).toEqual([[columnId, 'x']]);
      expect(repository.listRows(store.id)).toEqual([updated]);
    });
  });

  describe('deleteRow', () => {
    it('records a delete entry with its actor, and rowHistory still returns the full trail', () => {
      const repository = openRepository();
      const { store, status } = createBacklogWithStatusColumn(repository);
      const row = repository.insertRow(store.id, { id: 'r1', data: { [status.id]: 'todo' }, actor: human, at: 't1' });
      repository.updateRow(row.id, { storeId: store.id, patch: { [status.id]: 'done' }, actor: agent, at: 't2' });

      repository.deleteRow(row.id, { storeId: store.id, actor: agent, at: 't3' });

      expect(repository.listRows(store.id)).toEqual([]);
      expect(repository.rowHistory(row.id, owningProject).map((entry) => [entry.actorKind, entry.change])).toEqual([
        ['agent', { kind: 'delete' }],
        ['agent', { [status.id]: { from: 'todo', to: 'done' } }],
        ['human', { kind: 'create' }],
      ]);
    });

    it('throws a typed not-found for a row that does not exist and writes no history', () => {
      const repository = openRepository();

      const deletion = () => repository.deleteRow('ghost', { storeId: 's1', actor: human, at: 't1' });

      expect(deletion).toThrow(RowNotFoundError);
      expect(repository.rowHistory('ghost', owningProject)).toEqual([]);
    });

    it('throws a typed not-found for a row that is already deleted, without a second delete entry', () => {
      const repository = openRepository();
      const { store } = createBacklogWithStatusColumn(repository);
      const row = repository.insertRow(store.id, { id: 'r1', data: {}, actor: human, at: 't1' });
      repository.deleteRow(row.id, { storeId: store.id, actor: human, at: 't2' });

      const secondDeletion = () => repository.deleteRow(row.id, { storeId: store.id, actor: human, at: 't3' });

      expect(secondDeletion).toThrow(RowNotFoundError);
      expect(repository.rowHistory(row.id, owningProject)).toHaveLength(2);
    });

    it('refuses a row that belongs to another store, and writes no history', () => {
      const repository = openRepository();
      const { store } = createBacklogWithStatusColumn(repository);
      const otherStore = repository.createStore({ id: 's2', projectId: 'p2', displayName: 'other', at: 't0' });
      const row = repository.insertRow(store.id, { id: 'r1', data: {}, actor: human, at: 't1' });

      const deletion = () => repository.deleteRow(row.id, { storeId: otherStore.id, actor: agent, at: 't2' });

      expect(deletion).toThrow(RowNotFoundError);
      expect(repository.listRows(store.id)).toEqual([row]);
      expect(repository.rowHistory(row.id, owningProject)).toHaveLength(1);
    });
  });

  describe('rowHistory limit', () => {
    it('returns only the newest entries when a limit is given', () => {
      const repository = openRepository();
      const { store, status } = createBacklogWithStatusColumn(repository);
      const row = repository.insertRow(store.id, { id: 'r1', data: {}, actor: human, at: 't1' });
      repository.updateRow(row.id, { storeId: store.id, patch: { [status.id]: 'todo' }, actor: human, at: 't2' });
      repository.updateRow(row.id, { storeId: store.id, patch: { [status.id]: 'done' }, actor: human, at: 't3' });

      const newestTwo = repository.rowHistory(row.id, { ...owningProject, limit: 2 });

      expect(newestTwo.map((entry) => entry.createdAt)).toEqual(['t3', 't2']);
      expect(repository.rowHistory(row.id, owningProject)).toHaveLength(3);
    });
  });

  describe('atomicity: a row change and its history entry are written together or not at all', () => {
    const invalidActor = { kind: 'robot' as RowActorKind, label: 'R2' };

    it('insertRow leaves neither a row nor a history entry when the history entry is refused', () => {
      const repository = openRepository();
      const { store } = createBacklogWithStatusColumn(repository);

      const insertion = () => repository.insertRow(store.id, { id: 'r1', data: {}, actor: invalidActor, at: 't1' });

      expect(insertion).toThrow();
      expect(repository.listRows(store.id)).toEqual([]);
      expect(repository.rowHistory('r1', owningProject)).toEqual([]);
    });

    it('updateRow leaves the row and its history exactly as they were when the history entry is refused', () => {
      const repository = openRepository();
      const { store, status } = createBacklogWithStatusColumn(repository);
      const row = repository.insertRow(store.id, { id: 'r1', data: { [status.id]: 'todo' }, actor: human, at: 't1' });

      const update = () => repository.updateRow(row.id, { storeId: store.id, patch: { [status.id]: 'done' }, actor: invalidActor, at: 't2' });

      expect(update).toThrow();
      expect(repository.listRows(store.id)).toEqual([row]);
      expect(repository.rowHistory(row.id, owningProject)).toHaveLength(1);
    });

    it('deleteRow deletes nothing when the history entry is refused', () => {
      const repository = openRepository();
      const { store } = createBacklogWithStatusColumn(repository);
      const row = repository.insertRow(store.id, { id: 'r1', data: {}, actor: human, at: 't1' });

      const deletion = () => repository.deleteRow(row.id, { storeId: store.id, actor: invalidActor, at: 't2' });

      expect(deletion).toThrow();
      expect(repository.listRows(store.id)).toEqual([row]);
      expect(repository.rowHistory(row.id, owningProject)).toHaveLength(1);
    });

    it('deleteRow leaves no delete entry behind when the row deletion itself is refused', () => {
      const { db, repository } = openRepositoryWithDatabase();
      const { store } = createBacklogWithStatusColumn(repository);
      const row = repository.insertRow(store.id, { id: 'r1', data: {}, actor: human, at: 't1' });
      db.exec("CREATE TRIGGER refuse_row_deletion BEFORE DELETE ON ds_rows BEGIN SELECT RAISE(ABORT, 'row deletion refused'); END");

      const deletion = () => repository.deleteRow(row.id, { storeId: store.id, actor: human, at: 't2' });

      expect(deletion).toThrow('row deletion refused');
      expect(repository.listRows(store.id)).toEqual([row]);
      expect(repository.rowHistory(row.id, owningProject)).toHaveLength(1);
    });

    it('rethrows the original error when the database has already rolled the transaction back', () => {
      const { db, repository } = openRepositoryWithDatabase();
      const { store } = createBacklogWithStatusColumn(repository);
      db.exec("CREATE TRIGGER abandon_on_history BEFORE INSERT ON ds_row_history BEGIN SELECT RAISE(ROLLBACK, 'history abandoned'); END");

      const insertion = () => repository.insertRow(store.id, { id: 'r1', data: {}, actor: human, at: 't1' });

      expect(insertion).toThrow('history abandoned');
      expect(repository.listRows(store.id)).toEqual([]);
    });

    it('stays usable after a refused write', () => {
      const repository = openRepository();
      const { store } = createBacklogWithStatusColumn(repository);
      expect(() => repository.insertRow(store.id, { id: 'r1', data: {}, actor: invalidActor, at: 't1' })).toThrow();

      const row = repository.insertRow(store.id, { id: 'r2', data: {}, actor: human, at: 't2' });

      expect(repository.listRows(store.id)).toEqual([row]);
    });
  });

  describe('inside a caller’s transaction', () => {
    function openBacklogWithOneRow() {
      const { db, repository } = openRepositoryWithDatabase();
      const { store, status } = createBacklogWithStatusColumn(repository);
      const row = repository.insertRow(store.id, { id: 'r1', data: { [status.id]: 'todo' }, actor: human, at: 't1' });
      const patchStatus = (value: string, at: string) => repository.updateRow(row.id, { storeId: store.id, patch: { [status.id]: value }, actor: human, at });
      const patchUnknownColumn = () => repository.updateRow(row.id, { storeId: store.id, patch: { 'c-ghost': 1 }, actor: human, at: 't9' });
      return { db, repository, store, row, patchStatus, patchUnknownColumn };
    }

    it('leaves nothing behind when the caller rolls back after a failed second write', () => {
      const { db, repository, store, row, patchStatus, patchUnknownColumn } = openBacklogWithOneRow();
      db.exec('BEGIN');

      patchStatus('doing', 't2');
      expect(patchUnknownColumn).toThrow(UnknownColumnError);
      db.exec('ROLLBACK');

      expect(repository.listRows(store.id)).toEqual([row]);
      expect(repository.rowHistory(row.id, owningProject)).toHaveLength(1);
    });

    it('keeps the earlier write, and only that one, when the caller commits after a failed second write', () => {
      const { db, repository, store, patchStatus, patchUnknownColumn } = openBacklogWithOneRow();
      db.exec('BEGIN');

      const doing = patchStatus('doing', 't2');
      expect(patchUnknownColumn).toThrow(UnknownColumnError);
      db.exec('COMMIT');

      expect(repository.listRows(store.id)).toEqual([doing]);
      expect(repository.rowHistory(doing.id, owningProject)).toHaveLength(2);
    });

    it('keeps both writes when the caller commits', () => {
      const { db, repository, store, patchStatus } = openBacklogWithOneRow();
      db.exec('BEGIN');

      patchStatus('doing', 't2');
      const done = patchStatus('done', 't3');
      db.exec('COMMIT');

      expect(repository.listRows(store.id)).toEqual([done]);
      expect(repository.rowHistory(done.id, owningProject)).toHaveLength(3);
    });

    it('leaves the caller’s transaction open after its own write succeeds', () => {
      const { db, patchStatus } = openBacklogWithOneRow();
      db.exec('BEGIN');

      patchStatus('doing', 't2');

      expect(db.isTransaction).toBe(true);
      db.exec('ROLLBACK');
    });
  });

  describe('ordering', () => {
    it('returns the history newest first, even when every entry shares one timestamp', () => {
      const repository = openRepository();
      const { store, status } = createBacklogWithStatusColumn(repository);
      const row = repository.insertRow(store.id, { id: 'r1', data: {}, actor: human, at: 'same-ms' });
      const statusesInWriteOrder = ['s1', 's2', 's3', 's4', 's5', 's6', 's7', 's8'];
      for (const value of statusesInWriteOrder) {
        repository.updateRow(row.id, { storeId: store.id, patch: { [status.id]: value }, actor: human, at: 'same-ms' });
      }

      const newestValueFirst = repository.rowHistory(row.id, owningProject).map((entry) => (entry.change as Record<string, { to: unknown }>)[status.id]?.to);

      expect(newestValueFirst).toEqual(['s8', 's7', 's6', 's5', 's4', 's3', 's2', 's1', undefined]);
    });

    it('lists rows created at the same timestamp in insertion order', () => {
      const repository = openRepository();
      const { store } = createBacklogWithStatusColumn(repository);
      repository.insertRow(store.id, { id: 'r-b', data: {}, actor: human, at: 't1' });
      repository.insertRow(store.id, { id: 'r-a', data: {}, actor: human, at: 't1' });

      expect(repository.listRows(store.id).map((row) => row.id)).toEqual(['r-b', 'r-a']);
    });
  });

  describe('project scope', () => {
    it('reads a deleted row’s history only through the project that owns its store', () => {
      const repository = openRepository();
      const { store } = createBacklogWithStatusColumn(repository);
      const row = repository.insertRow(store.id, { id: 'r1', data: {}, actor: human, at: 't1' });
      repository.deleteRow(row.id, { storeId: store.id, actor: human, at: 't2' });

      const historyInOwningProject = repository.rowHistory(row.id, owningProject);
      const historyInOtherProject = repository.rowHistory(row.id, { projectId: 'p2' });

      expect(historyInOwningProject.map((entry) => entry.change)).toEqual([{ kind: 'delete' }, { kind: 'create' }]);
      expect(historyInOtherProject).toEqual([]);
    });

    it('keeps a row’s history inside its own store’s project when another project reuses the row id', () => {
      const repository = openRepository();
      const { store } = createBacklogWithStatusColumn(repository);
      const otherStore = repository.createStore({ id: 's2', projectId: 'p2', displayName: 'backlog', at: 't0' });
      repository.insertRow(store.id, { id: 'r1', data: {}, actor: human, at: 't1' });
      repository.deleteRow('r1', { storeId: store.id, actor: human, at: 't2' });
      repository.insertRow(otherStore.id, { id: 'r1', data: {}, actor: agent, at: 't3' });

      const historyInSecondProject = repository.rowHistory('r1', { projectId: 'p2' });

      expect(historyInSecondProject.map((entry) => entry.actorKind)).toEqual(['agent']);
    });
  });

  describe('lookups by name', () => {
    it('finds a store by name regardless of case, inside its project only', () => {
      const repository = openRepository();
      const { store } = createBacklogWithStatusColumn(repository);

      expect(repository.findStoreByName('p1', 'BACKLOG')).toEqual(store);
      expect(repository.findStoreByName('p2', 'backlog')).toBeUndefined();
    });

    it('finds a column by name regardless of case, inside its store only', () => {
      const repository = openRepository();
      const { store, status } = createBacklogWithStatusColumn(repository);
      const otherStore = repository.createStore({ id: 's2', projectId: 'p1', displayName: 'other', at: 't0' });

      expect(repository.findColumnByName(store.id, 'STATUS')).toEqual(status);
      expect(repository.findColumnByName(otherStore.id, 'status')).toBeUndefined();
    });
  });
});
