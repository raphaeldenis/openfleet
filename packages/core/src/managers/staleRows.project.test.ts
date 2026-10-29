import { describe, expect, it } from 'vitest';
import { openDatabase } from '../db/database.js';
import { ProjectRepository } from '../projects/projectRepository.js';
import { DataStoreRepository } from '../stores/dataStoreRepository.js';
import { staleInProgressRowLabelsOfProject } from './staleRows.js';

const NOW = new Date('2026-10-29T12:00:00.000Z').getTime();
const FIVE_HOURS_AGO = '2026-10-29T07:00:00.000Z';
const ONE_HOUR_AGO = '2026-10-29T11:00:00.000Z';
const actor = { kind: 'agent', label: 'synthetic' } as const;

const openRepository = () => {
  const db = openDatabase(':memory:');
  const projects = new ProjectRepository(db);
  projects.insert({ id: 'p1', name: 'One', docsFolderPath: null, createdAt: 't0' });
  projects.insert({ id: 'p2', name: 'Two', docsFolderPath: null, createdAt: 't0' });
  return new DataStoreRepository(db);
};

const createBoard = ({ repository, storeId, projectId, displayName }: { repository: DataStoreRepository; storeId: string; projectId: string; displayName: string }) => {
  repository.createStore({ id: storeId, projectId, displayName, at: 't0' });
  const columnIds = Object.fromEntries(['id', 'status', 'step', 'next_action'].map((name) => [name, `${storeId}-${name}`]));
  repository.addColumn(storeId, { id: columnIds['id']!, displayName: 'id', columnType: 'text', at: 't0' });
  repository.addColumn(storeId, { id: columnIds['status']!, displayName: 'status', columnType: 'text', at: 't0' });
  repository.addColumn(storeId, { id: columnIds['step']!, displayName: 'step', columnType: 'text', at: 't0' });
  return columnIds as Record<'id' | 'status' | 'step', string>;
};

const addRow = ({ repository, storeId, columnIds, ticket, status, at }: { repository: DataStoreRepository; storeId: string; columnIds: Record<'id' | 'status', string>; ticket: string; status: string; at: string }) =>
  repository.insertRow(storeId, { id: `${storeId}-${ticket}`, data: { [columnIds.id]: ticket, [columnIds.status]: status }, actor, at });

describe('staleInProgressRowLabelsOfProject', () => {
  it('names the stale in progress rows of the boards of the project', () => {
    const repository = openRepository();
    const columnIds = createBoard({ repository, storeId: 's1', projectId: 'p1', displayName: 'Board' });
    addRow({ repository, storeId: 's1', columnIds, ticket: 'FIX-OLD', status: 'in progress', at: FIVE_HOURS_AGO });
    addRow({ repository, storeId: 's1', columnIds, ticket: 'FIX-FRESH', status: 'in progress', at: ONE_HOUR_AGO });

    expect(staleInProgressRowLabelsOfProject({ stores: repository, projectId: 'p1', now: NOW })).toEqual(['FIX-OLD']);
  });

  it('lists the oldest rows first across the boards of the project', () => {
    const repository = openRepository();
    const firstIds = createBoard({ repository, storeId: 's1', projectId: 'p1', displayName: 'Board A' });
    const secondIds = createBoard({ repository, storeId: 's2', projectId: 'p1', displayName: 'Board B' });
    addRow({ repository, storeId: 's1', columnIds: firstIds, ticket: 'FIX-A-NEWER', status: 'in progress', at: '2026-10-29T07:00:00.000Z' });
    addRow({ repository, storeId: 's2', columnIds: secondIds, ticket: 'FIX-B-OLDEST', status: 'in progress', at: '2026-10-28T07:00:00.000Z' });
    addRow({ repository, storeId: 's1', columnIds: firstIds, ticket: 'FIX-A-OLDER', status: 'in progress', at: '2026-10-29T01:00:00.000Z' });

    expect(staleInProgressRowLabelsOfProject({ stores: repository, projectId: 'p1', now: NOW })).toEqual(['FIX-B-OLDEST', 'FIX-A-OLDER', 'FIX-A-NEWER']);
  });

  it('ignores the stores that are not boards and the boards of other projects', () => {
    const repository = openRepository();
    repository.createStore({ id: 'journal', projectId: 'p1', displayName: 'Journal', at: 't0' });
    const otherColumnIds = createBoard({ repository, storeId: 's2', projectId: 'p2', displayName: 'Board' });
    addRow({ repository, storeId: 's2', columnIds: otherColumnIds, ticket: 'FIX-OTHER', status: 'in progress', at: FIVE_HOURS_AGO });

    expect(staleInProgressRowLabelsOfProject({ stores: repository, projectId: 'p1', now: NOW })).toEqual([]);
  });
});
