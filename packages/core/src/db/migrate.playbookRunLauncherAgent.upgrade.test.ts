import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { applyMigrations } from './migrate.js';

const migrationsDirectory = new URL('./migrations/', import.meta.url);
const migrationsDownDirectory = new URL('./migrations-down/', import.meta.url);
const AGENT_LAUNCHER_VERSION = '076_playbook_run_launcher_agent';
const LAUNCHER_PAIR_VERSION = '075_playbook_run_launcher_pair';

const sourceOf = (fileName: string) => ({ version: fileName.replace(/\.sql$/, ''), sql: readFileSync(new URL(fileName, migrationsDirectory), 'utf8') });
const migrationFileNames = readdirSync(migrationsDirectory).filter((fileName) => fileName.endsWith('.sql')).sort();
const migrationsBeforeAgentLauncher = migrationFileNames.filter((fileName) => fileName < `${AGENT_LAUNCHER_VERSION}.sql`).map(sourceOf);
const downSqlOf = (version: string) => readFileSync(new URL(`${version}.down.sql`, migrationsDownDirectory), 'utf8');

/** A database as 075 left it: finished, running and parked runs, with steps, a manual request and one run of each known launcher. */
const openPopulatedDatabaseBeforeTheMigration = () => {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  applyMigrations(db, migrationsBeforeAgentLauncher);
  db.prepare("INSERT INTO projects (id, name, created_at) VALUES ('p1', 'One', 't0')").run();
  db.prepare("INSERT INTO playbooks (id, project_id, name, inputs_json, flow_json, policy_json, origin, created_at, updated_at) VALUES ('pb1', 'p1', 'P', '[]', '{\"cells\":[]}', '{}', 'native', 't0', 't0')").run();
  const insertRun = db.prepare("INSERT INTO playbook_runs (id, playbook_id, playbook_rev, flow_sha256, status, inputs_json, actor_kind, started_at, ended_at, launched_by_kind, launched_by_ref) VALUES (?, 'pb1', 1, 'sha', ?, '{}', 'admin', ?, ?, ?, ?)");
  insertRun.run('done', 'succeeded', 't1', 't2', 'admin_api', null);
  insertRun.run('live', 'running', 't3', null, 'trigger', 'trigger-1');
  insertRun.run('parked', 'waiting_manual', 't4', null, null, null);
  insertRun.run('old-unknown', 'failed', 't0', 't0', 'unknown', null);
  db.prepare("INSERT INTO playbook_run_steps (run_id, seq, step_id, status, output_json_masked, started_at, ended_at) VALUES ('done', 1, 'a', 'succeeded', '{\"x\":\"y\"}', 't1', 't1')").run();
  db.prepare("INSERT INTO playbook_run_steps (run_id, seq, step_id, status, started_at) VALUES ('parked', 1, 'gate', 'waiting_manual', 't4')").run();
  db.prepare("INSERT INTO playbook_manual_requests (run_id, seq, prompt_masked, status, requested_at, expires_at) VALUES ('parked', 1, 'Ship it?', 'pending', 't4', 't9')").run();
  return db;
};

const applyTheMigration = (db: DatabaseSync) => applyMigrations(db, [...migrationsBeforeAgentLauncher, sourceOf(`${AGENT_LAUNCHER_VERSION}.sql`)]);
const rowsOf = (db: DatabaseSync, sql: string) => db.prepare(sql).all();
const indexNamesOf = (db: DatabaseSync, table: string) => (db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = ? AND name NOT LIKE 'sqlite_%' ORDER BY name").all(table) as { name: string }[]).map((row) => row.name);
const insertRunWithLauncher = (db: DatabaseSync, { id, kind, ref }: { id: string; kind: string | null; ref: string | null }) =>
  db.prepare("INSERT INTO playbook_runs (id, playbook_id, playbook_rev, flow_sha256, status, inputs_json, actor_kind, started_at, launched_by_kind, launched_by_ref) VALUES (?, 'pb1', 1, 'sha', 'running', '{}', 'admin', 't5', ?, ?)").run(id, kind, ref);

describe('the agent run launcher migration', () => {
  it('is the 076 file and replays on an empty database, once', () => {
    const db = new DatabaseSync(':memory:');

    applyMigrations(db);
    applyMigrations(db);

    expect(db.prepare('SELECT version FROM schema_migrations WHERE version = ?').all(AGENT_LAUNCHER_VERSION)).toEqual([{ version: AGENT_LAUNCHER_VERSION }]);
  });

  it('keeps every run with its launcher, the steps, the manual requests, the indexes and the foreign keys of a populated database', () => {
    const db = openPopulatedDatabaseBeforeTheMigration();
    const runsBefore = rowsOf(db, 'SELECT * FROM playbook_runs ORDER BY id');
    const stepsBefore = rowsOf(db, 'SELECT * FROM playbook_run_steps ORDER BY run_id, seq');
    const requestsBefore = rowsOf(db, 'SELECT * FROM playbook_manual_requests');
    const runIndexesBefore = indexNamesOf(db, 'playbook_runs');
    const requestIndexesBefore = indexNamesOf(db, 'playbook_manual_requests');

    applyTheMigration(db);

    expect(rowsOf(db, 'SELECT * FROM playbook_runs ORDER BY id')).toEqual(runsBefore);
    expect(rowsOf(db, 'SELECT * FROM playbook_run_steps ORDER BY run_id, seq')).toEqual(stepsBefore);
    expect(rowsOf(db, 'SELECT * FROM playbook_manual_requests')).toEqual(requestsBefore);
    expect(indexNamesOf(db, 'playbook_runs')).toEqual(runIndexesBefore);
    expect(indexNamesOf(db, 'playbook_manual_requests')).toEqual(requestIndexesBefore);
    expect(rowsOf(db, 'PRAGMA foreign_key_check')).toEqual([]);
  });

  it('still cascades from the playbook to its runs, steps and manual requests', () => {
    const db = openPopulatedDatabaseBeforeTheMigration();
    applyTheMigration(db);

    db.prepare("DELETE FROM playbooks WHERE id = 'pb1'").run();

    expect(rowsOf(db, 'SELECT * FROM playbook_runs')).toEqual([]);
    expect(rowsOf(db, 'SELECT * FROM playbook_run_steps')).toEqual([]);
    expect(rowsOf(db, 'SELECT * FROM playbook_manual_requests')).toEqual([]);
  });

  it('accepts the launcher pairs the application writes, an agent with its session included', () => {
    const db = openPopulatedDatabaseBeforeTheMigration();
    applyTheMigration(db);

    insertRunWithLauncher(db, { id: 'by-admin', kind: 'admin_api', ref: null });
    insertRunWithLauncher(db, { id: 'by-trigger', kind: 'trigger', ref: 'trigger-2' });
    insertRunWithLauncher(db, { id: 'by-agent', kind: 'agent', ref: 'session-7' });
    insertRunWithLauncher(db, { id: 'by-nobody-known', kind: 'unknown', ref: null });

    expect(rowsOf(db, "SELECT id, launched_by_kind, launched_by_ref FROM playbook_runs WHERE id LIKE 'by-%' ORDER BY id")).toEqual([
      { id: 'by-admin', launched_by_kind: 'admin_api', launched_by_ref: null },
      { id: 'by-agent', launched_by_kind: 'agent', launched_by_ref: 'session-7' },
      { id: 'by-nobody-known', launched_by_kind: 'unknown', launched_by_ref: null },
      { id: 'by-trigger', launched_by_kind: 'trigger', launched_by_ref: 'trigger-2' },
    ]);
  });

  it('refuses a direct insert of a launcher pair the application cannot read, an agent without its session included', () => {
    const db = openPopulatedDatabaseBeforeTheMigration();
    applyTheMigration(db);

    expect(() => insertRunWithLauncher(db, { id: 'agent-without-ref', kind: 'agent', ref: null })).toThrow(/CHECK constraint failed/);
    expect(() => insertRunWithLauncher(db, { id: 'agent-empty-ref', kind: 'agent', ref: '' })).toThrow(/CHECK constraint failed/);
    expect(() => insertRunWithLauncher(db, { id: 'trigger-without-ref', kind: 'trigger', ref: null })).toThrow(/CHECK constraint failed/);
    expect(() => insertRunWithLauncher(db, { id: 'admin-with-ref', kind: 'admin_api', ref: 'session-7' })).toThrow(/CHECK constraint failed/);
    expect(() => insertRunWithLauncher(db, { id: 'unknown-with-ref', kind: 'unknown', ref: 'session-7' })).toThrow(/CHECK constraint failed/);
    expect(() => insertRunWithLauncher(db, { id: 'ref-without-kind', kind: null, ref: 'session-7' })).toThrow(/CHECK constraint failed/);
    expect(() => insertRunWithLauncher(db, { id: 'cron', kind: 'cron', ref: null })).toThrow(/CHECK constraint failed/);
    expect(rowsOf(db, 'SELECT COUNT(*) AS n FROM playbook_runs')).toEqual([{ n: 4 }]);
  });

  it('still refuses any update of the launcher, and lets every other update through', () => {
    const db = openPopulatedDatabaseBeforeTheMigration();
    applyTheMigration(db);
    insertRunWithLauncher(db, { id: 'by-agent', kind: 'agent', ref: 'session-7' });

    expect(() => db.exec("UPDATE playbook_runs SET launched_by_kind = 'unknown', launched_by_ref = NULL WHERE id = 'by-agent'")).toThrow(/fixed at creation/);
    expect(() => db.exec("UPDATE playbook_runs SET launched_by_ref = 'session-9' WHERE id = 'by-agent'")).toThrow(/fixed at creation/);
    expect(() => db.exec("UPDATE playbook_runs SET status = 'failed', error_code = 'x', ended_at = 't9' WHERE id = 'by-agent'")).not.toThrow();
    expect(rowsOf(db, "SELECT launched_by_kind, launched_by_ref FROM playbook_runs WHERE id = 'by-agent'")).toEqual([{ launched_by_kind: 'agent', launched_by_ref: 'session-7' }]);
  });
});

describe('the down of the agent run launcher migration', () => {
  it('returns to the shape of 075 and keeps every run, step and manual request; a run of an agent reads as an unknown launcher', () => {
    const databaseBefore = openPopulatedDatabaseBeforeTheMigration();
    const runsBefore = rowsOf(databaseBefore, 'SELECT * FROM playbook_runs ORDER BY id');
    const stepsBefore = rowsOf(databaseBefore, 'SELECT * FROM playbook_run_steps ORDER BY run_id, seq');
    const requestsBefore = rowsOf(databaseBefore, 'SELECT * FROM playbook_manual_requests');
    const db = openPopulatedDatabaseBeforeTheMigration();
    applyTheMigration(db);
    insertRunWithLauncher(db, { id: 'by-trigger', kind: 'trigger', ref: 'trigger-2' });
    insertRunWithLauncher(db, { id: 'by-agent', kind: 'agent', ref: 'session-7' });

    db.exec(downSqlOf(AGENT_LAUNCHER_VERSION));

    expect(rowsOf(db, "SELECT * FROM playbook_runs WHERE id NOT LIKE 'by-%' ORDER BY id")).toEqual(runsBefore);
    expect(rowsOf(db, "SELECT id, launched_by_kind, launched_by_ref FROM playbook_runs WHERE id LIKE 'by-%' ORDER BY id")).toEqual([
      { id: 'by-agent', launched_by_kind: 'unknown', launched_by_ref: null },
      { id: 'by-trigger', launched_by_kind: 'trigger', launched_by_ref: 'trigger-2' },
    ]);
    expect(rowsOf(db, 'SELECT * FROM playbook_run_steps ORDER BY run_id, seq')).toEqual(stepsBefore);
    expect(rowsOf(db, 'SELECT * FROM playbook_manual_requests')).toEqual(requestsBefore);
    expect(indexNamesOf(db, 'playbook_runs')).toEqual(indexNamesOf(databaseBefore, 'playbook_runs'));
    expect(rowsOf(db, 'PRAGMA foreign_key_check')).toEqual([]);
    expect(() => insertRunWithLauncher(db, { id: 'agent-again', kind: 'agent', ref: 'session-7' })).toThrow(/CHECK constraint failed/);
    expect(() => db.exec("UPDATE playbook_runs SET launched_by_kind = 'unknown' WHERE id = 'live'")).toThrow(/fixed at creation/);
  });

  it('lets the 075 down run after it, then the migrations apply again', () => {
    const db = openPopulatedDatabaseBeforeTheMigration();
    applyTheMigration(db);
    db.exec(downSqlOf(AGENT_LAUNCHER_VERSION));
    db.exec(downSqlOf(LAUNCHER_PAIR_VERSION));
    db.prepare('DELETE FROM schema_migrations WHERE version IN (?, ?)').run(AGENT_LAUNCHER_VERSION, LAUNCHER_PAIR_VERSION);

    applyMigrations(db, [...migrationsBeforeAgentLauncher, sourceOf(`${AGENT_LAUNCHER_VERSION}.sql`)]);

    expect(rowsOf(db, 'SELECT COUNT(*) AS n FROM playbook_runs')).toEqual([{ n: 4 }]);
    expect(rowsOf(db, 'PRAGMA foreign_key_check')).toEqual([]);
  });
});
