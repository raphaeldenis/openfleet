import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { applyMigrations } from './migrate.js';

const migrationsDirectory = new URL('./migrations/', import.meta.url);
const migrationsDownDirectory = new URL('./migrations-down/', import.meta.url);
const INTEGRATIONS_VERSION = '070_integrations';

const sourceOf = (fileName: string) => ({ version: fileName.replace(/\.sql$/, ''), sql: readFileSync(new URL(fileName, migrationsDirectory), 'utf8') });
const migrationFileNames = readdirSync(migrationsDirectory).filter((fileName) => fileName.endsWith('.sql')).sort();
const migrationsBeforeIntegrations = migrationFileNames.filter((fileName) => fileName < `${INTEGRATIONS_VERSION}.sql`).map(sourceOf);

const openDatabase = () => {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  return db;
};

const openMigratedDatabase = () => {
  const db = openDatabase();
  applyMigrations(db);
  db.prepare("INSERT INTO projects (id, name, created_at) VALUES ('p1', 'One', 't0')").run();
  return db;
};

const insertConnection = (db: DatabaseSync, overrides: { id?: string; name?: string; credentialKind?: string } = {}) =>
  db.prepare("INSERT INTO integration_connections (id, name, provider, credential_kind, allowed_hosts_json, created_at) VALUES (?, ?, 'jira_cloud', ?, '[\"acme.atlassian.net\"]', 'n')")
    .run(overrides.id ?? 'c1', overrides.name ?? 'Jira', overrides.credentialKind ?? 'token');

const insertProfile = (db: DatabaseSync, overrides: { id?: string; projectId?: string; connectionId?: string; name?: string } = {}) =>
  db.prepare("INSERT INTO integration_profiles (id, project_id, connection_id, name, resource, created_at) VALUES (?, ?, ?, ?, 'CCM', 'n')")
    .run(overrides.id ?? 'i1', overrides.projectId ?? 'p1', overrides.connectionId ?? 'c1', overrides.name ?? 'Backlog');

const insertHealth = (db: DatabaseSync, status: string) =>
  db.prepare("INSERT INTO integration_health (profile_id, status, checked_at) VALUES ('i1', ?, 'n')").run(status);

describe('the integrations migration', () => {
  it('is the 070 file and replays on an empty database, once', () => {
    const db = openDatabase();

    applyMigrations(db);
    applyMigrations(db);

    const applied = db.prepare('SELECT version FROM schema_migrations WHERE version = ?').all(INTEGRATIONS_VERSION);
    expect(applied).toEqual([{ version: INTEGRATIONS_VERSION }]);
  });

  it('refuses a credential kind other than token and two connections of the same name', () => {
    const db = openMigratedDatabase();
    insertConnection(db);

    expect(() => insertConnection(db, { id: 'c2', credentialKind: 'password' })).toThrow(/CHECK constraint/);
    expect(() => insertConnection(db, { id: 'c3' })).toThrow(/UNIQUE/);
  });

  it('refuses a profile of an unknown project or an unknown connection, and a second profile of the same name in a project', () => {
    const db = openMigratedDatabase();
    insertConnection(db);
    insertProfile(db);

    expect(() => insertProfile(db, { id: 'i2', projectId: 'ghost' })).toThrow(/FOREIGN KEY/);
    expect(() => insertProfile(db, { id: 'i3', connectionId: 'ghost', name: 'Other' })).toThrow(/FOREIGN KEY/);
    expect(() => insertProfile(db, { id: 'i4' })).toThrow(/UNIQUE/);
  });

  it('keeps one health row per profile and refuses a status outside the four typed ones', () => {
    const db = openMigratedDatabase();
    insertConnection(db);
    insertProfile(db);

    expect(() => insertHealth(db, 'credential_invalid')).toThrow(/CHECK constraint/);
    insertHealth(db, 'ok');
    expect(() => insertHealth(db, 'unreachable')).toThrow(/UNIQUE|PRIMARY KEY/);
  });

  it.each([
    ['project', "DELETE FROM projects WHERE id = 'p1'"],
    ['connection', "DELETE FROM integration_connections WHERE id = 'c1'"],
  ])('removes the profiles and health of a deleted %s', (_owner, deletion) => {
    const db = openMigratedDatabase();
    insertConnection(db);
    insertProfile(db);
    insertHealth(db, 'ok');

    db.prepare(deletion).run();

    expect(db.prepare('SELECT (SELECT COUNT(*) FROM integration_profiles) AS profiles, (SELECT COUNT(*) FROM integration_health) AS health').get()).toEqual({ profiles: 0, health: 0 });
  });

  it('holds no column that could carry a credential value', () => {
    const db = openMigratedDatabase();

    const columns = ['integration_connections', 'integration_profiles', 'integration_health']
      .flatMap((table) => (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((column) => column.name));

    expect(columns.filter((name) => /token|secret|credential_value|password|value/.test(name))).toEqual([]);
  });

  it('ships a down migration outside the migrations folder that removes the three tables and leaves the secret refs', () => {
    const db = openMigratedDatabase();
    db.prepare("INSERT INTO secret_refs (id, scope_kind, scope_id, name, status) VALUES ('r1', 'connection', 'c1', 'TOKEN', 'missing')").run();

    db.exec(readFileSync(new URL(`${INTEGRATIONS_VERSION}.down.sql`, migrationsDownDirectory), 'utf8'));

    expect(db.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'integration_%'").all()).toEqual([]);
    expect(db.prepare('SELECT COUNT(*) AS n FROM secret_refs').get()).toEqual({ n: 1 });
  });
});

describe('the integrations migration upgrading a database that already holds data', () => {
  const openUpgradedDatabase = () => {
    const db = openDatabase();
    applyMigrations(db, migrationsBeforeIntegrations);
    db.prepare("INSERT INTO projects (id, name, created_at) VALUES ('p1', 'One', 't0')").run();
    db.prepare("INSERT INTO playbooks (id, project_id, name, inputs_json, flow_json, policy_json, origin, created_at, updated_at) VALUES ('pb1', 'p1', 'P', '[]', '{\"cells\":[]}', '{}', 'native', 'n', 'n')").run();
    db.prepare("INSERT INTO secret_refs (id, scope_kind, scope_id, name, status, set_at, set_by) VALUES ('r1', 'playbook', 'pb1', 'JIRA_TOKEN', 'stored', 't1', 'admin')").run();
    applyMigrations(db);
    return db;
  };

  it('applies only 070 on top of what was there and keeps the projects, playbooks and secret refs untouched', () => {
    const db = openUpgradedDatabase();

    expect(db.prepare('SELECT version FROM schema_migrations WHERE version >= ? ORDER BY version').all(INTEGRATIONS_VERSION)).toEqual([{ version: INTEGRATIONS_VERSION }]);
    expect(db.prepare('SELECT id, name FROM projects').all()).toEqual([{ id: 'p1', name: 'One' }]);
    expect(db.prepare('SELECT id, project_id FROM playbooks').all()).toEqual([{ id: 'pb1', project_id: 'p1' }]);
    expect(db.prepare('SELECT scope_kind, scope_id, name, status, set_at, set_by FROM secret_refs').all()).toEqual([{ scope_kind: 'playbook', scope_id: 'pb1', name: 'JIRA_TOKEN', status: 'stored', set_at: 't1', set_by: 'admin' }]);
  });

  it('starts the new tables empty and ready for a connection, a profile and its health', () => {
    const db = openUpgradedDatabase();

    insertConnection(db);
    insertProfile(db);
    insertHealth(db, 'rate_limited');

    expect(db.prepare('SELECT status FROM integration_health').all()).toEqual([{ status: 'rate_limited' }]);
  });
});
