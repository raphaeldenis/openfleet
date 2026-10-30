import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { applyMigrations } from './migrate.js';

const migrationsDirectory = new URL('./migrations/', import.meta.url);
const attendedDownMigration = new URL('./migrations-down/058_session_attended.down.sql', import.meta.url);

const migrationsUpTo = (lastFileName: string) =>
  readdirSync(migrationsDirectory)
    .filter((fileName) => fileName.endsWith('.sql') && fileName <= lastFileName)
    .sort()
    .map((fileName) => ({ version: fileName.replace(/\.sql$/, ''), sql: readFileSync(new URL(fileName, migrationsDirectory), 'utf8') }));

const databaseUpTo = (lastFileName: string): DatabaseSync => {
  const db = new DatabaseSync(':memory:');
  applyMigrations(db, migrationsUpTo(lastFileName));
  return db;
};

const BEFORE_ATTENDED = '057_escalation_handover_refusal.sql';
const WITH_ATTENDED = '058_session_attended.sql';

const columnNamesOf = (db: DatabaseSync, table: string): string[] =>
  (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(({ name }) => name);

const insertSession = (db: DatabaseSync, id: string) =>
  db.exec(`INSERT INTO sessions (id, name, directory, harness, state, state_since, hook_token, mcp_token, created_at) VALUES ('${id}', 'Lead', '/tmp', 'fake', 'idle', 't', 'hook-${id}', 'mcp-${id}', 't')`);

const attendedOf = (db: DatabaseSync, id: string) => (db.prepare('SELECT attended FROM sessions WHERE id = ?').get(id) as { attended: number }).attended;

describe('migration 058, the attended flag of a session', () => {
  it('gives every session that existed before the migration attended = 0, with no backfill', () => {
    const db = databaseUpTo(BEFORE_ATTENDED);
    insertSession(db, 'm1');
    insertSession(db, 'm2');

    applyMigrations(db, migrationsUpTo(WITH_ATTENDED));

    expect([attendedOf(db, 'm1'), attendedOf(db, 'm2')]).toEqual([0, 0]);
  });

  it('accepts 0 and 1 at creation and refuses any other value', () => {
    const db = databaseUpTo(WITH_ATTENDED);

    expect(() => db.exec("INSERT INTO sessions (id, name, directory, harness, state, state_since, hook_token, mcp_token, created_at, attended) VALUES ('a', 'A', '/tmp', 'fake', 'idle', 't', 'h1', 'm1', 't', 1)")).not.toThrow();
    expect(() => db.exec("INSERT INTO sessions (id, name, directory, harness, state, state_since, hook_token, mcp_token, created_at, attended) VALUES ('b', 'B', '/tmp', 'fake', 'idle', 't', 'h2', 'm2', 't', 2)")).toThrow();
  });

  it('refuses any update that changes the flag, and lets every other update through', () => {
    const db = databaseUpTo(WITH_ATTENDED);
    insertSession(db, 'm1');

    expect(() => db.exec("UPDATE sessions SET attended = 1 WHERE id = 'm1'")).toThrow(/fixed at creation/);
    expect(() => db.exec("UPDATE sessions SET name = 'Renamed' WHERE id = 'm1'")).not.toThrow();
    expect(() => db.exec("UPDATE sessions SET attended = 0 WHERE id = 'm1'")).not.toThrow();
    expect(attendedOf(db, 'm1')).toBe(0);
  });

  it('is undone by its down migration, which drops the column and its trigger', () => {
    const databaseBefore = databaseUpTo(BEFORE_ATTENDED);
    const databaseAfter = databaseUpTo(WITH_ATTENDED);
    insertSession(databaseAfter, 'm1');

    databaseAfter.exec(readFileSync(attendedDownMigration, 'utf8'));

    expect(columnNamesOf(databaseAfter, 'sessions')).toEqual(columnNamesOf(databaseBefore, 'sessions'));
    expect(databaseAfter.prepare("SELECT count(*) AS count FROM sqlite_master WHERE type = 'trigger' AND name = 'sessions_attended_is_fixed_at_creation'").get()).toEqual({ count: 0 });
    expect(databaseAfter.prepare('SELECT count(*) AS count FROM sessions').get()).toEqual({ count: 1 });
  });
});
