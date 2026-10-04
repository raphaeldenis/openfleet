import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { backUpBeforeMigrating } from '../../db/backup.js';
import { openDatabase } from '../../db/database.js';
import { latestShippedMigration } from '../../db/migrate.js';

const DATABASE_FILE_NAME = 'openfleet.db';

export type UpsertOutcome = 'written' | 'updated' | 'alreadyPresent';
export type RecordValues = Record<string, string | number | null>;

export interface TargetDatabase {
  db: DatabaseSync;
  /** Closes the connection and removes what a dry run copied aside. */
  dispose(): void;
}

/** Opens (and migrates) the OpenFleet database of a home, backing an existing one up first. */
export function openWritableTarget(home: string): TargetDatabase {
  const databasePath = join(home, DATABASE_FILE_NAME);
  const alreadyExisted = existsSync(databasePath);
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const db = openDatabase(databasePath);
  if (alreadyExisted) backUpBeforeMigrating(db, { home, schemaVersion: latestShippedMigration() });
  return { db, dispose: () => db.close() };
}

/** Opens a throw-away copy of the home's database (or a fresh one) so a dry run computes real outcomes without touching the home. */
export function openDryRunTarget(home: string): TargetDatabase {
  const scratchDir = mkdtempSync(join(tmpdir(), 'openfleet-import-dry-run-'));
  const databasePath = join(home, DATABASE_FILE_NAME);
  for (const suffix of ['', '-wal']) {
    if (existsSync(`${databasePath}${suffix}`)) copyFileSync(`${databasePath}${suffix}`, join(scratchDir, `${DATABASE_FILE_NAME}${suffix}`));
  }
  const db = openDatabase(join(scratchDir, DATABASE_FILE_NAME));
  return { db, dispose: () => { db.close(); rmSync(scratchDir, { recursive: true, force: true }); } };
}

/** Inserts the record, updates it when a stored column differs, or leaves it alone when identical. */
export function upsertRecord(db: DatabaseSync, input: { table: string; id: string; record: RecordValues }): UpsertOutcome {
  const columns = Object.keys(input.record);
  const stored = db.prepare(`SELECT ${columns.join(', ')} FROM ${input.table} WHERE id = ?`).get(input.id) as RecordValues | undefined;
  if (stored === undefined) {
    const placeholders = ['?', ...columns.map(() => '?')].join(', ');
    db.prepare(`INSERT INTO ${input.table} (id, ${columns.join(', ')}) VALUES (${placeholders})`).run(input.id, ...Object.values(input.record));
    return 'written';
  }
  const changedColumns = columns.filter((column) => stored[column] !== input.record[column]);
  if (changedColumns.length === 0) return 'alreadyPresent';
  const assignments = changedColumns.map((column) => `${column} = ?`).join(', ');
  db.prepare(`UPDATE ${input.table} SET ${assignments} WHERE id = ?`).run(...changedColumns.map((column) => input.record[column]!), input.id);
  return 'updated';
}

/** For immutable records (versions, history): an existing id is never rewritten. */
export function insertRecordIfAbsent(db: DatabaseSync, input: { table: string; id: string; record: RecordValues }): UpsertOutcome {
  const isPresent = db.prepare(`SELECT 1 FROM ${input.table} WHERE id = ?`).get(input.id) !== undefined;
  if (isPresent) return 'alreadyPresent';
  return upsertRecord(db, input);
}
