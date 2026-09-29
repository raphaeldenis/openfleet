import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { applyMigrations } from './migrate.js';

const migrationsDirectory = new URL('./migrations/', import.meta.url);

const migrationsUpTo009 = readdirSync(migrationsDirectory)
  .filter((fileName) => fileName.endsWith('.sql') && fileName < '010')
  .sort()
  .map((fileName) => ({ version: fileName.replace(/\.sql$/, ''), sql: readFileSync(new URL(fileName, migrationsDirectory), 'utf8') }));

const openDatabaseUpgradedFrom009 = () => {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  applyMigrations(db, migrationsUpTo009);
  db.prepare("INSERT INTO projects (id, name, docs_folder_path, created_at) VALUES ('p1', 'One', NULL, 't0')").run();
  db.prepare("INSERT INTO data_stores (id, project_id, display_name, created_at, updated_at) VALUES ('s1', 'p1', 'backlog', 't0', 't0')").run();
  db.prepare("INSERT INTO ds_columns (id, store_id, display_name, column_type, options_json, sort_order, created_at) VALUES ('c1', 's1', 'due', 'date', NULL, 0, 't0')").run();
  db.prepare("INSERT INTO ds_rows (id, store_id, data_json, created_at, updated_at) VALUES ('r1', 's1', '{\"c1\":\"2030-01-01\"}', 't0', 't0')").run();
  applyMigrations(db);
  return db;
};

describe('the daemon-set column migration upgrading a database at version 009', () => {
  it('keeps every existing store, column and row untouched, with no column set by the daemon', () => {
    const db = openDatabaseUpgradedFrom009();

    const columns = db.prepare('SELECT id, column_type, auto_value FROM ds_columns').all();
    const rows = db.prepare('SELECT id, data_json FROM ds_rows').all();

    expect(columns).toEqual([{ id: 'c1', column_type: 'date', auto_value: null }]);
    expect(rows).toEqual([{ id: 'r1', data_json: '{"c1":"2030-01-01"}' }]);
  });

  it('refuses any auto_value other than created_at at the database level', () => {
    const db = openDatabaseUpgradedFrom009();

    const setUpdatedAt = () => db.prepare("UPDATE ds_columns SET auto_value = 'updated_at'").run();
    const setCreatedAt = () => db.prepare("UPDATE ds_columns SET auto_value = 'created_at'").run();

    expect(setUpdatedAt).toThrow(/CHECK/);
    expect(setCreatedAt).not.toThrow();
  });
});
