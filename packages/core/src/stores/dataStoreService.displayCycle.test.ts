import { afterEach, describe, expect, it } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import { openDatabase } from '../db/database.js';
import { ProjectRepository } from '../projects/projectRepository.js';
import { DataStoreRepository } from './dataStoreRepository.js';
import { DataStoreService, InvalidColumnDefinitionError } from './dataStoreService.js';

const scope = { projectId: 'p1' } as const;

const openDatabases: DatabaseSync[] = [];
afterEach(() => openDatabases.splice(0).forEach((db) => db.close()));

function setupStoreWithAPreexistingDisplayCycle() {
  const db = openDatabase(':memory:');
  openDatabases.push(db);
  new ProjectRepository(db).insert({ id: 'p1', name: 'One', docsFolderPath: null, createdAt: 't0' });
  let counter = 0;
  const service = new DataStoreService({ repo: new DataStoreRepository(db), db, clock: () => '2026-01-01T00:00:00.000Z', newId: () => `id-${++counter}` });
  const store = service.createStore({ ...scope, displayName: 'backlog' });
  const title = service.addColumn(store.id, { ...scope, displayName: 'title', columnType: 'text' });
  const priority = service.addColumn(store.id, { ...scope, displayName: 'priority', columnType: 'number' });
  const due = service.addColumn(store.id, { ...scope, displayName: 'due', columnType: 'date' });
  db.prepare('UPDATE ds_columns SET display_column_id = ? WHERE id = ?').run(priority.id, title.id);
  db.prepare('UPDATE ds_columns SET display_column_id = ? WHERE id = ?').run(title.id, priority.id);
  return { service, store, title, due };
}

describe('pointing a column at a display column when the store already holds a display cycle', () => {
  it('refuses the change instead of looping, whichever column leads into the cycle', () => {
    const { service, store, title, due } = setupStoreWithAPreexistingDisplayCycle();

    const pointDueAtTitle = () => service.updateColumn(store.id, { ...scope, columnId: due.id, changes: { displayColumnId: title.id } });

    expect(pointDueAtTitle).toThrow(InvalidColumnDefinitionError);
  });
});
