import { describe, expect, it } from 'vitest';
import { openDatabase } from '../db/database.js';
import { ProjectRepository } from '../projects/projectRepository.js';
import { DataStoreRepository } from './dataStoreRepository.js';
import { BacklogWriteRefusedError, DataStoreService } from './dataStoreService.js';

const scope = { projectId: 'p1' } as const;
const human = { kind: 'human', label: 'You' } as const;
const agent = { kind: 'agent', label: 'Gimli' } as const;

function thrownBy(work: () => unknown): unknown {
  try {
    work();
  } catch (error) {
    return error;
  }
  return undefined;
}

function projectWithStore(options: { sharedRepo: boolean; storeName: string }) {
  const db = openDatabase(':memory:');
  const projects = new ProjectRepository(db);
  projects.insert({ id: 'p1', name: 'One', docsFolderPath: null, createdAt: 't0' });
  if (options.sharedRepo) projects.update('p1', { sharedRepo: true });
  let counter = 0;
  const service = new DataStoreService({ repo: new DataStoreRepository(db), db, clock: () => '2026-01-01T00:00:00.000Z', newId: () => `id-${++counter}` });
  const store = service.createStore({ ...scope, displayName: options.storeName });
  const ticket = service.addColumn(store.id, { ...scope, displayName: 'Ticket', columnType: 'text' }).id;
  const insertAs = (actor: typeof human | typeof agent, extra: { callerIsManager?: boolean } = {}) =>
    () => service.insertRow(store.id, { ...scope, data: { [ticket]: 'T-1' }, actor, ...extra });
  return { service, store, ticket, insertAs };
}

describe('the backlog of a project whose repository is shared', () => {
  it('refuses a row inserted by an agent that is not a manager', () => {
    const { insertAs } = projectWithStore({ sharedRepo: true, storeName: 'Manager backlog' });

    expect(thrownBy(insertAs(agent))).toBeInstanceOf(BacklogWriteRefusedError);
  });

  it('refuses it whatever the case and the spacing of the table name', () => {
    const { insertAs } = projectWithStore({ sharedRepo: true, storeName: '  manager   BACKLOG ' });

    expect(thrownBy(insertAs(agent))).toBeInstanceOf(BacklogWriteRefusedError);
  });

  it('refuses the rows of a batch inserted by an agent that is not a manager', () => {
    const { service, store, ticket } = projectWithStore({ sharedRepo: true, storeName: 'Manager backlog' });

    const error = thrownBy(() => service.insertRows(store.id, { ...scope, items: [{ [ticket]: 'T-1' }], actor: agent }));

    expect(error).toBeInstanceOf(BacklogWriteRefusedError);
  });

  it('refuses a row saved by an agent when the save inserts', () => {
    const { service, store, ticket } = projectWithStore({ sharedRepo: true, storeName: 'Manager backlog' });

    const error = thrownBy(() => service.saveRow(store.id, { ...scope, data: { [ticket]: 'T-1' }, actor: agent, mode: 'create' }));

    expect(error).toBeInstanceOf(BacklogWriteRefusedError);
  });

  it('tells the agent where the finding goes', () => {
    const { insertAs } = projectWithStore({ sharedRepo: true, storeName: 'Manager backlog' });

    expect((thrownBy(insertAs(agent)) as Error).message).toMatch(/manager/);
  });

  it('lets a manager insert a row', () => {
    const { insertAs } = projectWithStore({ sharedRepo: true, storeName: 'Manager backlog' });

    expect(insertAs(agent, { callerIsManager: true })).not.toThrow();
  });

  it('lets a human insert a row', () => {
    const { insertAs } = projectWithStore({ sharedRepo: true, storeName: 'Manager backlog' });

    expect(insertAs(human)).not.toThrow();
  });

  it('lets an agent change a row that exists', () => {
    const { service, store, ticket, insertAs } = projectWithStore({ sharedRepo: true, storeName: 'Manager backlog' });
    const row = insertAs(human)();

    const change = () => service.updateRow(store.id, row.id, { ...scope, patch: { [ticket]: 'T-2' }, actor: agent });

    expect(change).not.toThrow();
  });

  it('lets an agent insert into any other table', () => {
    const { insertAs } = projectWithStore({ sharedRepo: true, storeName: 'Findings' });

    expect(insertAs(agent)).not.toThrow();
  });

  it('lets an agent insert while the repository is not shared', () => {
    const { insertAs } = projectWithStore({ sharedRepo: false, storeName: 'Manager backlog' });

    expect(insertAs(agent)).not.toThrow();
  });
});
