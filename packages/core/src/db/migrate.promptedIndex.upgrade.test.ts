import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { applyMigrations } from './migrate.js';

const migrationsDirectory = new URL('./migrations/', import.meta.url);

const migrationsBeforePromptedIndex = readdirSync(migrationsDirectory)
  .filter((fileName) => fileName.endsWith('.sql') && fileName < '016')
  .sort()
  .map((fileName) => ({ version: fileName.replace(/\.sql$/, ''), sql: readFileSync(new URL(fileName, migrationsDirectory), 'utf8') }));

const insertSession = (db: DatabaseSync, { id, parentId }: { id: string; parentId: string | null }) =>
  db.prepare(`INSERT INTO sessions (id, name, emoji, directory, harness, state, state_since, hook_token, mcp_token, parent_id, created_at)
    VALUES (?, ?, '🤖', '/tmp', 'fake', 'idle', 't0', ?, ?, ?, 't0')`).run(id, id, `hook-${id}`, `mcp-${id}`, parentId);

const openDatabaseUpgradedFromBeforePromptedIndex = () => {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  applyMigrations(db, migrationsBeforePromptedIndex);
  insertSession(db, { id: 'lead', parentId: null });
  insertSession(db, { id: 'worker', parentId: 'lead' });
  db.prepare("INSERT INTO session_events (session_id, kind, ts) VALUES ('worker', 'reopened', 't1')").run();
  applyMigrations(db);
  return db;
};

describe('the prompted column and session_events index migration upgrading a database that predates it', () => {
  it('keeps the existing sessions and events intact and passes the foreign key check', () => {
    const db = openDatabaseUpgradedFromBeforePromptedIndex();

    const sessions = db.prepare('SELECT id FROM sessions ORDER BY id').all();
    const events = db.prepare('SELECT session_id, kind, ts FROM session_events').all();
    const foreignKeyViolations = db.prepare('PRAGMA foreign_key_check').all();

    expect(sessions).toEqual([{ id: 'lead' }, { id: 'worker' }]);
    expect(events).toEqual([{ session_id: 'worker', kind: 'reopened', ts: 't1' }]);
    expect(foreignKeyViolations).toEqual([]);
  });

  it('records the migration as applied', () => {
    const db = openDatabaseUpgradedFromBeforePromptedIndex();

    const versions = (db.prepare('SELECT version FROM schema_migrations').all() as { version: string }[]).map((row) => row.version);

    expect(versions).toContain('016_session_prompted_events_index');
  });

  it('gives every existing session prompted = 0 (a legacy prompted session reopens silently fresh until its next prompt) and a mandatory column', () => {
    const db = openDatabaseUpgradedFromBeforePromptedIndex();

    const promptedValues = db.prepare('SELECT id, prompted FROM sessions ORDER BY id').all();
    const column = db.prepare("SELECT \"notnull\" AS required FROM pragma_table_info('sessions') WHERE name = 'prompted'").get();

    expect(promptedValues).toEqual([{ id: 'lead', prompted: 0 }, { id: 'worker', prompted: 0 }]);
    expect(column).toEqual({ required: 1 });
  });

  it('indexes session_events on (session_id, kind, ts)', () => {
    const db = openDatabaseUpgradedFromBeforePromptedIndex();

    const indexedColumns = db.prepare(`SELECT index_info.name FROM pragma_index_list('session_events') AS indexes
      JOIN pragma_index_info(indexes.name) AS index_info WHERE indexes.origin = 'c' ORDER BY index_info.seqno`).all();

    expect(indexedColumns).toEqual([{ name: 'session_id' }, { name: 'kind' }, { name: 'ts' }]);
  });

  it('answers the reopened-children query of fleetChanges from that index instead of scanning session_events', () => {
    const db = openDatabaseUpgradedFromBeforePromptedIndex();

    const plan = db.prepare(`EXPLAIN QUERY PLAN SELECT sessions.name, 'reopened' AS kind, session_events.ts AS changedAt FROM session_events
      JOIN sessions ON sessions.id = session_events.session_id
      WHERE sessions.parent_id = ? AND session_events.kind = 'reopened'`).all('lead') as { detail: string }[];

    const details = plan.map((step) => step.detail);
    const searchesByLeadingSessionIdThenKind = /SEARCH session_events USING .*INDEX session_events_by_session_kind_ts \(session_id=\? AND kind=\?\)/;
    expect(details.some((detail) => searchesByLeadingSessionIdThenKind.test(detail))).toBe(true);
    expect(details.some((detail) => /SCAN session_events/.test(detail))).toBe(false);
  });
});
