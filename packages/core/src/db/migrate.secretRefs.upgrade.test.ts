import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { applyMigrations } from './migrate.js';

const migrationsDownDirectory = new URL('./migrations-down/', import.meta.url);

const openMigratedDatabase = () => {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  applyMigrations(db);
  return db;
};

type RefOverrides = Partial<Record<'scope_kind' | 'status' | 'name', string>>;

const insertRef = (db: DatabaseSync, overrides: RefOverrides = {}) =>
  db.prepare('INSERT INTO secret_refs (id, scope_kind, scope_id, name, status) VALUES (?, ?, ?, ?, ?)')
    .run(`ref-${Math.random()}`, overrides.scope_kind ?? 'playbook', 'pb-1', overrides.name ?? 'JIRA_TOKEN', overrides.status ?? 'missing');

describe('the secret refs migration', () => {
  it('creates the table on an empty database with metadata columns only', () => {
    const db = openMigratedDatabase();

    const columns = (db.prepare('PRAGMA table_info(secret_refs)').all() as { name: string }[]).map((column) => column.name);

    expect(columns).toEqual(['id', 'scope_kind', 'scope_id', 'name', 'status', 'set_at', 'set_by']);
  });

  it.each([
    ['scope kind', { scope_kind: 'planet' }],
    ['status', { status: 'leaked' }],
  ])('refuses a row with an unknown %s', (_name, overrides) => {
    const db = openMigratedDatabase();

    expect(() => insertRef(db, overrides)).toThrow(/CHECK constraint/);
  });

  it('refuses a second row for the same scope and name', () => {
    const db = openMigratedDatabase();
    insertRef(db);

    expect(() => insertRef(db)).toThrow(/UNIQUE constraint/);
  });

  it('ships a down migration outside the migrations folder that removes the table', () => {
    const db = openMigratedDatabase();

    db.exec(readFileSync(new URL('064_secret_refs.down.sql', migrationsDownDirectory), 'utf8'));

    expect(db.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'secret_refs%'").all()).toEqual([]);
  });
});
