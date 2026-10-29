import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { UsageLedgerService } from '../usage/usageLedgerService.js';
import { applyMigrations } from './migrate.js';

const migrationsDirectory = new URL('./migrations/', import.meta.url);
const usageDailyMigrationFileName = '046_usage_daily.sql';
const usageDailyDownScript = readFileSync(new URL('./migrations-down/046_usage_daily.down.sql', import.meta.url), 'utf8');

const migrationsBeforeUsageDaily = readdirSync(migrationsDirectory)
  .filter((fileName) => fileName.endsWith('.sql') && fileName < usageDailyMigrationFileName)
  .sort()
  .map((fileName) => ({ version: fileName.replace(/\.sql$/, ''), sql: readFileSync(new URL(fileName, migrationsDirectory), 'utf8') }));

const tableNames = (db: DatabaseSync) => (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((row) => row.name);

describe('the usage_daily migration', () => {
  it('adds its two tables to a database that predates it, empty', () => {
    const db = new DatabaseSync(':memory:');
    applyMigrations(db, migrationsBeforeUsageDaily);

    applyMigrations(db);

    expect(db.prepare('SELECT COUNT(*) AS n FROM usage_daily').get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM usage_messages').get()).toEqual({ n: 0 });
  });

  it('refuses a biller or a cost status the ledger does not know', () => {
    const db = new DatabaseSync(':memory:');
    applyMigrations(db);
    const insertMessage = (biller: string, costStatus: string) =>
      db.prepare("INSERT INTO usage_messages VALUES ('s', 'm', '2026-10-01', 'x', 'root', ?, 1, 1, 1, 1, NULL, ?)").run(biller, costStatus);

    expect(() => insertMessage('free', 'unpriced')).toThrow();
    expect(() => insertMessage('api', 'guessed')).toThrow();
  });

  it('is undone by its down script, which removes the two tables and nothing else', () => {
    const db = new DatabaseSync(':memory:');
    applyMigrations(db);
    const tablesBefore = tableNames(db);
    new UsageLedgerService(db);

    db.exec(usageDailyDownScript);

    expect(tablesBefore.filter((name) => !tableNames(db).includes(name)).sort()).toEqual(['usage_daily', 'usage_messages']);
  });
});
