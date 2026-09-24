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

describe('applyMigrations hostile cases', () => {
  it('rolls back a migration whose first statement fails: no trace, no schema_migrations row', () => {
    const db = openDatabase(':memory:');
    const brokenMigration = [{ version: '999_broken_first', sql: 'NOT VALID SQL AT ALL; CREATE TABLE never_created (id TEXT);' }];

    expect(() => applyMigrations(db, brokenMigration)).toThrow();

    const createdTable = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'never_created'`).all();
    expect(createdTable).toHaveLength(0);

    const recordedVersion = db.prepare('SELECT version FROM schema_migrations WHERE version = ?').get('999_broken_first');
    expect(recordedVersion).toBeUndefined();
  });

  it('commits and records the first of two migrations even when the second fails, and a later corrected run applies only the fixed one', () => {
    const db = openDatabase(':memory:');
    const firstOkSecondBroken = [
      { version: '999a', sql: 'CREATE TABLE a_committed (id TEXT) STRICT;' },
      { version: '999b', sql: 'NOT VALID SQL AT ALL;' },
    ];

    expect(() => applyMigrations(db, firstOkSecondBroken)).toThrow();

    const aTable = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'a_committed'`).all();
    expect(aTable).toHaveLength(1);
    const appliedVersions = (db.prepare('SELECT version FROM schema_migrations WHERE version LIKE ?').all('999%') as { version: string }[]).map((r) => r.version);
    expect(appliedVersions).toEqual(['999a']);

    const bothFixed = [
      { version: '999a', sql: 'CREATE TABLE a_committed (id TEXT) STRICT;' },
      { version: '999b', sql: 'CREATE TABLE b_committed (id TEXT) STRICT;' },
    ];
    expect(() => applyMigrations(db, bothFixed)).not.toThrow();

    const bTable = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'b_committed'`).all();
    expect(bTable).toHaveLength(1);
    const recordedAfterFix = (db.prepare('SELECT version FROM schema_migrations WHERE version LIKE ?').all('999%') as { version: string }[]).map((r) => r.version).sort();
    expect(recordedAfterFix).toEqual(['999a', '999b']);
  });

  it('rejects a migration whose own SQL opens a nested transaction, leaving no trace', () => {
    const db = openDatabase(':memory:');
    const nestedTransactionMigration = [{ version: '999_nested_tx', sql: 'BEGIN; CREATE TABLE nested_tx (id TEXT); COMMIT;' }];

    expect(() => applyMigrations(db, nestedTransactionMigration)).toThrow();

    const nestedTable = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'nested_tx'`).all();
    expect(nestedTable).toHaveLength(0);

    const recordedVersion = db.prepare('SELECT version FROM schema_migrations WHERE version = ?').get('999_nested_tx');
    expect(recordedVersion).toBeUndefined();
  });

  it('skips a duplicate version within the same batch instead of re-attempting its SQL', () => {
    const db = openDatabase(':memory:');
    const duplicateVersionBatch = [
      { version: '999_dup', sql: 'CREATE TABLE dup_a (id TEXT) STRICT;' },
      { version: '999_dup', sql: 'NOT VALID SQL AT ALL;' },
    ];

    expect(() => applyMigrations(db, duplicateVersionBatch)).not.toThrow();

    const dupA = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'dup_a'`).all();
    expect(dupA).toHaveLength(1);

    const recorded = db.prepare('SELECT count(*) AS n FROM schema_migrations WHERE version = ?').get('999_dup');
    expect(recorded).toEqual({ n: 1 });
  });
});
