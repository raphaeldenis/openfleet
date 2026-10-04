import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { applyMigrations } from './migrate.js';

const migrationsDirectory = new URL('./migrations/', import.meta.url);
const LEDGER_MIGRATION = '020_scape_import_ledger';
const A_SHA256 = 'a'.repeat(64);

const migrationsBeforeTheLedger = readdirSync(migrationsDirectory)
  .filter((fileName) => fileName.endsWith('.sql') && fileName < '020')
  .sort()
  .map((fileName) => ({ version: fileName.replace(/\.sql$/, ''), sql: readFileSync(new URL(fileName, migrationsDirectory), 'utf8') }));

const openDatabaseUpgradedFromBeforeTheLedger = () => {
  const db = new DatabaseSync(':memory:');
  applyMigrations(db, migrationsBeforeTheLedger);
  db.prepare(`INSERT INTO projects (id, name, created_at) VALUES ('p1', 'kept', 't0')`).run();
  applyMigrations(db);
  return db;
};

const insertEntry = (db: DatabaseSync, input: { kind: string; id: string; hash: string }) =>
  db.prepare(`INSERT INTO scape_import_ledger (kind, id, record_hash, imported_at) VALUES (?, ?, ?, 't1')`).run(input.kind, input.id, input.hash);

describe('the Scape import ledger migration upgrading a database that predates it', () => {
  it('keeps existing data and records the migration as applied', () => {
    const db = openDatabaseUpgradedFromBeforeTheLedger();

    const projects = db.prepare('SELECT id FROM projects').all();
    const versions = (db.prepare('SELECT version FROM schema_migrations').all() as { version: string }[]).map((row) => row.version);

    expect(projects).toEqual([{ id: 'p1' }]);
    expect(versions).toContain(LEDGER_MIGRATION);
  });

  it('creates a STRICT table whose four columns are mandatory', () => {
    const db = openDatabaseUpgradedFromBeforeTheLedger();

    const table = db.prepare("SELECT strict FROM pragma_table_list WHERE name = 'scape_import_ledger'").get();
    const columns = db.prepare("SELECT name, \"notnull\" AS required FROM pragma_table_info('scape_import_ledger')").all();

    expect(table).toEqual({ strict: 1 });
    expect(columns).toEqual([
      { name: 'kind', required: 1 },
      { name: 'id', required: 1 },
      { name: 'record_hash', required: 1 },
      { name: 'imported_at', required: 1 },
    ]);
  });

  it('holds one entry per kind and id, and the same id under another kind', () => {
    const db = openDatabaseUpgradedFromBeforeTheLedger();
    insertEntry(db, { kind: 'note', id: 'x', hash: A_SHA256 });

    insertEntry(db, { kind: 'row', id: 'x', hash: A_SHA256 });

    expect(() => insertEntry(db, { kind: 'note', id: 'x', hash: A_SHA256 })).toThrow(/UNIQUE|PRIMARY/);
  });

  it('refuses an empty kind, an empty id and a hash that is no sha256 hex length', () => {
    const db = openDatabaseUpgradedFromBeforeTheLedger();

    expect(() => insertEntry(db, { kind: '', id: 'x', hash: A_SHA256 })).toThrow(/CHECK/);
    expect(() => insertEntry(db, { kind: 'note', id: '', hash: A_SHA256 })).toThrow(/CHECK/);
    expect(() => insertEntry(db, { kind: 'note', id: 'x', hash: 'short' })).toThrow(/CHECK/);
  });
});
