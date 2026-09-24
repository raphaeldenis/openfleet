import { describe, expect, it } from 'vitest';
import { openDatabase } from './database.js';
import { applyMigrations } from './migrate.js';

describe('openDatabase', () => {
  it('creates the schema and records applied migrations', () => {
    const db = openDatabase(':memory:');
    const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`).all() as { name: string }[];
    expect(tables.map((t) => t.name)).toEqual(expect.arrayContaining(['sessions', 'message_queue', 'approvals', 'schema_migrations']));
    const applied = db.prepare('SELECT version FROM schema_migrations').all();
    expect(applied).toHaveLength(2);
  });

  it('does not re-apply an already-applied migration to the same connection', () => {
    const db = openDatabase(':memory:');

    expect(() => applyMigrations(db)).not.toThrow();

    expect(db.prepare('SELECT count(*) AS n FROM schema_migrations').get()).toEqual({ n: 2 });
  });

  it('sets a busy_timeout so a second writer waits instead of failing immediately', () => {
    const db = openDatabase(':memory:');

    expect(db.prepare('PRAGMA busy_timeout').get()).toEqual({ timeout: 5000 });
  });
});
