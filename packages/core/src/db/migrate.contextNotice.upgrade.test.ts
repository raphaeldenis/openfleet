import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { applyMigrations } from './migrate.js';

const migrationsDirectory = new URL('./migrations/', import.meta.url);

const migrationsBeforeContextNotice = readdirSync(migrationsDirectory)
  .filter((fileName) => fileName.endsWith('.sql') && fileName < '017')
  .sort()
  .map((fileName) => ({ version: fileName.replace(/\.sql$/, ''), sql: readFileSync(new URL(fileName, migrationsDirectory), 'utf8') }));

const insertSession = (db: DatabaseSync, id: string) =>
  db.prepare(`INSERT INTO sessions (id, name, emoji, directory, harness, state, state_since, hook_token, mcp_token, created_at)
    VALUES (?, ?, '🤖', '/tmp', 'fake', 'idle', 't0', ?, ?, 't0')`).run(id, id, `hook-${id}`, `mcp-${id}`);

const openDatabaseUpgradedFromBeforeContextNotice = () => {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  applyMigrations(db, migrationsBeforeContextNotice);
  insertSession(db, 'lead');
  insertSession(db, 'worker');
  db.prepare("INSERT INTO session_events (session_id, kind, ts) VALUES ('worker', 'reopened', 't1')").run();
  applyMigrations(db);
  return db;
};

describe('the context notice column migration upgrading a database that predates it', () => {
  it('keeps the existing sessions and events intact and passes the foreign key check', () => {
    const db = openDatabaseUpgradedFromBeforeContextNotice();

    const sessions = db.prepare('SELECT id FROM sessions ORDER BY id').all();
    const events = db.prepare('SELECT session_id, kind, ts FROM session_events').all();
    const foreignKeyViolations = db.prepare('PRAGMA foreign_key_check').all();

    expect(sessions).toEqual([{ id: 'lead' }, { id: 'worker' }]);
    expect(events).toEqual([{ session_id: 'worker', kind: 'reopened', ts: 't1' }]);
    expect(foreignKeyViolations).toEqual([]);
  });

  it('records the migration as applied', () => {
    const db = openDatabaseUpgradedFromBeforeContextNotice();

    const versions = (db.prepare('SELECT version FROM schema_migrations').all() as { version: string }[]).map((row) => row.version);

    expect(versions).toContain('017_session_context_notice');
  });

  it('gives every existing session a null context notice, so no notice is raised until the next Stop measures it', () => {
    const db = openDatabaseUpgradedFromBeforeContextNotice();

    const notices = db.prepare('SELECT id, context_notice_tokens FROM sessions ORDER BY id').all();

    expect(notices).toEqual([{ id: 'lead', context_notice_tokens: null }, { id: 'worker', context_notice_tokens: null }]);
  });

  it('keeps the column optional', () => {
    const db = openDatabaseUpgradedFromBeforeContextNotice();

    const column = db.prepare("SELECT \"notnull\" AS required FROM pragma_table_info('sessions') WHERE name = 'context_notice_tokens'").get();

    expect(column).toEqual({ required: 0 });
  });
});
