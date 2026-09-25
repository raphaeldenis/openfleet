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

describe('applyMigrations transaction-control guard', () => {
  it('rejects a migration whose SQL hides a COMMIT inside a block comment', () => {
    const db = openDatabase(':memory:');
    const blockCommentEscape = [{ version: '999_block_comment_escape', sql: 'CREATE TABLE block_comment_probe (id TEXT); /* sneaky */ COMMIT; INVALID' }];

    expect(() => applyMigrations(db, blockCommentEscape)).toThrow();

    const probeTable = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'block_comment_probe'`).all();
    expect(probeTable).toHaveLength(0);
    expect(db.prepare('SELECT version FROM schema_migrations WHERE version = ?').get('999_block_comment_escape')).toBeUndefined();
  });

  it('rejects a migration whose SQL hides a COMMIT inside a line comment ending in CRLF', () => {
    const db = openDatabase(':memory:');
    const lineCommentEscape = [{ version: '999_line_comment_escape', sql: 'CREATE TABLE line_comment_probe (id TEXT); -- sneaky\r\nCOMMIT; INVALID' }];

    expect(() => applyMigrations(db, lineCommentEscape)).toThrow();

    const probeTable = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'line_comment_probe'`).all();
    expect(probeTable).toHaveLength(0);
    expect(db.prepare('SELECT version FROM schema_migrations WHERE version = ?').get('999_line_comment_escape')).toBeUndefined();
  });

  it('rejects a COMMIT-then-BEGIN sequence that would otherwise fool the isTransaction belt', () => {
    const db = openDatabase(':memory:');
    const commitThenReopen = [{ version: '999_commit_reopen', sql: "CREATE TABLE reopen_probe (id TEXT) STRICT; COMMIT; BEGIN; SELECT 'END';" }];

    expect(() => applyMigrations(db, commitThenReopen)).toThrow();

    const probeTable = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'reopen_probe'`).all();
    expect(probeTable).toHaveLength(0);
    expect(db.prepare('SELECT version FROM schema_migrations WHERE version = ?').get('999_commit_reopen')).toBeUndefined();
  });

  it('accepts a migration that merely selects a string literal containing a semicolon and the word COMMIT', () => {
    const db = openDatabase(':memory:');
    const semicolonInsideString = [{ version: '999_semicolon_literal', sql: "SELECT ';COMMIT';" }];

    expect(() => applyMigrations(db, semicolonInsideString)).not.toThrow();

    expect(db.prepare('SELECT count(*) AS n FROM schema_migrations WHERE version = ?').get('999_semicolon_literal')).toEqual({ n: 1 });
  });

  it("accepts a trigger whose body selects the string literal 'END'", () => {
    const db = openDatabase(':memory:');
    const triggerWithEndLiteral = [
      {
        version: '999_trigger_end_literal',
        sql: `CREATE TRIGGER logs_something AFTER INSERT ON schema_migrations
              BEGIN SELECT 'END'; END;`,
      },
    ];

    expect(() => applyMigrations(db, triggerWithEndLiteral)).not.toThrow();

    expect(db.prepare('SELECT count(*) AS n FROM schema_migrations WHERE version = ?').get('999_trigger_end_literal')).toEqual({ n: 1 });
  });

  it('rejects a migration whose SQL contains END TRANSACTION', () => {
    const db = openDatabase(':memory:');
    const endTransaction = [{ version: '999_end_transaction', sql: 'CREATE TABLE end_txn_probe (id TEXT); END TRANSACTION; INVALID' }];

    expect(() => applyMigrations(db, endTransaction)).toThrow();

    const probeTable = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'end_txn_probe'`).all();
    expect(probeTable).toHaveLength(0);
  });

  it('rejects a migration whose SQL contains a lowercase commit', () => {
    const db = openDatabase(':memory:');
    const lowercaseCommit = [{ version: '999_lowercase_commit', sql: 'create table lowercase_probe (id text); commit; invalid' }];

    expect(() => applyMigrations(db, lowercaseCommit)).toThrow();

    const probeTable = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'lowercase_probe'`).all();
    expect(probeTable).toHaveLength(0);
  });

  it('rejects a COMMIT statement preceded by leading newlines', () => {
    const db = openDatabase(':memory:');
    const leadingNewlines = [{ version: '999_leading_newlines', sql: 'CREATE TABLE newline_probe (id TEXT);\n\n  COMMIT;\nINVALID' }];

    expect(() => applyMigrations(db, leadingNewlines)).toThrow();

    const probeTable = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'newline_probe'`).all();
    expect(probeTable).toHaveLength(0);
  });

  it('accepts table and column names that start with a transaction-control word', () => {
    const db = openDatabase(':memory:');
    const keywordLikeIdentifiers = [
      { version: '999_release_notes', sql: 'CREATE TABLE release_notes (id TEXT) STRICT;' },
      { version: '999_commit_sha', sql: 'ALTER TABLE release_notes ADD COLUMN commit_sha TEXT;' },
    ];

    expect(() => applyMigrations(db, keywordLikeIdentifiers)).not.toThrow();

    const recorded = (db.prepare('SELECT version FROM schema_migrations WHERE version LIKE ?').all('999_%') as { version: string }[]).map((r) => r.version).sort();
    expect(recorded).toEqual(['999_commit_sha', '999_release_notes']);
  });

  it('rejects a bare ROLLBACK statement', () => {
    const db = openDatabase(':memory:');
    const bareRollback = [{ version: '999_bare_rollback', sql: 'CREATE TABLE rollback_probe (id TEXT); ROLLBACK; INVALID' }];

    expect(() => applyMigrations(db, bareRollback)).toThrow();

    const probeTable = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'rollback_probe'`).all();
    expect(probeTable).toHaveLength(0);
  });

  it('rejects a bare SAVEPOINT statement', () => {
    const db = openDatabase(':memory:');
    const bareSavepoint = [{ version: '999_bare_savepoint', sql: 'CREATE TABLE savepoint_probe (id TEXT); SAVEPOINT sp1; INVALID' }];

    expect(() => applyMigrations(db, bareSavepoint)).toThrow();

    const probeTable = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'savepoint_probe'`).all();
    expect(probeTable).toHaveLength(0);
  });

  it('rejects a bare RELEASE statement', () => {
    const db = openDatabase(':memory:');
    const bareRelease = [{ version: '999_bare_release', sql: 'CREATE TABLE release_probe (id TEXT); RELEASE sp1; INVALID' }];

    expect(() => applyMigrations(db, bareRelease)).toThrow();

    const probeTable = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'release_probe'`).all();
    expect(probeTable).toHaveLength(0);
  });

  it('rejects a bare END statement', () => {
    const db = openDatabase(':memory:');
    const bareEnd = [{ version: '999_bare_end', sql: 'CREATE TABLE end_probe (id TEXT); END; INVALID' }];

    expect(() => applyMigrations(db, bareEnd)).toThrow();

    const probeTable = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'end_probe'`).all();
    expect(probeTable).toHaveLength(0);
  });
});
