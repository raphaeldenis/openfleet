import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { applyMigrations } from './migrate.js';

const migrationsDirectory = new URL('./migrations/', import.meta.url);
const readMigrations = () =>
  readdirSync(migrationsDirectory)
    .filter((fileName) => fileName.endsWith('.sql'))
    .sort()
    .map((fileName) => ({ version: fileName.replace(/\.sql$/, ''), sql: readFileSync(new URL(fileName, migrationsDirectory), 'utf8') }));
const migrationsBeforePromptedIndex = () => readMigrations().filter(({ version }) => version < '016');

const insertSession = (db: DatabaseSync, id: string) =>
  db.prepare(`INSERT INTO sessions (id, name, emoji, directory, harness, state, state_since, hook_token, mcp_token, parent_id, created_at)
    VALUES (?, ?, '🤖', '/tmp', 'fake', 'idle', 't0', ?, ?, NULL, 't0')`).run(id, id, `hook-${id}`, `mcp-${id}`);

describe('QE: the prompted column and session_events index migration on a large, re-run or foreign database', () => {
  it('upgrades a database holding 10 000 sessions and 10 000 events without losing a row and gives each prompted = 0', () => {
    const db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys = ON;');
    applyMigrations(db, migrationsBeforePromptedIndex());
    db.exec('BEGIN');
    for (let index = 0; index < 10_000; index += 1) {
      insertSession(db, `s${index}`);
      db.prepare("INSERT INTO session_events (session_id, kind, ts) VALUES (?, 'reopened', 't1')").run(`s${index}`);
    }
    db.exec('COMMIT');

    applyMigrations(db);

    const counts = db.prepare('SELECT (SELECT COUNT(*) FROM sessions) AS sessions, (SELECT COUNT(*) FROM session_events) AS events, (SELECT COUNT(*) FROM sessions WHERE prompted = 0) AS unprompted').get();
    expect(counts).toEqual({ sessions: 10_000, events: 10_000, unprompted: 10_000 });
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });

  it('applies twice without error and without a second column or index', () => {
    const db = new DatabaseSync(':memory:');
    applyMigrations(db);

    applyMigrations(db);

    const promptedColumns = db.prepare("SELECT name FROM pragma_table_info('sessions') WHERE name = 'prompted'").all();
    const indexes = db.prepare("SELECT name FROM pragma_index_list('session_events') WHERE name = 'session_events_by_session_kind_ts'").all();
    expect(promptedColumns).toHaveLength(1);
    expect(indexes).toHaveLength(1);
  });

  it('refuses a database that already holds a prompted column but no record of 016, and leaves it unrecorded (rolled back)', () => {
    const db = new DatabaseSync(':memory:');
    applyMigrations(db, migrationsBeforePromptedIndex());
    db.exec('ALTER TABLE sessions ADD COLUMN prompted INTEGER NOT NULL DEFAULT 0');

    expect(() => applyMigrations(db)).toThrow(/duplicate column name: prompted/);

    const versions = (db.prepare('SELECT version FROM schema_migrations').all() as { version: string }[]).map((row) => row.version);
    expect(versions).not.toContain('016_session_prompted_events_index');
    expect(db.isTransaction).toBe(false);
  });

  it('makes a code that predates 016 refuse to start on the upgraded database instead of running on it', () => {
    const db = new DatabaseSync(':memory:');
    applyMigrations(db);
    db.prepare("INSERT INTO schema_migrations (version, applied_at, checksum) VALUES ('017_from_a_newer_branch', 't', 'x')").run();

    expect(() => applyMigrations(db)).toThrow(/refusing to start on a schema newer than the code/);
  });

  it('lets an insert that ignores the prompted column (an older writer) still succeed with prompted = 0', () => {
    const db = new DatabaseSync(':memory:');
    applyMigrations(db);

    insertSession(db, 'legacy-writer');

    expect(db.prepare("SELECT prompted FROM sessions WHERE id = 'legacy-writer'").get()).toEqual({ prompted: 0 });
  });
});
