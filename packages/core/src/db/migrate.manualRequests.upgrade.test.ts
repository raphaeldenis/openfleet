import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { applyMigrations } from './migrate.js';

const migrationsDirectory = new URL('./migrations/', import.meta.url);
const migrationsDownDirectory = new URL('./migrations-down/', import.meta.url);
const MANUAL_REQUESTS_VERSION = '073_playbook_manual_requests';

const sourceOf = (fileName: string) => ({ version: fileName.replace(/\.sql$/, ''), sql: readFileSync(new URL(fileName, migrationsDirectory), 'utf8') });
const migrationFileNames = readdirSync(migrationsDirectory).filter((fileName) => fileName.endsWith('.sql')).sort();
const migrationsBeforeManualRequests = migrationFileNames.filter((fileName) => fileName < `${MANUAL_REQUESTS_VERSION}.sql`).map(sourceOf);

const openDatabase = () => {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  return db;
};

/** A database as 072 left it, holding a project, a playbook, a finished run with two steps and a run still running. */
const openPopulatedDatabaseBeforeTheMigration = () => {
  const db = openDatabase();
  applyMigrations(db, migrationsBeforeManualRequests);
  db.prepare("INSERT INTO projects (id, name, created_at) VALUES ('p1', 'One', 't0')").run();
  db.prepare("INSERT INTO playbooks (id, project_id, name, inputs_json, flow_json, policy_json, origin, created_at, updated_at) VALUES ('pb1', 'p1', 'P', '[]', '{\"cells\":[]}', '{}', 'native', 't0', 't0')").run();
  db.prepare("INSERT INTO playbook_runs (id, playbook_id, playbook_rev, flow_sha256, status, inputs_json, actor_kind, error_code, started_at, ended_at) VALUES ('done', 'pb1', 1, 'sha', 'succeeded', '{\"a\":1}', 'admin', NULL, 't1', 't2')").run();
  db.prepare("INSERT INTO playbook_runs (id, playbook_id, playbook_rev, flow_sha256, status, inputs_json, actor_kind, started_at) VALUES ('live', 'pb1', 1, 'sha', 'running', '{}', 'admin', 't3')").run();
  db.prepare("INSERT INTO playbook_run_steps (run_id, seq, step_id, status, output_json_masked, started_at, ended_at) VALUES ('done', 1, 'a', 'succeeded', '{\"x\":\"y\"}', 't1', 't1')").run();
  db.prepare("INSERT INTO playbook_run_steps (run_id, seq, step_id, status, error_code, started_at, ended_at) VALUES ('done', 2, 'b', 'failed', 'script_failed', 't1', 't2')").run();
  db.prepare("INSERT INTO playbook_run_steps (run_id, seq, step_id, status, started_at) VALUES ('live', 1, 'a', 'running', 't3')").run();
  return db;
};

const applyTheMigration = (db: DatabaseSync) => applyMigrations(db, [...migrationsBeforeManualRequests, sourceOf(`${MANUAL_REQUESTS_VERSION}.sql`)]);
const rowsOf = (db: DatabaseSync, sql: string) => db.prepare(sql).all();
const indexNamesOf = (db: DatabaseSync, table: string) => (db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = ? AND name NOT LIKE 'sqlite_%' ORDER BY name").all(table) as { name: string }[]).map((row) => row.name);

const parkARun = (db: DatabaseSync) => {
  db.prepare("INSERT INTO playbook_runs (id, playbook_id, playbook_rev, flow_sha256, status, inputs_json, actor_kind, started_at) VALUES ('parked', 'pb1', 1, 'sha', 'waiting_manual', '{}', 'admin', 't4')").run();
  db.prepare("INSERT INTO playbook_run_steps (run_id, seq, step_id, status, started_at) VALUES ('parked', 1, 'gate', 'waiting_manual', 't4')").run();
  db.prepare("INSERT INTO playbook_manual_requests (run_id, seq, prompt_masked, status, requested_at, expires_at) VALUES ('parked', 1, 'Ship it?', 'pending', 't4', 't9')").run();
};

describe('the manual requests migration', () => {
  it('is the 073 file and replays on an empty database, once', () => {
    const db = openDatabase();

    applyMigrations(db);
    applyMigrations(db);

    expect(db.prepare('SELECT version FROM schema_migrations WHERE version = ?').all(MANUAL_REQUESTS_VERSION)).toEqual([{ version: MANUAL_REQUESTS_VERSION }]);
  });

  it('keeps the runs, the steps, the indexes and the foreign keys of a populated database', () => {
    const db = openPopulatedDatabaseBeforeTheMigration();
    const runsBefore = rowsOf(db, 'SELECT * FROM playbook_runs ORDER BY id');
    const stepsBefore = rowsOf(db, 'SELECT * FROM playbook_run_steps ORDER BY run_id, seq');
    const indexesBefore = [...indexNamesOf(db, 'playbook_runs'), ...indexNamesOf(db, 'playbook_run_steps')];

    applyTheMigration(db);

    expect(rowsOf(db, 'SELECT * FROM playbook_runs ORDER BY id')).toEqual(runsBefore);
    expect(rowsOf(db, 'SELECT * FROM playbook_run_steps ORDER BY run_id, seq')).toEqual(stepsBefore);
    expect([...indexNamesOf(db, 'playbook_runs'), ...indexNamesOf(db, 'playbook_run_steps')]).toEqual(indexesBefore);
    expect(rowsOf(db, 'PRAGMA foreign_key_check')).toEqual([]);
  });

  it('still cascades: deleting a run deletes its steps, deleting the playbook deletes its runs', () => {
    const db = openPopulatedDatabaseBeforeTheMigration();
    applyTheMigration(db);

    db.prepare("DELETE FROM playbook_runs WHERE id = 'done'").run();
    expect(rowsOf(db, "SELECT * FROM playbook_run_steps WHERE run_id = 'done'")).toEqual([]);
    db.prepare("DELETE FROM playbooks WHERE id = 'pb1'").run();

    expect(rowsOf(db, 'SELECT * FROM playbook_runs')).toEqual([]);
    expect(rowsOf(db, 'SELECT * FROM playbook_run_steps')).toEqual([]);
  });

  it('accepts a run and a step waiting for a human, without an end', () => {
    const db = openPopulatedDatabaseBeforeTheMigration();
    applyTheMigration(db);

    parkARun(db);

    expect(rowsOf(db, "SELECT status, ended_at FROM playbook_runs WHERE id = 'parked'")).toEqual([{ status: 'waiting_manual', ended_at: null }]);
  });

  it('refuses a waiting run that has an end, and a finished run that has none', () => {
    const db = openPopulatedDatabaseBeforeTheMigration();
    applyTheMigration(db);

    expect(() => db.prepare("INSERT INTO playbook_runs (id, playbook_id, playbook_rev, flow_sha256, status, inputs_json, actor_kind, started_at, ended_at) VALUES ('x', 'pb1', 1, 's', 'waiting_manual', '{}', 'admin', 't', 't')").run()).toThrow(/CHECK/);
    expect(() => db.prepare("INSERT INTO playbook_runs (id, playbook_id, playbook_rev, flow_sha256, status, inputs_json, actor_kind, started_at) VALUES ('y', 'pb1', 1, 's', 'succeeded', '{}', 'admin', 't')").run()).toThrow(/CHECK/);
  });

  it('holds one request per step, of a step that exists, with a known status and decision', () => {
    const db = openPopulatedDatabaseBeforeTheMigration();
    applyTheMigration(db);
    parkARun(db);

    expect(() => parkARun(db)).toThrow();
    expect(() => db.prepare("INSERT INTO playbook_manual_requests (run_id, seq, prompt_masked, status, requested_at, expires_at) VALUES ('ghost', 1, 'p', 'pending', 't', 't')").run()).toThrow(/FOREIGN KEY/);
    expect(() => db.prepare("UPDATE playbook_manual_requests SET status = 'maybe'").run()).toThrow(/CHECK/);
    expect(() => db.prepare("UPDATE playbook_manual_requests SET decision = 'shrug'").run()).toThrow(/CHECK/);
  });

  it('deletes the request with its step', () => {
    const db = openPopulatedDatabaseBeforeTheMigration();
    applyTheMigration(db);
    parkARun(db);

    db.prepare("DELETE FROM playbook_runs WHERE id = 'parked'").run();

    expect(rowsOf(db, 'SELECT * FROM playbook_manual_requests')).toEqual([]);
  });
});

describe('the down of the manual requests migration', () => {
  const downSql = readFileSync(new URL(`${MANUAL_REQUESTS_VERSION}.down.sql`, migrationsDownDirectory), 'utf8');

  it('puts a run and a step waiting for a human in needs_review with the code interrupted, loses no run and no step, and restores the old checks', () => {
    const db = openPopulatedDatabaseBeforeTheMigration();
    applyTheMigration(db);
    parkARun(db);

    db.exec(downSql);

    expect(rowsOf(db, 'SELECT id, status, error_code FROM playbook_runs ORDER BY id')).toEqual([
      { id: 'done', status: 'succeeded', error_code: null }, { id: 'live', status: 'running', error_code: null }, { id: 'parked', status: 'needs_review', error_code: 'interrupted' },
    ]);
    expect(rowsOf(db, "SELECT step_id, status, error_code FROM playbook_run_steps WHERE run_id = 'parked'")).toEqual([{ step_id: 'gate', status: 'needs_review', error_code: 'interrupted' }]);
    expect(rowsOf(db, 'SELECT COUNT(*) AS n FROM playbook_run_steps')).toEqual([{ n: 4 }]);
    expect(rowsOf(db, "SELECT ended_at IS NOT NULL AS ended FROM playbook_runs WHERE id = 'parked'")).toEqual([{ ended: 1 }]);
    expect(rowsOf(db, "SELECT name FROM sqlite_master WHERE name = 'playbook_manual_requests'")).toEqual([]);
    expect(rowsOf(db, 'PRAGMA foreign_key_check')).toEqual([]);
    expect(() => db.prepare("INSERT INTO playbook_runs (id, playbook_id, playbook_rev, flow_sha256, status, inputs_json, actor_kind, started_at) VALUES ('z', 'pb1', 1, 's', 'waiting_manual', '{}', 'admin', 't')").run()).toThrow(/CHECK/);
  });

  it('then lets the migration apply again', () => {
    const db = openPopulatedDatabaseBeforeTheMigration();
    applyTheMigration(db);
    db.exec(downSql);
    db.prepare('DELETE FROM schema_migrations WHERE version = ?').run(MANUAL_REQUESTS_VERSION);

    applyTheMigration(db);

    expect(rowsOf(db, 'SELECT COUNT(*) AS n FROM playbook_runs')).toEqual([{ n: 2 }]);
    expect(rowsOf(db, 'PRAGMA foreign_key_check')).toEqual([]);
  });
});
