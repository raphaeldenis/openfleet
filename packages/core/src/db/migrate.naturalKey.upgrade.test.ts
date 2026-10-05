import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { applyMigrations } from './migrate.js';

const migrationsDirectory = new URL('./migrations/', import.meta.url);

const migrationsUpTo020 = readdirSync(migrationsDirectory)
  .filter((fileName) => fileName.endsWith('.sql') && fileName < '021')
  .sort()
  .map((fileName) => ({ version: fileName.replace(/\.sql$/, ''), sql: readFileSync(new URL(fileName, migrationsDirectory), 'utf8') }));

const openDatabaseUpgradedFrom020 = () => {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  applyMigrations(db, migrationsUpTo020);
  db.prepare("INSERT INTO projects (id, name, docs_folder_path, created_at) VALUES ('p1', 'One', NULL, 't0')").run();
  db.prepare("INSERT INTO data_stores (id, project_id, display_name, created_at, updated_at) VALUES ('s1', 'p1', 'backlog', 't0', 't0')").run();
  db.prepare("INSERT INTO ds_columns (id, store_id, display_name, column_type, options_json, sort_order, created_at) VALUES ('c1', 's1', 'id', 'text', NULL, 0, 't0')").run();
  applyMigrations(db);
  return db;
};

describe('the natural key migration upgrading a database at version 020', () => {
  it('keeps every existing store, with no natural key', () => {
    const db = openDatabaseUpgradedFrom020();

    const stores = db.prepare('SELECT id, display_name, natural_key_column_id FROM data_stores').all();

    expect(stores).toEqual([{ id: 's1', display_name: 'backlog', natural_key_column_id: null }]);
    db.close();
  });

  it('accepts a natural key column id and refuses an empty one at the database level', () => {
    const db = openDatabaseUpgradedFrom020();

    const setColumn = () => db.prepare("UPDATE data_stores SET natural_key_column_id = 'c1'").run();
    const setEmpty = () => db.prepare("UPDATE data_stores SET natural_key_column_id = ''").run();

    expect(setColumn).not.toThrow();
    expect(setEmpty).toThrow(/CHECK/);
    db.close();
  });
});
