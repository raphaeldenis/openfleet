import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { applyMigrations } from './migrate.js';

const migrationsDirectory = new URL('./migrations/', import.meta.url);

const migrationsBeforeCloseReason = readdirSync(migrationsDirectory)
  .filter((fileName) => fileName.endsWith('.sql') && fileName < '019')
  .sort()
  .map((fileName) => ({ version: fileName.replace(/\.sql$/, ''), sql: readFileSync(new URL(fileName, migrationsDirectory), 'utf8') }));

const insertSession = (db: DatabaseSync, input: { id: string; state: string; exitCode: number | null }) =>
  db.prepare(`INSERT INTO sessions (id, name, emoji, directory, harness, state, state_since, exit_code, hook_token, mcp_token, created_at)
    VALUES (?, ?, '🤖', '/tmp', 'fake', ?, 't0', ?, ?, ?, 't0')`).run(input.id, input.id, input.state, input.exitCode, `hook-${input.id}`, `mcp-${input.id}`);

const openDatabaseUpgradedFromBeforeCloseReason = () => {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  applyMigrations(db, migrationsBeforeCloseReason);
  insertSession(db, { id: 'live', state: 'idle', exitCode: null });
  insertSession(db, { id: 'crashed', state: 'closed', exitCode: 143 });
  db.prepare("INSERT INTO session_events (session_id, kind, ts) VALUES ('crashed', 'reopened', 't1')").run();
  applyMigrations(db);
  return db;
};

describe('the close reason column migration upgrading a database that predates it', () => {
  it('keeps the existing sessions, their exit codes and events intact and passes the foreign key check', () => {
    const db = openDatabaseUpgradedFromBeforeCloseReason();

    const sessions = db.prepare('SELECT id, state, exit_code FROM sessions ORDER BY id').all();
    const events = db.prepare('SELECT session_id, kind, ts FROM session_events').all();
    const foreignKeyViolations = db.prepare('PRAGMA foreign_key_check').all();

    expect(sessions).toEqual([{ id: 'crashed', state: 'closed', exit_code: 143 }, { id: 'live', state: 'idle', exit_code: null }]);
    expect(events).toEqual([{ session_id: 'crashed', kind: 'reopened', ts: 't1' }]);
    expect(foreignKeyViolations).toEqual([]);
  });

  it('records the migration as applied', () => {
    const db = openDatabaseUpgradedFromBeforeCloseReason();

    const versions = (db.prepare('SELECT version FROM schema_migrations').all() as { version: string }[]).map((row) => row.version);

    expect(versions).toContain('019_session_close_reason');
  });

  it('leaves every existing session, closed ones included, without a close reason (no backfill)', () => {
    const db = openDatabaseUpgradedFromBeforeCloseReason();

    const reasons = db.prepare('SELECT id, close_reason FROM sessions ORDER BY id').all();

    expect(reasons).toEqual([{ id: 'crashed', close_reason: null }, { id: 'live', close_reason: null }]);
  });

  it('keeps the column optional', () => {
    const db = openDatabaseUpgradedFromBeforeCloseReason();

    const column = db.prepare("SELECT \"notnull\" AS required FROM pragma_table_info('sessions') WHERE name = 'close_reason'").get();

    expect(column).toEqual({ required: 0 });
  });
});
