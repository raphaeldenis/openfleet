import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { backUpBeforeMigrating } from '../../db/backup.js';
import { openDatabase } from '../../db/database.js';
import { latestShippedMigration } from '../../db/migrate.js';
import { ScapeImportError } from './scapeImportError.js';
import { snapshotSqliteDatabase } from './sqliteSnapshot.js';

const DATABASE_FILE_NAME = 'openfleet.db';

export type UpsertOutcome = 'written' | 'updated' | 'alreadyPresent' | 'conflict';
export type RecordValues = Record<string, string | number | null>;

/** What to do with a stored record that differs from the planned one. */
export type DifferenceDecision = 'overwrite' | 'conflict' | 'ignore';

export interface WritePolicy {
  decideOnDifference(stored: RecordValues): DifferenceDecision;
  /** False when the record must not be created (for instance a row deleted in OpenFleet). */
  canInsert?(): boolean;
}

export const REPORT_DIFFERENCE_AS_CONFLICT: WritePolicy = { decideOnDifference: () => 'conflict' };
export const KEEP_STORED_RECORD: WritePolicy = { decideOnDifference: () => 'ignore' };

export interface TargetDatabase {
  db: DatabaseSync;
  /** Closes the connection and removes what a dry run copied aside. */
  dispose(): void;
}

/**
 * SQLite refuses an exclusive lock on a WAL database while another connection is open on it, so a
 * daemon (or any process) using the database is detected without a lock file or a port.
 */
function assertNoOtherProcessHolds(databasePath: string): void {
  if (!existsSync(databasePath)) return;
  const probe = new DatabaseSync(databasePath);
  try {
    probe.exec('PRAGMA busy_timeout = 0; PRAGMA locking_mode = EXCLUSIVE');
    probe.prepare('SELECT count(*) FROM sqlite_master').get();
    probe.exec('BEGIN IMMEDIATE; ROLLBACK');
  } catch (cause) {
    throw new ScapeImportError({ code: 'DAEMON_RUNNING', message: `another process holds ${databasePath} (is the OpenFleet daemon running?): quit it and run the import again`, cause });
  } finally {
    probe.close();
  }
}

/** Opens (and migrates) the OpenFleet database of a home, refusing while another process uses it. */
export function openWritableTarget(home: string): TargetDatabase {
  const databasePath = join(home, DATABASE_FILE_NAME);
  assertNoOtherProcessHolds(databasePath);
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const db = openDatabase(databasePath);
  return { db, dispose: () => db.close() };
}

/** Backs the committed state of an existing database up from a second connection, while the import transaction is still open on the first. */
export function backUpCommittedState(input: { home: string }): void {
  const databasePath = join(input.home, DATABASE_FILE_NAME);
  const reader = new DatabaseSync(databasePath, { readOnly: true });
  try {
    backUpBeforeMigrating(reader, { home: input.home, schemaVersion: latestShippedMigration() });
  } finally {
    reader.close();
  }
}

/** Opens a throw-away snapshot of the home's database (or a fresh one) so a dry run computes real outcomes without touching the home. */
export function openDryRunTarget(home: string): TargetDatabase {
  const scratchDir = mkdtempSync(join(tmpdir(), 'openfleet-import-dry-run-'));
  const databasePath = join(home, DATABASE_FILE_NAME);
  const scratchPath = join(scratchDir, DATABASE_FILE_NAME);
  if (existsSync(databasePath)) snapshotSqliteDatabase({ sourcePath: databasePath, targetPath: scratchPath });
  const db = openDatabase(scratchPath);
  return { db, dispose: () => { db.close(); rmSync(scratchDir, { recursive: true, force: true }); } };
}

/** Inserts the record, or compares it with the stored one and lets the policy decide what a difference means. */
export function upsertRecord(db: DatabaseSync, input: { table: string; id: string; record: RecordValues; policy: WritePolicy }): UpsertOutcome {
  const columns = Object.keys(input.record);
  const stored = db.prepare(`SELECT ${columns.join(', ')} FROM ${input.table} WHERE id = ?`).get(input.id) as RecordValues | undefined;
  if (stored === undefined) return insertRecord(db, input);

  const changedColumns = columns.filter((column) => stored[column] !== input.record[column]);
  if (changedColumns.length === 0) return 'alreadyPresent';
  const decision = input.policy.decideOnDifference(stored);
  if (decision === 'ignore') return 'alreadyPresent';
  if (decision === 'conflict') return 'conflict';
  const assignments = changedColumns.map((column) => `${column} = ?`).join(', ');
  db.prepare(`UPDATE ${input.table} SET ${assignments} WHERE id = ?`).run(...changedColumns.map((column) => input.record[column]!), input.id);
  return 'updated';
}

function insertRecord(db: DatabaseSync, input: { table: string; id: string; record: RecordValues; policy: WritePolicy }): UpsertOutcome {
  const mayInsert = input.policy.canInsert?.() ?? true;
  if (!mayInsert) return 'conflict';
  const columns = Object.keys(input.record);
  const placeholders = ['?', ...columns.map(() => '?')].join(', ');
  db.prepare(`INSERT INTO ${input.table} (id, ${columns.join(', ')}) VALUES (${placeholders})`).run(input.id, ...Object.values(input.record));
  return 'written';
}
