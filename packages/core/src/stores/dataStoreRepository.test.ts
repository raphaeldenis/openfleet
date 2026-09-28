import { describe, expect, it } from 'vitest';
import type { RowActorKind } from '@openfleet/shared';
import { openDatabase } from '../db/database.js';
import { ProjectRepository } from '../projects/projectRepository.js';
import { DataStoreRepository, RowNotFoundError, UnknownColumnError } from './dataStoreRepository.js';

const human = { kind: 'human', label: 'You' } as const;
const agent = { kind: 'agent', label: '⛏️ Gimli · T6' } as const;

function openRepository() {
  const db = openDatabase(':memory:');
  const projects = new ProjectRepository(db);
  projects.insert({ id: 'p1', name: 'One', docsFolderPath: null, createdAt: 't0' });
  projects.insert({ id: 'p2', name: 'Two', docsFolderPath: null, createdAt: 't0' });
  return new DataStoreRepository(db);
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
  });

  describe('insertRow', () => {
    it('stores the row and writes one history entry of kind create with its actor', () => {
      const repository = openRepository();
      const { store, status } = createBacklogWithStatusColumn(repository);

      const row = repository.insertRow(store.id, { id: 'r1', data: { [status.id]: 'todo' }, actor: human, at: 't1' });

      expect(row).toEqual({ id: 'r1', storeId: 's1', data: { [status.id]: 'todo' }, createdAt: 't1', updatedAt: 't1' });
      expect(repository.listRows(store.id)).toEqual([row]);
      expect(repository.rowHistory(row.id)).toEqual([
        expect.objectContaining({ rowId: 'r1', actorKind: 'human', actorLabel: 'You', change: { kind: 'create' }, createdAt: 't1' }),
      ]);
    });

    it('refuses data keyed by a column the store does not have, and stores nothing', () => {
      const repository = openRepository();
      const { store } = createBacklogWithStatusColumn(repository);

      const insertion = () => repository.insertRow(store.id, { id: 'r1', data: { 'c-ghost': 'x' }, actor: human, at: 't1' });

      expect(insertion).toThrow(UnknownColumnError);
      expect(repository.listRows(store.id)).toEqual([]);
    });
  });

  describe('updateRow', () => {
    it('records the actor alongside a from/to diff and merges the patch into the row', () => {
      const repository = openRepository();
      const { store, status } = createBacklogWithStatusColumn(repository);
      const row = repository.insertRow(store.id, { id: 'r1', data: { [status.id]: 'todo' }, actor: human, at: 't1' });

      const updated = repository.updateRow(row.id, { patch: { [status.id]: 'done' }, actor: agent, at: 't2' });

      const [latest] = repository.rowHistory(row.id);
      expect(latest).toMatchObject({ actorKind: 'agent', actorLabel: '⛏️ Gimli · T6', change: { [status.id]: { from: 'todo', to: 'done' } }, createdAt: 't2' });
      expect(updated).toEqual({ id: 'r1', storeId: 's1', data: { [status.id]: 'done' }, createdAt: 't1', updatedAt: 't2' });
      expect(repository.listRows(store.id)).toEqual([updated]);
    });

    it('omits the keys whose value does not change from the diff', () => {
      const repository = openRepository();
      const { store, status } = createBacklogWithStatusColumn(repository);
      const title = repository.addColumn(store.id, { id: 'c-title', displayName: 'title', columnType: 'text', at: 't0' });
      const row = repository.insertRow(store.id, { id: 'r1', data: { [status.id]: 'todo', [title.id]: 'ship it' }, actor: human, at: 't1' });

      repository.updateRow(row.id, { patch: { [status.id]: 'done', [title.id]: 'ship it' }, actor: human, at: 't2' });

      const [latest] = repository.rowHistory(row.id);
      expect(latest!.change).toEqual({ [status.id]: { from: 'todo', to: 'done' } });
    });

    it('records a previously empty cell as changing from null', () => {
      const repository = openRepository();
      const { store, status } = createBacklogWithStatusColumn(repository);
      const row = repository.insertRow(store.id, { id: 'r1', data: {}, actor: human, at: 't1' });

      repository.updateRow(row.id, { patch: { [status.id]: 'todo' }, actor: human, at: 't2' });

      const [latest] = repository.rowHistory(row.id);
      expect(latest!.change).toEqual({ [status.id]: { from: null, to: 'todo' } });
    });

    it('treats a structurally equal json value as unchanged', () => {
      const repository = openRepository();
      const { store } = createBacklogWithStatusColumn(repository);
      const payload = repository.addColumn(store.id, { id: 'c-payload', displayName: 'payload', columnType: 'json', at: 't0' });
      const row = repository.insertRow(store.id, { id: 'r1', data: { [payload.id]: { a: 1, b: [2] } }, actor: human, at: 't1' });

      repository.updateRow(row.id, { patch: { [payload.id]: { a: 1, b: [2] } }, actor: human, at: 't2' });

      expect(repository.rowHistory(row.id)).toHaveLength(1);
    });

    it('writes no history entry and leaves updated_at alone when the patch changes nothing', () => {
      const repository = openRepository();
      const { store, status } = createBacklogWithStatusColumn(repository);
      const row = repository.insertRow(store.id, { id: 'r1', data: { [status.id]: 'todo' }, actor: human, at: 't1' });

      const unchanged = repository.updateRow(row.id, { patch: { [status.id]: 'todo' }, actor: agent, at: 't2' });

      expect(unchanged).toEqual(row);
      expect(repository.rowHistory(row.id)).toHaveLength(1);
      expect(repository.listRows(store.id)[0]!.updatedAt).toBe('t1');
    });

    it('throws a typed not-found for a row that does not exist and writes no history', () => {
      const repository = openRepository();

      const update = () => repository.updateRow('ghost', { patch: {}, actor: human, at: 't1' });

      expect(update).toThrow(RowNotFoundError);
      expect(repository.rowHistory('ghost')).toEqual([]);
    });

    it('refuses a patch keyed by a column the store does not have, and changes nothing', () => {
      const repository = openRepository();
      const { store, status } = createBacklogWithStatusColumn(repository);
      const row = repository.insertRow(store.id, { id: 'r1', data: { [status.id]: 'todo' }, actor: human, at: 't1' });

      const update = () => repository.updateRow(row.id, { patch: { [status.id]: 'done', 'c-ghost': 1 }, actor: human, at: 't2' });

      expect(update).toThrow(UnknownColumnError);
      expect(repository.listRows(store.id)).toEqual([row]);
      expect(repository.rowHistory(row.id)).toHaveLength(1);
    });
  });

  describe('deleteRow', () => {
    it('records a delete entry with its actor, and rowHistory still returns the full trail', () => {
      const repository = openRepository();
      const { store, status } = createBacklogWithStatusColumn(repository);
      const row = repository.insertRow(store.id, { id: 'r1', data: { [status.id]: 'todo' }, actor: human, at: 't1' });
      repository.updateRow(row.id, { patch: { [status.id]: 'done' }, actor: agent, at: 't2' });

      repository.deleteRow(row.id, { actor: agent, at: 't3' });

      expect(repository.listRows(store.id)).toEqual([]);
      expect(repository.rowHistory(row.id).map((entry) => [entry.actorKind, entry.change])).toEqual([
        ['agent', { kind: 'delete' }],
        ['agent', { [status.id]: { from: 'todo', to: 'done' } }],
        ['human', { kind: 'create' }],
      ]);
    });

    it('throws a typed not-found for a row that does not exist and writes no history', () => {
      const repository = openRepository();

      const deletion = () => repository.deleteRow('ghost', { actor: human, at: 't1' });

      expect(deletion).toThrow(RowNotFoundError);
      expect(repository.rowHistory('ghost')).toEqual([]);
    });

    it('throws a typed not-found for a row that is already deleted, without a second delete entry', () => {
      const repository = openRepository();
      const { store } = createBacklogWithStatusColumn(repository);
      const row = repository.insertRow(store.id, { id: 'r1', data: {}, actor: human, at: 't1' });
      repository.deleteRow(row.id, { actor: human, at: 't2' });

      const secondDeletion = () => repository.deleteRow(row.id, { actor: human, at: 't3' });

      expect(secondDeletion).toThrow(RowNotFoundError);
      expect(repository.rowHistory(row.id)).toHaveLength(2);
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
      expect(repository.rowHistory('r1')).toEqual([]);
    });

    it('updateRow leaves the row and its history exactly as they were when the history entry is refused', () => {
      const repository = openRepository();
      const { store, status } = createBacklogWithStatusColumn(repository);
      const row = repository.insertRow(store.id, { id: 'r1', data: { [status.id]: 'todo' }, actor: human, at: 't1' });

      const update = () => repository.updateRow(row.id, { patch: { [status.id]: 'done' }, actor: invalidActor, at: 't2' });

      expect(update).toThrow();
      expect(repository.listRows(store.id)).toEqual([row]);
      expect(repository.rowHistory(row.id)).toHaveLength(1);
    });

    it('deleteRow keeps the row and its history exactly as they were when the history entry is refused', () => {
      const repository = openRepository();
      const { store } = createBacklogWithStatusColumn(repository);
      const row = repository.insertRow(store.id, { id: 'r1', data: {}, actor: human, at: 't1' });

      const deletion = () => repository.deleteRow(row.id, { actor: invalidActor, at: 't2' });

      expect(deletion).toThrow();
      expect(repository.listRows(store.id)).toEqual([row]);
      expect(repository.rowHistory(row.id)).toHaveLength(1);
    });

    it('stays usable after a refused write', () => {
      const repository = openRepository();
      const { store } = createBacklogWithStatusColumn(repository);
      expect(() => repository.insertRow(store.id, { id: 'r1', data: {}, actor: invalidActor, at: 't1' })).toThrow();

      const row = repository.insertRow(store.id, { id: 'r2', data: {}, actor: human, at: 't2' });

      expect(repository.listRows(store.id)).toEqual([row]);
    });
  });

  describe('ordering', () => {
    it('returns the history newest first, even when every entry shares one timestamp', () => {
      const repository = openRepository();
      const { store, status } = createBacklogWithStatusColumn(repository);
      const row = repository.insertRow(store.id, { id: 'r1', data: {}, actor: human, at: 'same-ms' });
      const statusesInWriteOrder = ['s1', 's2', 's3', 's4', 's5', 's6', 's7', 's8'];
      for (const value of statusesInWriteOrder) {
        repository.updateRow(row.id, { patch: { [status.id]: value }, actor: human, at: 'same-ms' });
      }

      const newestValueFirst = repository.rowHistory(row.id).map((entry) => (entry.change as Record<string, { to: unknown }>)[status.id]?.to);

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
      repository.deleteRow(row.id, { actor: human, at: 't2' });

      const historyInOwningProject = repository.rowHistory(row.id, { projectId: 'p1' });
      const historyInOtherProject = repository.rowHistory(row.id, { projectId: 'p2' });

      expect(historyInOwningProject.map((entry) => entry.change)).toEqual([{ kind: 'delete' }, { kind: 'create' }]);
      expect(historyInOtherProject).toEqual([]);
    });

    it('keeps a row’s history inside its own store’s project when another project reuses the row id', () => {
      const repository = openRepository();
      const { store } = createBacklogWithStatusColumn(repository);
      const otherStore = repository.createStore({ id: 's2', projectId: 'p2', displayName: 'backlog', at: 't0' });
      repository.insertRow(store.id, { id: 'r1', data: {}, actor: human, at: 't1' });
      repository.deleteRow('r1', { actor: human, at: 't2' });
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
