import { DatabaseSync } from 'node:sqlite';
import { applyMigrations } from './migrate.js';

export function openDatabase(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  applyMigrations(db);
  return db;
}
