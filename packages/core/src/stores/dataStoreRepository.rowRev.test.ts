import { describe, expect, it } from 'vitest';
import { OpenFleetError } from '@openfleet/shared';
import { openDatabase } from '../db/database.js';
import { ProjectRepository } from '../projects/projectRepository.js';
import { DataStoreRepository, RowNotFoundError } from './dataStoreRepository.js';

const human = { kind: 'human', label: 'You' } as const;

function openRepositoryWithTitleColumn() {
  const db = openDatabase(':memory:');
  new ProjectRepository(db).insert({ id: 'p1', name: 'One', docsFolderPath: null, createdAt: 't0' });
  const repository = new DataStoreRepository(db);
  const store = repository.createStore({ id: 's1', projectId: 'p1', displayName: 'backlog', at: 't0' });
  const title = repository.addColumn(store.id, { id: 'c-title', displayName: 'title', columnType: 'text', at: 't0' });
  const note = repository.addColumn(store.id, { id: 'c-note', displayName: 'note', columnType: 'text', at: 't0' });
  const row = repository.insertRow(store.id, { id: 'r1', data: { [title.id]: 'a', [note.id]: 'n' }, actor: human, at: 't1' });
  return { repository, store, title, note, row };
}

function thrownBy(work: () => unknown): unknown {
  try {
    work();
  } catch (error) {
    return error;
  }
  return undefined;
}

describe('DataStoreRepository row revision', () => {
  it('starts a new row at revision 1', () => {
    const { row, repository, store } = openRepositoryWithTitleColumn();

    expect(row.rev).toBe(1);
    expect(repository.findRow(row.id, store.id)!.rev).toBe(1);
  });

  it('raises the revision by one for each write that changes a cell', () => {
    const { repository, store, title, row } = openRepositoryWithTitleColumn();

    const firstWrite = repository.updateRow(row.id, { storeId: store.id, patch: { [title.id]: 'b' }, actor: human, at: 't2' });
    const secondWrite = repository.updateRow(row.id, { storeId: store.id, patch: { [title.id]: 'c' }, actor: human, at: 't3' });

    expect(firstWrite.rev).toBe(2);
    expect(secondWrite.rev).toBe(3);
    expect(repository.findRow(row.id, store.id)!.rev).toBe(3);
  });

  it('keeps the revision when the patch changes nothing', () => {
    const { repository, store, title, row } = openRepositoryWithTitleColumn();

    const unchanged = repository.updateRow(row.id, { storeId: store.id, patch: { [title.id]: 'a' }, actor: human, at: 't2' });

    expect(unchanged.rev).toBe(1);
    expect(repository.findRow(row.id, store.id)!.rev).toBe(1);
  });

  it('raises the revision when deleting a column clears a cell of the row', () => {
    const { repository, store, title, row } = openRepositoryWithTitleColumn();

    repository.deleteColumn(store.id, { columnId: title.id, actor: human, at: 't2' });

    expect(repository.findRow(row.id, store.id)!.rev).toBe(2);
  });

  it('writes when the expected revision is the current one', () => {
    const { repository, store, title, row } = openRepositoryWithTitleColumn();

    const updated = repository.updateRow(row.id, { storeId: store.id, patch: { [title.id]: 'b' }, expectedRev: 1, actor: human, at: 't2' });

    expect(updated.rev).toBe(2);
    expect(updated.data[title.id]).toBe('b');
  });

  it('refuses a stale expected revision with stale_revision, naming the row and its current revision, and writes nothing', () => {
    const { repository, store, title, row } = openRepositoryWithTitleColumn();
    repository.updateRow(row.id, { storeId: store.id, patch: { [title.id]: 'b' }, actor: human, at: 't2' });

    const refusal = thrownBy(() => repository.updateRow(row.id, { storeId: store.id, patch: { [title.id]: 'mine' }, expectedRev: 1, actor: human, at: 't3' }));

    expect(refusal).toBeInstanceOf(OpenFleetError);
    expect(refusal).toMatchObject({ code: 'stale_revision', options: { detail: { resource: 'data_store_row', rowId: row.id, currentRev: 2 } } });
    expect(repository.findRow(row.id, store.id)).toMatchObject({ rev: 2, data: { [title.id]: 'b' } });
    expect(repository.rowHistory(row.id, { projectId: 'p1' })).toHaveLength(2);
  });

  it('refuses a stale expected revision even when the patch would change nothing', () => {
    const { repository, store, title, row } = openRepositoryWithTitleColumn();
    repository.updateRow(row.id, { storeId: store.id, patch: { [title.id]: 'b' }, actor: human, at: 't2' });

    const refusal = thrownBy(() => repository.updateRow(row.id, { storeId: store.id, patch: { [title.id]: 'b' }, expectedRev: 1, actor: human, at: 't3' }));

    expect(refusal).toMatchObject({ code: 'stale_revision' });
  });

  it('lets only one of two writers holding the same revision succeed', () => {
    const { repository, store, title, row } = openRepositoryWithTitleColumn();

    const firstWriter = repository.updateRow(row.id, { storeId: store.id, patch: { [title.id]: 'first' }, expectedRev: 1, actor: human, at: 't2' });
    const secondWriter = thrownBy(() => repository.updateRow(row.id, { storeId: store.id, patch: { [title.id]: 'second' }, expectedRev: 1, actor: human, at: 't3' }));

    expect(firstWriter.data[title.id]).toBe('first');
    expect(secondWriter).toMatchObject({ code: 'stale_revision' });
    expect(repository.findRow(row.id, store.id)!.data[title.id]).toBe('first');
  });

  it('keeps answering row not found for a missing row, whatever revision is expected', () => {
    const { repository, store } = openRepositoryWithTitleColumn();

    const refusal = thrownBy(() => repository.updateRow('ghost', { storeId: store.id, patch: {}, expectedRev: 1, actor: human, at: 't2' }));

    expect(refusal).toBeInstanceOf(RowNotFoundError);
  });
});
