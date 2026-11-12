import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { applyMigrations } from './migrate.js';

const migrationsDirectory = new URL('./migrations/', import.meta.url);
const migrationsDownDirectory = new URL('./migrations-down/', import.meta.url);
const POLLING_VERSION = '071_integration_polling';

const sourceOf = (fileName: string) => ({ version: fileName.replace(/\.sql$/, ''), sql: readFileSync(new URL(fileName, migrationsDirectory), 'utf8') });
const migrationFileNames = readdirSync(migrationsDirectory).filter((fileName) => fileName.endsWith('.sql')).sort();
const migrationsBeforePolling = migrationFileNames.filter((fileName) => fileName < `${POLLING_VERSION}.sql`).map(sourceOf);

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

const insertPollState = (db: DatabaseSync, consecutiveFailures = 0) =>
  db.prepare("INSERT INTO integration_poll_state (profile_id, etag, consecutive_failures, next_poll_at, last_polled_at) VALUES ('i1', NULL, ?, 'n', 'n')").run(consecutiveFailures);

const insertConnectionPolling = (db: DatabaseSync, overrides: { consecutiveAuthFailures?: number; isStopped?: number } = {}) =>
  db.prepare("INSERT INTO integration_connection_polling (connection_id, consecutive_auth_failures, is_stopped) VALUES ('c1', ?, ?)").run(overrides.consecutiveAuthFailures ?? 0, overrides.isStopped ?? 0);

const insertItem = (db: DatabaseSync, externalId = 'CCM-1') =>
  db.prepare("INSERT INTO integration_view_items (profile_id, external_id, fields_json, fetched_at) VALUES ('i1', ?, '{}', 'n')").run(externalId);

describe('the integration polling migration', () => {
  it('is the 071 file and replays on an empty database, once', () => {
    const db = openDatabase();

    applyMigrations(db);
    applyMigrations(db);

    expect(db.prepare('SELECT version FROM schema_migrations WHERE version = ?').all(POLLING_VERSION)).toEqual([{ version: POLLING_VERSION }]);
  });

  it('keeps one poll state per profile and refuses a negative failure count', () => {
    const db = openMigratedDatabase();
    insertPollState(db);

    expect(() => insertPollState(db)).toThrow(/UNIQUE|PRIMARY KEY/);
    db.prepare('DELETE FROM integration_poll_state').run();
    expect(() => insertPollState(db, -1)).toThrow(/CHECK constraint/);
  });

  it('keeps one polling state per connection and refuses a stopped flag other than 0 or 1', () => {
    const db = openMigratedDatabase();
    insertConnectionPolling(db);

    expect(() => insertConnectionPolling(db)).toThrow(/UNIQUE|PRIMARY KEY/);
    db.prepare('DELETE FROM integration_connection_polling').run();
    expect(() => insertConnectionPolling(db, { isStopped: 2 })).toThrow(/CHECK constraint/);
    expect(() => insertConnectionPolling(db, { consecutiveAuthFailures: -1 })).toThrow(/CHECK constraint/);
  });

  it('keeps one item per profile and external id, and refuses an item of an unknown profile', () => {
    const db = openMigratedDatabase();
    insertItem(db);

    expect(() => insertItem(db)).toThrow(/UNIQUE|PRIMARY KEY/);
    expect(() => db.prepare("INSERT INTO integration_view_items (profile_id, external_id, fields_json, fetched_at) VALUES ('ghost', 'CCM-2', '{}', 'n')").run()).toThrow(/FOREIGN KEY/);
  });

  it.each([
    ['project', "DELETE FROM projects WHERE id = 'p1'"],
    ['connection', "DELETE FROM integration_connections WHERE id = 'c1'"],
  ])('removes the poll state, the polling state and the items of a deleted %s', (_owner, deletion) => {
    const db = openMigratedDatabase();
    insertPollState(db);
    insertConnectionPolling(db);
    insertItem(db);

    db.prepare(deletion).run();

    expect(db.prepare('SELECT (SELECT COUNT(*) FROM integration_poll_state) AS state, (SELECT COUNT(*) FROM integration_view_items) AS items').get()).toEqual({ state: 0, items: 0 });
    if (_owner === 'connection') expect(db.prepare('SELECT COUNT(*) AS n FROM integration_connection_polling').get()).toEqual({ n: 0 });
  });

  it('holds no column that could carry a credential value', () => {
    const db = openMigratedDatabase();

    const columns = ['integration_poll_state', 'integration_connection_polling', 'integration_view_items']
      .flatMap((table) => (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((column) => column.name));

    expect(columns.filter((name) => /token|secret|credential|password|authorization/.test(name))).toEqual([]);
  });

  it('ships a down migration outside the migrations folder that removes the three tables and keeps the integrations of 070', () => {
    const db = openMigratedDatabase();
    insertItem(db);

    db.exec(readFileSync(new URL(`${POLLING_VERSION}.down.sql`, migrationsDownDirectory), 'utf8'));

    expect(db.prepare("SELECT name FROM sqlite_master WHERE name IN ('integration_poll_state', 'integration_connection_polling', 'integration_view_items')").all()).toEqual([]);
    expect(db.prepare('SELECT COUNT(*) AS n FROM integration_profiles').get()).toEqual({ n: 1 });
  });
});

describe('the integration polling migration upgrading a database that already holds integrations', () => {
  const openUpgradedDatabase = () => {
    const db = openDatabase();
    applyMigrations(db, migrationsBeforePolling);
    insertOwners(db);
    db.prepare("INSERT INTO integration_health (profile_id, status, checked_at) VALUES ('i1', 'ok', 'n')").run();
    applyMigrations(db);
    return db;
  };

  it('applies only 071 on top of what was there and keeps the connections, profiles and health untouched', () => {
    const db = openUpgradedDatabase();

    expect(db.prepare('SELECT version FROM schema_migrations WHERE version >= ? ORDER BY version').all(POLLING_VERSION)).toEqual([{ version: POLLING_VERSION }]);
    expect(db.prepare('SELECT id, provider FROM integration_connections').all()).toEqual([{ id: 'c1', provider: 'jira_cloud' }]);
    expect(db.prepare('SELECT id, resource FROM integration_profiles').all()).toEqual([{ id: 'i1', resource: 'CCM' }]);
    expect(db.prepare('SELECT status FROM integration_health').all()).toEqual([{ status: 'ok' }]);
  });

  it('starts the new tables empty and ready for a poll state, a polling state and an item', () => {
    const db = openUpgradedDatabase();

    insertPollState(db, 2);
    insertConnectionPolling(db, { consecutiveAuthFailures: 3, isStopped: 1 });
    insertItem(db);

    expect(db.prepare('SELECT consecutive_failures FROM integration_poll_state').all()).toEqual([{ consecutive_failures: 2 }]);
    expect(db.prepare('SELECT is_stopped FROM integration_connection_polling').all()).toEqual([{ is_stopped: 1 }]);
  });
});
