import { describe, expect, it } from 'vitest';
import { openDatabase } from './database.js';
import { applyMigrations } from './migrate.js';

describe('applyMigrations atomicity', () => {
  it('rolls back a migration whose second statement fails: no trace of the first statement, no schema_migrations row', () => {
    const db = openDatabase(':memory:');
    const brokenMigration = [{ version: '999_broken', sql: 'CREATE TABLE atomic_test (id TEXT); NOT VALID SQL AT ALL;' }];

    expect(() => applyMigrations(db, brokenMigration)).toThrow();

    const createdTable = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'atomic_test'`).all();
    expect(createdTable).toHaveLength(0);

    const recordedVersion = db.prepare('SELECT version FROM schema_migrations WHERE version = ?').get('999_broken');
    expect(recordedVersion).toBeUndefined();
  });

  it('records a successful migration exactly once; re-applying it is a no-op', () => {
    const db = openDatabase(':memory:');
    const okMigration = [{ version: '999_ok', sql: 'CREATE TABLE ok_test (id TEXT) STRICT;' }];

    applyMigrations(db, okMigration);
    applyMigrations(db, okMigration);

    const recorded = db.prepare('SELECT count(*) AS n FROM schema_migrations WHERE version = ?').get('999_ok');
    expect(recorded).toEqual({ n: 1 });
  });
});
