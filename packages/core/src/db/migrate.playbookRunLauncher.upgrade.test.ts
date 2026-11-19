import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { applyMigrations } from './migrate.js';

const migrationsDirectory = new URL('./migrations/', import.meta.url);
const migrationsDownDirectory = new URL('./migrations-down/', import.meta.url);
const RUN_LAUNCHER_VERSION = '074_playbook_run_launcher';

const sourceOf = (fileName: string) => ({ version: fileName.replace(/\.sql$/, ''), sql: readFileSync(new URL(fileName, migrationsDirectory), 'utf8') });
const migrationFileNames = readdirSync(migrationsDirectory).filter((fileName) => fileName.endsWith('.sql')).sort();
const migrationsBeforeRunLauncher = migrationFileNames.filter((fileName) => fileName < `${RUN_LAUNCHER_VERSION}.sql`).map(sourceOf);

/** A database as 073 left it: a project, a playbook, a finished run with a step, a run still running, and a run parked for a human. */
const openPopulatedDatabaseBeforeTheMigration = () => {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  applyMigrations(db, migrationsBeforeRunLauncher);
  db.prepare("INSERT INTO projects (id, name, created_at) VALUES ('p1', 'One', 't0')").run();
  db.prepare("INSERT INTO playbooks (id, project_id, name, inputs_json, flow_json, policy_json, origin, created_at, updated_at) VALUES ('pb1', 'p1', 'P', '[]', '{\"cells\":[]}', '{}', 'native', 't0', 't0')").run();
  db.prepare("INSERT INTO playbook_runs (id, playbook_id, playbook_rev, flow_sha256, status, inputs_json, actor_kind, started_at, ended_at) VALUES ('done', 'pb1', 1, 'sha', 'succeeded', '{\"a\":1}', 'admin', 't1', 't2')").run();
  db.prepare("INSERT INTO playbook_runs (id, playbook_id, playbook_rev, flow_sha256, status, inputs_json, actor_kind, started_at) VALUES ('live', 'pb1', 1, 'sha', 'running', '{}', 'admin', 't3')").run();
  db.prepare("INSERT INTO playbook_runs (id, playbook_id, playbook_rev, flow_sha256, status, inputs_json, actor_kind, started_at) VALUES ('parked', 'pb1', 1, 'sha', 'waiting_manual', '{}', 'admin', 't4')").run();
  db.prepare("INSERT INTO playbook_run_steps (run_id, seq, step_id, status, output_json_masked, started_at, ended_at) VALUES ('done', 1, 'a', 'succeeded', '{\"x\":\"y\"}', 't1', 't1')").run();
  db.prepare("INSERT INTO playbook_run_steps (run_id, seq, step_id, status, started_at) VALUES ('parked', 1, 'gate', 'waiting_manual', 't4')").run();
  db.prepare("INSERT INTO playbook_manual_requests (run_id, seq, prompt_masked, status, requested_at, expires_at) VALUES ('parked', 1, 'Ship it?', 'pending', 't4', 't9')").run();
  return db;
};

const applyTheMigration = (db: DatabaseSync) => applyMigrations(db, [...migrationsBeforeRunLauncher, sourceOf(`${RUN_LAUNCHER_VERSION}.sql`)]);
const rowsOf = (db: DatabaseSync, sql: string) => db.prepare(sql).all();
const columnNamesOf = (db: DatabaseSync, table: string) => (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(({ name }) => name);
const indexNamesOf = (db: DatabaseSync, table: string) => (db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = ? AND name NOT LIKE 'sqlite_%' ORDER BY name").all(table) as { name: string }[]).map((row) => row.name);
const insertRun = (db: DatabaseSync, { id, kind, ref }: { id: string; kind: string | null; ref: string | null }) =>
  db.prepare("INSERT INTO playbook_runs (id, playbook_id, playbook_rev, flow_sha256, status, inputs_json, actor_kind, started_at, launched_by_kind, launched_by_ref) VALUES (?, 'pb1', 1, 'sha', 'running', '{}', 'admin', 't5', ?, ?)").run(id, kind, ref);

describe('the run launcher migration', () => {
  it('is the 074 file and replays on an empty database, once', () => {
    const db = new DatabaseSync(':memory:');

    applyMigrations(db);
    applyMigrations(db);

    expect(db.prepare('SELECT version FROM schema_migrations WHERE version = ?').all(RUN_LAUNCHER_VERSION)).toEqual([{ version: RUN_LAUNCHER_VERSION }]);
  });

  it('keeps the runs, the steps, the requests, the indexes and the foreign keys of a populated database, and adds two empty columns', () => {
    const db = openPopulatedDatabaseBeforeTheMigration();
    const runsBefore = rowsOf(db, 'SELECT * FROM playbook_runs ORDER BY id');
    const stepsBefore = rowsOf(db, 'SELECT * FROM playbook_run_steps ORDER BY run_id, seq');
    const requestsBefore = rowsOf(db, 'SELECT * FROM playbook_manual_requests');
    const indexesBefore = indexNamesOf(db, 'playbook_runs');

    applyTheMigration(db);

    const runsWithoutTheNewColumns = rowsOf(db, 'SELECT id, playbook_id, playbook_rev, flow_sha256, status, inputs_json, actor_kind, error_code, started_at, ended_at FROM playbook_runs ORDER BY id');
    expect(runsWithoutTheNewColumns).toEqual(runsBefore);
    expect(rowsOf(db, 'SELECT launched_by_kind, launched_by_ref FROM playbook_runs')).toEqual([
      { launched_by_kind: null, launched_by_ref: null }, { launched_by_kind: null, launched_by_ref: null }, { launched_by_kind: null, launched_by_ref: null },
    ]);
    expect(rowsOf(db, 'SELECT * FROM playbook_run_steps ORDER BY run_id, seq')).toEqual(stepsBefore);
    expect(rowsOf(db, 'SELECT * FROM playbook_manual_requests')).toEqual(requestsBefore);
    expect(indexNamesOf(db, 'playbook_runs')).toEqual(indexesBefore);
    expect(rowsOf(db, 'PRAGMA foreign_key_check')).toEqual([]);
  });

  it('still cascades from the playbook to its runs and from a run to its steps', () => {
    const db = openPopulatedDatabaseBeforeTheMigration();
    applyTheMigration(db);

    db.prepare("DELETE FROM playbooks WHERE id = 'pb1'").run();

    expect(rowsOf(db, 'SELECT * FROM playbook_runs')).toEqual([]);
    expect(rowsOf(db, 'SELECT * FROM playbook_run_steps')).toEqual([]);
  });

  it('stores the launcher given at the creation of a run', () => {
    const db = openPopulatedDatabaseBeforeTheMigration();
    applyTheMigration(db);

    insertRun(db, { id: 'by-trigger', kind: 'trigger', ref: 'trigger-1' });

    expect(rowsOf(db, "SELECT launched_by_kind, launched_by_ref FROM playbook_runs WHERE id = 'by-trigger'")).toEqual([{ launched_by_kind: 'trigger', launched_by_ref: 'trigger-1' }]);
  });

  it('refuses any update of the launcher, and lets every other update through', () => {
    const db = openPopulatedDatabaseBeforeTheMigration();
    applyTheMigration(db);
    insertRun(db, { id: 'by-admin', kind: 'admin_api', ref: null });

    expect(() => db.exec("UPDATE playbook_runs SET launched_by_kind = 'trigger' WHERE id = 'by-admin'")).toThrow(/fixed at creation/);
    expect(() => db.exec("UPDATE playbook_runs SET launched_by_ref = 'trigger-9' WHERE id = 'by-admin'")).toThrow(/fixed at creation/);
    expect(() => db.exec("UPDATE playbook_runs SET launched_by_kind = 'unknown' WHERE id = 'done'")).toThrow(/fixed at creation/);
    expect(() => db.exec("UPDATE playbook_runs SET status = 'failed', error_code = 'x', ended_at = 't9' WHERE id = 'by-admin'")).not.toThrow();
    expect(rowsOf(db, "SELECT launched_by_kind, launched_by_ref FROM playbook_runs WHERE id = 'by-admin'")).toEqual([{ launched_by_kind: 'admin_api', launched_by_ref: null }]);
  });
});

describe('the down of the run launcher migration', () => {
  const downSql = readFileSync(new URL(`${RUN_LAUNCHER_VERSION}.down.sql`, migrationsDownDirectory), 'utf8');

  it('drops the two columns and their guard, and loses no run, no step, no index', () => {
    const databaseBefore = openPopulatedDatabaseBeforeTheMigration();
    const db = openPopulatedDatabaseBeforeTheMigration();
    applyTheMigration(db);
    insertRun(db, { id: 'by-admin', kind: 'admin_api', ref: null });

    db.exec(downSql);

    expect(columnNamesOf(db, 'playbook_runs')).toEqual(columnNamesOf(databaseBefore, 'playbook_runs'));
    expect(rowsOf(db, "SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'playbook_runs_launcher%'")).toEqual([]);
    expect(rowsOf(db, 'SELECT COUNT(*) AS n FROM playbook_runs')).toEqual([{ n: 4 }]);
    expect(indexNamesOf(db, 'playbook_runs')).toEqual(indexNamesOf(databaseBefore, 'playbook_runs'));
    expect(rowsOf(db, 'PRAGMA foreign_key_check')).toEqual([]);
  });

  it('then lets the migration apply again', () => {
    const db = openPopulatedDatabaseBeforeTheMigration();
    applyTheMigration(db);
    db.exec(downSql);
    db.prepare('DELETE FROM schema_migrations WHERE version = ?').run(RUN_LAUNCHER_VERSION);

    applyTheMigration(db);

    expect(rowsOf(db, 'SELECT COUNT(*) AS n FROM playbook_runs')).toEqual([{ n: 3 }]);
  });
});
