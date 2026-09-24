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

  it('rejects a migration whose SQL contains a bare COMMIT, leaving no trace', () => {
    const db = openDatabase(':memory:');
    const commitEscapeMigration = [{ version: '999_commit_escape', sql: 'CREATE TABLE probe (id TEXT); COMMIT; INVALID' }];

    expect(() => applyMigrations(db, commitEscapeMigration)).toThrow();

    const probeTable = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'probe'`).all();
    expect(probeTable).toHaveLength(0);

    const recordedVersion = db.prepare('SELECT version FROM schema_migrations WHERE version = ?').get('999_commit_escape');
    expect(recordedVersion).toBeUndefined();
  });

  it('surfaces the original failure instead of a rollback error once the transaction has already ended', () => {
    const db = openDatabase(':memory:');
    const denyRecordingTrigger = [
      {
        version: '999_trigger',
        sql: `CREATE TRIGGER deny_recording BEFORE INSERT ON schema_migrations
              WHEN NEW.version != '999_trigger'
              BEGIN SELECT RAISE(ROLLBACK, 'record denied'); END;`,
      },
    ];
    applyMigrations(db, denyRecordingTrigger);

    const deniedMigration = [{ version: '999_denied', sql: 'CREATE TABLE denied_probe (id TEXT) STRICT;' }];

    expect(() => applyMigrations(db, deniedMigration)).toThrow('record denied');
  });

  it('skips a version already recorded by another process instead of re-executing its SQL', () => {
    const db = openDatabase(':memory:');
    const raceWithAnotherProcess = [
      {
        version: '999_race_a',
        sql: `CREATE TABLE race_a (id TEXT) STRICT;
              INSERT INTO schema_migrations (version, applied_at) VALUES ('999_race_b', 'recorded-by-another-process');`,
      },
      { version: '999_race_b', sql: 'NOT VALID SQL AT ALL;' },
    ];

    expect(() => applyMigrations(db, raceWithAnotherProcess)).not.toThrow();

    const raceA = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'race_a'`).all();
    expect(raceA).toHaveLength(1);

    const recordedB = db.prepare('SELECT applied_at FROM schema_migrations WHERE version = ?').get('999_race_b');
    expect(recordedB).toEqual({ applied_at: 'recorded-by-another-process' });
  });
});
