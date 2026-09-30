import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { applyMigrations } from './migrate.js';

const migrationsDirectory = new URL('./migrations/', import.meta.url);

const migrationsBeforeHandovers = readdirSync(migrationsDirectory)
  .filter((fileName) => fileName.endsWith('.sql') && fileName < '015')
  .sort()
  .map((fileName) => ({ version: fileName.replace(/\.sql$/, ''), sql: readFileSync(new URL(fileName, migrationsDirectory), 'utf8') }));

const insertSession = (db: DatabaseSync, id: string) =>
  db.prepare(`INSERT INTO sessions (id, name, emoji, directory, harness, state, state_since, hook_token, mcp_token, parent_id, created_at)
    VALUES (?, ?, '🤖', '/tmp', 'fake', 'idle', 't0', ?, ?, NULL, 't0')`).run(id, id, `hook-${id}`, `mcp-${id}`);

const openDatabaseUpgradedFromBeforeHandovers = () => {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  applyMigrations(db, migrationsBeforeHandovers);
  insertSession(db, 'lead');
  db.prepare("INSERT INTO session_working_states (session_id, sections_json, updated_at) VALUES ('lead', '{}', 't1')").run();
  applyMigrations(db);
  return db;
};

const insertHandover = (db: DatabaseSync, { id, sessionId, kind, value }: { id: string; sessionId: string; kind: string; value: string }) =>
  db.prepare('INSERT INTO handovers (id, session_id, kind, value, created_at) VALUES (?, ?, ?, ?, ?)').run(id, sessionId, kind, value, 't2');

describe('the handovers migration upgrading a database that predates it', () => {
  it('keeps the existing sessions and working states intact and passes the foreign key check', () => {
    const db = openDatabaseUpgradedFromBeforeHandovers();

    const sessions = db.prepare('SELECT id FROM sessions').all();
    const states = db.prepare('SELECT session_id, updated_at FROM session_working_states').all();
    const foreignKeyViolations = db.prepare('PRAGMA foreign_key_check').all();

    expect(sessions).toEqual([{ id: 'lead' }]);
    expect(states).toEqual([{ session_id: 'lead', updated_at: 't1' }]);
    expect(foreignKeyViolations).toEqual([]);
  });

  it('records the handovers migration as applied', () => {
    const db = openDatabaseUpgradedFromBeforeHandovers();

    const versions = (db.prepare('SELECT version FROM schema_migrations').all() as { version: string }[]).map((row) => row.version);

    expect(versions).toContain('015_handovers');
  });

  it('creates a STRICT table of mandatory columns', () => {
    const db = openDatabaseUpgradedFromBeforeHandovers();

    const table = db.prepare("SELECT strict FROM pragma_table_list WHERE name = 'handovers'").get();
    const columns = db.prepare("SELECT name, \"notnull\" AS required FROM pragma_table_info('handovers')").all();

    expect(table).toEqual({ strict: 1 });
    expect(columns).toEqual([
      { name: 'id', required: 1 },
      { name: 'session_id', required: 1 },
      { name: 'kind', required: 1 },
      { name: 'value', required: 1 },
      { name: 'created_at', required: 1 },
    ]);
  });

  it('holds a value once per session, for a known kind, for an existing session', () => {
    const db = openDatabaseUpgradedFromBeforeHandovers();
    insertSession(db, 'other');

    insertHandover(db, { id: 'h1', sessionId: 'lead', kind: 'design_link', value: 'https://claude.ai/design/a' });

    expect(() => insertHandover(db, { id: 'h2', sessionId: 'lead', kind: 'design_link', value: 'https://claude.ai/design/a' })).toThrow(/UNIQUE/);
    expect(() => insertHandover(db, { id: 'h3', sessionId: 'other', kind: 'design_link', value: 'https://claude.ai/design/a' })).not.toThrow();
    expect(() => insertHandover(db, { id: 'h4', sessionId: 'lead', kind: 'image', value: 'x' })).toThrow(/CHECK/);
    expect(() => insertHandover(db, { id: 'h5', sessionId: 'lead', kind: 'doc_path', value: '' })).toThrow(/CHECK/);
    expect(() => insertHandover(db, { id: 'h6', sessionId: 'lead', kind: 'doc_path', value: 'x'.repeat(501) })).toThrow(/CHECK/);
    expect(() => insertHandover(db, { id: 'h7', sessionId: 'ghost', kind: 'doc_path', value: 'specs/x.md' })).toThrow(/FOREIGN KEY/);
  });
});
