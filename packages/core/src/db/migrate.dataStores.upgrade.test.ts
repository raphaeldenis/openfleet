import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { applyMigrations } from './migrate.js';

const migrationsDirectory = new URL('./migrations/', import.meta.url);

const migrationFileNames = readdirSync(migrationsDirectory).filter((fileName) => fileName.endsWith('.sql')).sort();
const projectsMigrationFileName = migrationFileNames.find((fileName) => fileName.endsWith('_projects.sql'))!;
const migrationsThroughProjects = migrationFileNames
  .filter((fileName) => fileName <= projectsMigrationFileName)
  .map((fileName) => ({ version: fileName.replace(/\.sql$/, ''), sql: readFileSync(new URL(fileName, migrationsDirectory), 'utf8') }));

const insertProject = (db: DatabaseSync, id: string) => {
  db.prepare(`INSERT INTO projects (id, name, docs_folder_path, created_at) VALUES (?, 'Existing project', '/docs', 't0')`).run(id);
};

const insertSessionInProject = (db: DatabaseSync, id: string, projectId: string) => {
  db.prepare(`INSERT INTO sessions (id, name, directory, harness, state, state_since, hook_token, mcp_token, permission_mode, branch, project_id, created_at)
    VALUES (?, 'existing', '/tmp', 'fake', 'idle', 't0', ?, ?, 'plan', 'main', ?, 't0')`).run(id, `h-${id}`, `m-${id}`, projectId);
};

const openDatabaseUpgradedFromProjects = () => {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  applyMigrations(db, migrationsThroughProjects);
  insertProject(db, 'p1');
  insertSessionInProject(db, 's1', 'p1');
  applyMigrations(db);
  return db;
};

describe('the data stores migration upgrading a database that already holds projects and sessions', () => {
  it('keeps every existing project and its sessions untouched, with no foreign key violation', () => {
    const db = openDatabaseUpgradedFromProjects();

    const projects = db.prepare('SELECT id, name, docs_folder_path FROM projects').all();
    const sessions = db.prepare('SELECT id, project_id FROM sessions').all();
    const foreignKeyViolations = db.prepare('PRAGMA foreign_key_check').all();

    expect(projects).toEqual([{ id: 'p1', name: 'Existing project', docs_folder_path: '/docs' }]);
    expect(sessions).toEqual([{ id: 's1', project_id: 'p1' }]);
    expect(foreignKeyViolations).toEqual([]);
  });

  it('lets the upgraded project own a data store', () => {
    const db = openDatabaseUpgradedFromProjects();

    const insertStore = () => db.prepare(`INSERT INTO data_stores (id, project_id, display_name, created_at, updated_at) VALUES ('ds1', 'p1', 'Bugs', 't0', 't0')`).run();

    expect(insertStore).not.toThrow();
  });
});
