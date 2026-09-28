import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { applyMigrations } from './migrate.js';

const migrationsDirectory = new URL('./migrations/', import.meta.url);

const migrationFileNames = readdirSync(migrationsDirectory).filter((fileName) => fileName.endsWith('.sql')).sort();
const projectsMigrationFileName = migrationFileNames.find((fileName) => fileName.endsWith('_projects.sql'))!;
const migrationsBeforeProjects = migrationFileNames
  .filter((fileName) => fileName < projectsMigrationFileName)
  .map((fileName) => ({ version: fileName.replace(/\.sql$/, ''), sql: readFileSync(new URL(fileName, migrationsDirectory), 'utf8') }));

const insertLegacySession = (db: DatabaseSync, id: string, parentId: string | null) => {
  db.prepare(`INSERT INTO sessions (id, name, directory, parent_id, harness, state, state_since, hook_token, mcp_token, permission_mode, branch, created_at)
    VALUES (?, 'legacy', '/tmp', ?, 'fake', 'idle', 't0', ?, ?, 'plan', 'main', 't0')`).run(id, parentId, `h-${id}`, `m-${id}`);
};

const openDatabaseUpgradedFromBeforeProjects = () => {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  applyMigrations(db, migrationsBeforeProjects);
  insertLegacySession(db, 'parent', null);
  insertLegacySession(db, 'child', 'parent');
  applyMigrations(db);
  return db;
};

describe('the projects migration upgrading a database that already holds sessions', () => {
  it('keeps every existing session untouched, with project_id null', () => {
    const db = openDatabaseUpgradedFromBeforeProjects();

    const sessions = db.prepare('SELECT id, parent_id, project_id, permission_mode, branch FROM sessions ORDER BY id').all();

    expect(sessions).toEqual([
      { id: 'child', parent_id: 'parent', project_id: null, permission_mode: 'plan', branch: 'main' },
      { id: 'parent', parent_id: null, project_id: null, permission_mode: 'plan', branch: 'main' },
    ]);
  });

  it('enforces the project foreign key on a session updated after the upgrade', () => {
    const db = openDatabaseUpgradedFromBeforeProjects();

    expect(() => db.prepare(`UPDATE sessions SET project_id = 'no-such-project' WHERE id = 'parent'`).run()).toThrow(/FOREIGN KEY/);
  });
});
