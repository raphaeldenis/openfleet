import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { applyMigrations } from './migrate.js';

const migrationsDirectory = new URL('./migrations/', import.meta.url);

const migrationsBeforeWorkingState = readdirSync(migrationsDirectory)
  .filter((fileName) => fileName.endsWith('.sql') && fileName < '014')
  .sort()
  .map((fileName) => ({ version: fileName.replace(/\.sql$/, ''), sql: readFileSync(new URL(fileName, migrationsDirectory), 'utf8') }));

const insertSession = (db: DatabaseSync, id: string, parentId: string | null) =>
  db.prepare(`INSERT INTO sessions (id, name, emoji, directory, harness, state, state_since, hook_token, mcp_token, parent_id, created_at)
    VALUES (?, ?, '🤖', '/tmp', 'fake', 'idle', 't0', ?, ?, ?, 't0')`).run(id, id, `hook-${id}`, `mcp-${id}`, parentId);

const openDatabaseUpgradedFromBeforeWorkingState = () => {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  applyMigrations(db, migrationsBeforeWorkingState);
  insertSession(db, 'lead', null);
  insertSession(db, 'child', 'lead');
  applyMigrations(db);
  return db;
};

describe('the working state migration upgrading a database that predates it', () => {
  it('keeps every existing session intact and passes the foreign key check', () => {
    const db = openDatabaseUpgradedFromBeforeWorkingState();

    const sessions = db.prepare('SELECT id, parent_id FROM sessions ORDER BY id').all();
    const foreignKeyViolations = db.prepare('PRAGMA foreign_key_check').all();

    expect(sessions).toEqual([{ id: 'child', parent_id: 'lead' }, { id: 'lead', parent_id: null }]);
    expect(foreignKeyViolations).toEqual([]);
  });

  it('records the migration as 014_working_state', () => {
    const db = openDatabaseUpgradedFromBeforeWorkingState();

    const versions = (db.prepare('SELECT version FROM schema_migrations').all() as { version: string }[]).map((row) => row.version);

    expect(versions).toContain('014_working_state');
  });

  it('holds one state per existing session and refuses a state for a missing session', () => {
    const db = openDatabaseUpgradedFromBeforeWorkingState();
    const insertState = (sessionId: string, sections: string) =>
      db.prepare('INSERT INTO session_working_states (session_id, sections_json, updated_at) VALUES (?, ?, ?)').run(sessionId, sections, 't1');

    insertState('lead', '{}');

    expect(() => insertState('lead', '{}')).toThrow(/UNIQUE|PRIMARY/);
    expect(() => insertState('ghost', '{}')).toThrow(/FOREIGN KEY/);
    expect(() => insertState('child', 'not json')).toThrow(/CHECK/);
    expect(() => insertState('child', '[]')).toThrow(/CHECK/);
  });
});
