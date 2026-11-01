import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { applyMigrations } from './migrate.js';

const migrationsDownDirectory = new URL('./migrations-down/', import.meta.url);

const openMigratedDatabase = () => {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  applyMigrations(db);
  return db;
};

const insertActivity = (db: DatabaseSync, overrides: Partial<Record<'actor_kind' | 'source' | 'outcome', string>> = {}) =>
  db.prepare('INSERT INTO activity_log (at, actor_kind, actor_label, source, action, outcome) VALUES (?, ?, ?, ?, ?, ?)')
    .run('2026-11-01T10:00:00.000Z', overrides.actor_kind ?? 'agent', 'Worker', overrides.source ?? 'mcp', 'create_note', overrides.outcome ?? 'ok');

describe('the activity log migration', () => {
  it('creates the table on an empty database and numbers its rows in insertion order', () => {
    const db = openMigratedDatabase();

    insertActivity(db);
    insertActivity(db);

    const ids = db.prepare('SELECT id FROM activity_log ORDER BY id').all();
    expect(ids).toEqual([{ id: 1 }, { id: 2 }]);
  });

  it.each([
    ['actor kind', { actor_kind: 'robot' }],
    ['source', { source: 'carrier-pigeon' }],
    ['outcome', { outcome: 'maybe' }],
    ['outcome the log never emits (gated)', { outcome: 'gated' }],
  ])('refuses a row with an unknown %s', (_name, overrides) => {
    const db = openMigratedDatabase();

    expect(() => insertActivity(db, overrides)).toThrow(/CHECK constraint/);
  });

  it('keeps the rows of a session that no longer exists', () => {
    const db = openMigratedDatabase();
    db.prepare("INSERT INTO activity_log (at, actor_kind, actor_label, session_id, source, action, outcome) VALUES ('t', 'agent', 'Gone', 'no-such-session', 'mcp', 'create_note', 'ok')").run();

    expect(db.prepare('SELECT COUNT(*) AS n FROM activity_log').get()).toEqual({ n: 1 });
  });

  it('ships a down migration outside the migrations folder that removes the table', () => {
    const db = openMigratedDatabase();

    db.exec(readFileSync(new URL('063_activity_log.down.sql', migrationsDownDirectory), 'utf8'));

    expect(db.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'activity_log%'").all()).toEqual([]);
  });
});
