import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { applyMigrations } from './migrate.js';

const migrationsDirectory = new URL('./migrations/', import.meta.url);
const migrationsDownDirectory = new URL('./migrations-down/', import.meta.url);
const VIEW_CONFIGS_VERSION = '072_integration_view_configs';

const sourceOf = (fileName: string) => ({ version: fileName.replace(/\.sql$/, ''), sql: readFileSync(new URL(fileName, migrationsDirectory), 'utf8') });
const migrationFileNames = readdirSync(migrationsDirectory).filter((fileName) => fileName.endsWith('.sql')).sort();
const migrationsBeforeViewConfigs = migrationFileNames.filter((fileName) => fileName < `${VIEW_CONFIGS_VERSION}.sql`).map(sourceOf);

const openDatabase = () => {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  return db;
};

const insertOwners = (db: DatabaseSync) => {
  db.prepare("INSERT INTO projects (id, name, created_at) VALUES ('p1', 'One', 't0')").run();
  db.prepare("INSERT INTO integration_connections (id, name, provider, credential_kind, allowed_hosts_json, created_at) VALUES ('c1', 'Jira', 'jira_cloud', 'token', '[\"acme.atlassian.net\"]', 'n')").run();
  db.prepare("INSERT INTO integration_profiles (id, project_id, connection_id, name, resource, created_at) VALUES ('i1', 'p1', 'c1', 'Backlog', 'CCM', 'n')").run();
};

const openMigratedDatabase = () => {
  const db = openDatabase();
  applyMigrations(db);
  insertOwners(db);
  return db;
};

const insertConfig = (db: DatabaseSync, approval: { rev: number | null; digest: string | null; at: string | null } = { rev: null, digest: null, at: null }) =>
  db.prepare("INSERT INTO integration_view_configs (profile_id, jql, fields_json, content_rev, approved_rev, approved_digest, approved_at, updated_at) VALUES ('i1', 'project = \"CCM\"', '[\"summary\"]', 1, ?, ?, ?, 'n')")
    .run(approval.rev, approval.digest, approval.at);

describe('the integration view configuration migration', () => {
  it('is the 072 file and replays on an empty database, once', () => {
    const db = openDatabase();

    applyMigrations(db);
    applyMigrations(db);

    expect(db.prepare('SELECT version FROM schema_migrations WHERE version = ?').all(VIEW_CONFIGS_VERSION)).toEqual([{ version: VIEW_CONFIGS_VERSION }]);
  });

  it('keeps one configuration per integration and refuses one of an unknown integration', () => {
    const db = openMigratedDatabase();
    insertConfig(db);

    expect(() => insertConfig(db)).toThrow(/UNIQUE|PRIMARY KEY/);
    expect(() => db.prepare("INSERT INTO integration_view_configs (profile_id, jql, fields_json, content_rev, updated_at) VALUES ('ghost', 'x', '[]', 1, 'n')").run()).toThrow(/FOREIGN KEY/);
  });

  it('refuses an approval that holds a revision without a digest, or a digest without a revision', () => {
    const db = openMigratedDatabase();

    expect(() => insertConfig(db, { rev: 1, digest: null, at: null })).toThrow(/CHECK constraint/);
    expect(() => insertConfig(db, { rev: null, digest: 'd', at: 'n' })).toThrow(/CHECK constraint/);
    expect(() => insertConfig(db, { rev: 1, digest: 'd', at: 'n' })).not.toThrow();
  });

  it('removes the configuration of a deleted integration', () => {
    const db = openMigratedDatabase();
    insertConfig(db);

    db.prepare("DELETE FROM integration_profiles WHERE id = 'i1'").run();

    expect(db.prepare('SELECT COUNT(*) AS n FROM integration_view_configs').get()).toEqual({ n: 0 });
  });

  it('ships a down migration outside the migrations folder that removes the table and keeps the integrations', () => {
    const db = openMigratedDatabase();
    insertConfig(db);

    db.exec(readFileSync(new URL(`${VIEW_CONFIGS_VERSION}.down.sql`, migrationsDownDirectory), 'utf8'));

    expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'integration_view_configs'").all()).toEqual([]);
    expect(db.prepare('SELECT COUNT(*) AS n FROM integration_profiles').get()).toEqual({ n: 1 });
  });

  it('applies only 072 on top of a database that already holds integrations', () => {
    const db = openDatabase();
    applyMigrations(db, migrationsBeforeViewConfigs);
    insertOwners(db);

    applyMigrations(db);

    expect(db.prepare('SELECT version FROM schema_migrations WHERE version >= ? ORDER BY version').all(VIEW_CONFIGS_VERSION)).toEqual([{ version: VIEW_CONFIGS_VERSION }]);
    expect(db.prepare('SELECT id FROM integration_profiles').all()).toEqual([{ id: 'i1' }]);
  });
});
