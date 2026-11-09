import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { applyMigrations } from './migrate.js';

const migrationsDirectory = new URL('./migrations/', import.meta.url);
const migrationsDownDirectory = new URL('./migrations-down/', import.meta.url);

const openMigratedDatabase = () => {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  applyMigrations(db);
  db.prepare("INSERT INTO projects (id, name, created_at) VALUES ('p1', 'One', 't0')").run();
  db.prepare("INSERT INTO playbooks (id, project_id, name, inputs_json, flow_json, policy_json, origin, created_at, updated_at) VALUES ('pb1', 'p1', 'P', '[]', '{\"cells\":[]}', '{}', 'native', 'n', 'n')").run();
  return db;
};

const insertRun = (db: DatabaseSync, overrides: { id?: string; status?: string; endedAt?: string | null; actorKind?: string } = {}) =>
  db.prepare("INSERT INTO playbook_runs (id, playbook_id, playbook_rev, flow_sha256, status, inputs_json, actor_kind, started_at, ended_at) VALUES (?, 'pb1', 1, 'sha', ?, '{}', ?, 's', ?)")
    .run(overrides.id ?? 'r1', overrides.status ?? 'running', overrides.actorKind ?? 'admin', overrides.endedAt === undefined ? null : overrides.endedAt);

const insertStep = (db: DatabaseSync, overrides: { seq?: number; status?: string; endedAt?: string | null } = {}) =>
  db.prepare("INSERT INTO playbook_run_steps (run_id, seq, step_id, status, started_at, ended_at) VALUES ('r1', ?, 'build', ?, 's', ?)")
    .run(overrides.seq ?? 1, overrides.status ?? 'running', overrides.endedAt === undefined ? null : overrides.endedAt);

describe('the playbook runs migration', () => {
  it('adds the pinned scripts of an approval to the playbooks, empty until a human approves', () => {
    const db = openMigratedDatabase();

    expect(db.prepare('SELECT approved_scripts_json FROM playbooks').get()).toEqual({ approved_scripts_json: null });
  });

  it('keeps the playbooks, their approval and their versions of a database populated at 068', () => {
    const db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys = ON;');
    const migrationFiles = readdirSync(migrationsDirectory).filter((file) => file.endsWith('.sql')).sort();
    const sourcesUpTo068 = migrationFiles.filter((file) => file < '069').map((file) => ({ version: file.replace(/\.sql$/, ''), sql: readFileSync(new URL(file, migrationsDirectory), 'utf8') }));
    applyMigrations(db, sourcesUpTo068);
    db.prepare("INSERT INTO projects (id, name, created_at) VALUES ('p1', 'One', 't0')").run();
    db.prepare("INSERT INTO playbooks (id, project_id, name, inputs_json, flow_json, policy_json, origin, created_at, updated_at, approved_digest, approved_by, approved_at) VALUES ('old', 'p1', 'Old', '[{\"name\":\"who\",\"type\":\"string\"}]', '{\"cells\":[{\"id\":\"a\",\"kind\":\"manual\",\"prompt\":\"Check\"}]}', '{\"maxRunsToKeep\":7}', 'native', 'n', 'n', 'digest-68', 'human', 'then')").run();
    const before = db.prepare("SELECT * FROM playbooks WHERE id = 'old'").get() as Record<string, unknown>;

    applyMigrations(db);

    const after = db.prepare("SELECT * FROM playbooks WHERE id = 'old'").get() as Record<string, unknown>;
    expect(after).toEqual({ ...before, approved_scripts_json: null });
    expect(db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name IN ('playbook_runs', 'playbook_run_steps')").get()).toEqual({ n: 2 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM playbook_runs").get()).toEqual({ n: 0 });
  });

  it('refuses a run status outside running, succeeded, failed and needs_review', () => {
    const db = openMigratedDatabase();

    expect(() => insertRun(db, { status: 'queued', endedAt: null })).toThrow(/CHECK constraint/);
  });

  it('refuses a running run that has an end, and a finished run that has none', () => {
    const db = openMigratedDatabase();

    expect(() => insertRun(db, { status: 'running', endedAt: 'e' })).toThrow(/CHECK constraint/);
    expect(() => insertRun(db, { status: 'succeeded', endedAt: null })).toThrow(/CHECK constraint/);
  });

  it('refuses an actor kind other than the admin', () => {
    const db = openMigratedDatabase();

    expect(() => insertRun(db, { actorKind: 'agent' })).toThrow(/CHECK constraint/);
  });

  it('refuses a step with a sequence number below 1, a second step at the same position, and a finished step with no end', () => {
    const db = openMigratedDatabase();
    insertRun(db);
    insertStep(db);

    expect(() => insertStep(db, { seq: 0 })).toThrow(/CHECK constraint/);
    expect(() => insertStep(db, { seq: 1 })).toThrow(/UNIQUE|PRIMARY KEY/);
    expect(() => insertStep(db, { seq: 2, status: 'failed', endedAt: null })).toThrow(/CHECK constraint/);
  });

  it('removes the runs and their steps with the playbook', () => {
    const db = openMigratedDatabase();
    insertRun(db);
    insertStep(db);

    db.prepare("DELETE FROM playbooks WHERE id = 'pb1'").run();

    expect(db.prepare('SELECT (SELECT COUNT(*) FROM playbook_runs) AS runs, (SELECT COUNT(*) FROM playbook_run_steps) AS steps').get()).toEqual({ runs: 0, steps: 0 });
  });

  it('ships a down migration outside the migrations folder that removes the tables and the column', () => {
    const db = openMigratedDatabase();

    db.exec(readFileSync(new URL('069_playbook_runs.down.sql', migrationsDownDirectory), 'utf8'));

    expect(db.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'playbook_run%'").all()).toEqual([]);
    expect((db.prepare('PRAGMA table_info(playbooks)').all() as { name: string }[]).map((column) => column.name)).not.toContain('approved_scripts_json');
  });
});
