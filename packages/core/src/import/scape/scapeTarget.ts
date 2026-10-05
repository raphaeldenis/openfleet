import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { backUpBeforeMigrating } from '../../db/backup.js';
import { openDatabase } from '../../db/database.js';
import { latestShippedMigration } from '../../db/migrate.js';
import { inTransaction } from '../../db/transaction.js';
import type { RecordOutcome } from './importReport.js';
import { ScapeImportError } from './scapeImportError.js';
import { hashOfValues, withoutColumns, withoutColumnsHoldingNull, type ImportLedger, type LedgerKind } from './scapeLedger.js';
import { snapshotSqliteDatabase } from './sqliteSnapshot.js';

const DATABASE_FILE_NAME = 'openfleet.db';

export type UpsertOutcome = RecordOutcome;
export type RecordValues = Record<string, string | number | null>;

/** A record counts as left alone when the import neither wrote nor changed it. */
export const isLeftAlone = (outcome: UpsertOutcome | undefined): boolean => outcome === 'conflict' || outcome === 'deletedInOpenFleet';

export interface WritePolicy {
  /** False when the record must not be created (a row of a store OpenFleet holds under another name, for instance). */
  canInsert?(): boolean;
  /** False when the record must not be changed although OpenFleet has not touched its own columns (a note with a version from someone else, for instance). */
  canUpdate?(): boolean;
  /** Columns OpenFleet maintains itself: they take no part in telling an OpenFleet edit from none. */
  ignoredColumns?: readonly string[];
  /** Columns added after records were first imported: left out of the hash while null, so those records still match what the ledger holds. */
  columnsOmittedFromHashWhenNull?: readonly string[];
}

/** Reads, creates and changes one stored record; `insert` throws the database error of a taken name. */
export interface RecordGateway {
  readStored(): RecordValues | undefined;
  insert(): void;
  update(input: { stored: RecordValues }): void;
}

export interface TargetDatabase {
  db: DatabaseSync;
  /** Closes the connection and removes what a dry run copied aside. */
  dispose(): void;
}

/**
 * SQLite refuses an exclusive lock on a WAL database while another connection is open on it, so a
 * daemon (or any process) using the database is detected without a lock file or a port.
 */
const isLockedDatabaseError = (error: unknown) => /database (table )?is locked|busy/i.test((error as Error).message);

function assertNoOtherProcessHolds(databasePath: string): void {
  if (!existsSync(databasePath)) return;
  const probe = new DatabaseSync(databasePath);
  try {
    probe.exec('PRAGMA busy_timeout = 0; PRAGMA locking_mode = EXCLUSIVE');
    probe.prepare('SELECT count(*) FROM sqlite_master').get();
    probe.exec('BEGIN IMMEDIATE; ROLLBACK');
  } catch (cause) {
    if (!isLockedDatabaseError(cause)) throw cause;
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
export function openDryRunTarget(input: { home: string; scratchRoot: string }): TargetDatabase {
  const scratchDir = mkdtempSync(join(input.scratchRoot, 'openfleet-import-dry-run-'));
  const databasePath = join(input.home, DATABASE_FILE_NAME);
  const scratchPath = join(scratchDir, DATABASE_FILE_NAME);
  try {
    if (existsSync(databasePath)) snapshotSqliteDatabase({ sourcePath: databasePath, targetPath: scratchPath });
    const db = openDatabase(scratchPath);
    return { db, dispose: () => { db.close(); rmSync(scratchDir, { recursive: true, force: true }); } };
  } catch (error) {
    rmSync(scratchDir, { recursive: true, force: true });
    throw error;
  }
}

export interface ReconcileInput {
  ledger: ImportLedger;
  kind: LedgerKind;
  id: string;
  planned: RecordValues;
  policy: WritePolicy;
  gateway: RecordGateway;
}

/**
 * The 3-way compare of a re-import: the stored record against the planned one and against what the last import wrote (the ledger).
 * A stored record equal to the last import is untouched in OpenFleet, so a Scape change is applied; any other difference is an OpenFleet edit.
 */
export function reconcileRecord(input: ReconcileInput): UpsertOutcome {
  const { ledger, kind, id, policy, gateway } = input;
  const ignoredColumns = policy.ignoredColumns ?? [];
  const columnsOmittedWhenNull = policy.columnsOmittedFromHashWhenNull ?? [];
  const hashOfRecord = (record: RecordValues) => hashOfValues(withoutColumnsHoldingNull(withoutColumns(record, ignoredColumns), columnsOmittedWhenNull));
  const plannedHash = hashOfRecord(input.planned);
  const lastImportedHash = ledger.hashOf(kind, id);

  const stored = gateway.readStored();
  if (stored === undefined) {
    const isDeletedInOpenFleet = lastImportedHash !== undefined;
    if (isDeletedInOpenFleet) return 'deletedInOpenFleet';
    return insertRecord({ ...input, plannedHash });
  }

  const storedHash = hashOfRecord(stored);
  if (storedHash === plannedHash) {
    ledger.remember({ kind, id, hash: plannedHash });
    return 'alreadyPresent';
  }
  const isUntouchedInOpenFleet = storedHash === lastImportedHash;
  const mayUpdate = isUntouchedInOpenFleet && (policy.canUpdate?.() ?? true);
  if (!mayUpdate) return 'conflict';
  gateway.update({ stored });
  ledger.remember({ kind, id, hash: plannedHash });
  return 'updated';
}

function insertRecord(input: ReconcileInput & { plannedHash: string }): UpsertOutcome {
  const mayInsert = input.policy.canInsert?.() ?? true;
  if (!mayInsert) return 'conflict';
  try {
    input.gateway.insert();
  } catch (error) {
    const isNameTakenInOpenFleet = /UNIQUE constraint failed/i.test((error as Error).message);
    if (isNameTakenInOpenFleet) return 'conflict';
    throw error;
  }
  input.ledger.remember({ kind: input.kind, id: input.id, hash: input.plannedHash });
  return 'written';
}

export interface UpsertInput { table: string; kind: LedgerKind; id: string; record: RecordValues; policy?: WritePolicy; ledger: ImportLedger }

/** Reconciles one record of a table of the target. */
export function upsertRecord(db: DatabaseSync, input: UpsertInput): UpsertOutcome {
  const columns = Object.keys(input.record);
  const gateway: RecordGateway = {
    readStored: () => db.prepare(`SELECT ${columns.join(', ')} FROM ${input.table} WHERE id = ?`).get(input.id) as RecordValues | undefined,
    insert: () => {
      const placeholders = ['?', ...columns.map(() => '?')].join(', ');
      inTransaction(db, 'importScapeInsert', () => db.prepare(`INSERT INTO ${input.table} (id, ${columns.join(', ')}) VALUES (${placeholders})`).run(input.id, ...Object.values(input.record)));
    },
    update: ({ stored }) => {
      const changedColumns = columns.filter((column) => stored[column] !== input.record[column]);
      const assignments = changedColumns.map((column) => `${column} = ?`).join(', ');
      db.prepare(`UPDATE ${input.table} SET ${assignments} WHERE id = ?`).run(...changedColumns.map((column) => input.record[column]!), input.id);
    },
  };
  return reconcileRecord({ ledger: input.ledger, kind: input.kind, id: input.id, planned: input.record, policy: input.policy ?? {}, gateway });
}
