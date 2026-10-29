import { join } from 'node:path';
import { openDatabase } from '../../packages/core/src/db/database.js';
import { ProjectRepository } from '../../packages/core/src/projects/projectRepository.js';
import { DataStoreRepository } from '../../packages/core/src/stores/dataStoreRepository.js';
import { SEEDED_COLUMN, SEEDED_PROJECT, SEEDED_ROW, SEEDED_STORE } from './e2eSeedFixture.js';

const SEED_ACTOR = { kind: 'human', label: 'Seed' } as const;

/** Writes the project, store, column and row the real-daemon specs edit; leaves a database that already holds the project untouched. */
function writeSeed(databasePath: string): void {
  const db = openDatabase(databasePath, { migrationLogging: 'silent' });
  try {
    const projects = new ProjectRepository(db);
    const isAlreadySeeded = projects.get(SEEDED_PROJECT.id) !== undefined;
    if (isAlreadySeeded) return;

    const at = new Date().toISOString();
    const stores = new DataStoreRepository(db);
    projects.insert({ id: SEEDED_PROJECT.id, name: SEEDED_PROJECT.name, docsFolderPath: null, createdAt: at });
    stores.createStore({ id: SEEDED_STORE.id, projectId: SEEDED_PROJECT.id, displayName: SEEDED_STORE.displayName, at });
    stores.addColumn(SEEDED_STORE.id, { id: SEEDED_COLUMN.id, displayName: SEEDED_COLUMN.displayName, columnType: 'text', format: 'longText', at });
    stores.insertRow(SEEDED_STORE.id, { id: SEEDED_ROW.id, data: { [SEEDED_COLUMN.id]: SEEDED_ROW.details }, actor: SEED_ACTOR, at });
  } finally {
    db.close();
  }
}

const [, , home] = process.argv;
if (!home) throw new Error('usage: writeE2eSeed.ts <e2e home>');
writeSeed(join(home, 'openfleet.db'));
