import { chmodSync, existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { applyMigrations } from './migrate.js';

export function openDatabase(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA recursive_triggers = ON;');
  applyMigrations(db);
  // The db holds session tokens and message bodies in clear text (MAJ-02); WAL mode already created the
  // -wal/-shm side files by now, so tighten all three every time a real (non-:memory:) path is opened.
  for (const file of [path, `${path}-wal`, `${path}-shm`]) if (existsSync(file)) chmodSync(file, 0o600);
  return db;
}
