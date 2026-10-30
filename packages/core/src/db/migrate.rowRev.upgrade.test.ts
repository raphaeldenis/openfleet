import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { applyMigrations } from './migrate.js';

const migrationsDirectory = new URL('./migrations/', import.meta.url);
const rowRevDownMigration = new URL('./migrations-down/055_ds_row_rev.down.sql', import.meta.url);

const migrationsUpTo = (lastFileName: string) =>
  readdirSync(migrationsDirectory)
    .filter((fileName) => fileName.endsWith('.sql') && fileName <= lastFileName)
    .sort()
    .map((fileName) => ({ version: fileName.replace(/\.sql$/, ''), sql: readFileSync(new URL(fileName, migrationsDirectory), 'utf8') }));

const databaseUpTo = (lastFileName: string): DatabaseSync => {
  const db = new DatabaseSync(':memory:');
  applyMigrations(db, migrationsUpTo(lastFileName));
  return db;
};

const columnNamesOfRows = (db: DatabaseSync): string[] =>
  (db.prepare('PRAGMA table_info(ds_rows)').all() as { name: string }[]).map(({ name }) => name);

describe('migration 055, the row revision', () => {
  it('gives every existing row revision 1', () => {
    const db = databaseUpTo('054_project_shared_repo.sql');
    db.exec("INSERT INTO projects (id, name, created_at) VALUES ('p1', 'Fleet', '2026-10-29T10:00:00.000Z')");
    db.exec("INSERT INTO data_stores (id, project_id, display_name, created_at, updated_at) VALUES ('s1', 'p1', 'Backlog', 't0', 't0')");
    db.exec("INSERT INTO ds_rows (id, store_id, data_json, created_at, updated_at) VALUES ('r1', 's1', '{}', 't0', 't0')");
    applyMigrations(db, migrationsUpTo('055_ds_row_rev.sql'));

    const row = db.prepare("SELECT rev FROM ds_rows WHERE id = 'r1'").get() as { rev: number };

    expect(row.rev).toBe(1);
  });

  it('is undone by its down migration, which drops only rev', () => {
    const databaseBefore055 = databaseUpTo('054_project_shared_repo.sql');
    const databaseAfter055 = databaseUpTo('055_ds_row_rev.sql');

    databaseAfter055.exec(readFileSync(rowRevDownMigration, 'utf8'));

    expect(columnNamesOfRows(databaseAfter055)).toEqual(columnNamesOfRows(databaseBefore055));
  });
});
