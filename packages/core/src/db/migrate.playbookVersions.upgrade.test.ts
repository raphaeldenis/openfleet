import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { applyMigrations } from './migrate.js';

const migrationsDownDirectory = new URL('./migrations-down/', import.meta.url);

const openMigratedDatabase = () => {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  applyMigrations(db);
  db.prepare("INSERT INTO projects (id, name, created_at) VALUES ('p1', 'One', 't0')").run();
  db.prepare("INSERT INTO playbooks (id, project_id, name, inputs_json, flow_json, policy_json, origin, created_at, updated_at) VALUES ('pb1', 'p1', 'P', '[]', '{\"cells\":[]}', '{}', 'native', 'n', 'n')").run();
  return db;
};

const insertVersion = (db: DatabaseSync, overrides: { rev?: number; source?: string; playbookId?: string } = {}) =>
  db.prepare("INSERT INTO playbook_versions (playbook_id, rev, name, inputs_json, flow_json, policy_json, sha256, source, approved_digest, created_at) VALUES (?, ?, 'P', '[]', '{\"cells\":[]}', '{}', 'abc', ?, NULL, 'n')")
    .run(overrides.playbookId ?? 'pb1', overrides.rev ?? 1, overrides.source ?? 'edit');

describe('the playbook versions migration', () => {
  it('stores a version per playbook and revision and refuses a second snapshot of the same revision', () => {
    const db = openMigratedDatabase();

    insertVersion(db);

    expect(() => insertVersion(db)).toThrow(/UNIQUE|PRIMARY KEY/);
    expect(() => insertVersion(db, { rev: 2 })).not.toThrow();
  });

  it('refuses a source other than edit and restore', () => {
    const db = openMigratedDatabase();

    expect(() => insertVersion(db, { source: 'cloud' })).toThrow(/CHECK constraint/);
  });

  it('refuses a version of a playbook that does not exist', () => {
    const db = openMigratedDatabase();

    expect(() => insertVersion(db, { playbookId: 'ghost' })).toThrow(/FOREIGN KEY/);
  });

  it('removes the versions of a deleted playbook', () => {
    const db = openMigratedDatabase();
    insertVersion(db);

    db.prepare("DELETE FROM playbooks WHERE id = 'pb1'").run();

    expect(db.prepare('SELECT COUNT(*) AS n FROM playbook_versions').get()).toEqual({ n: 0 });
  });

  it('ships a down migration outside the migrations folder that removes the table and leaves the playbooks', () => {
    const db = openMigratedDatabase();

    db.exec(readFileSync(new URL('068_playbook_versions.down.sql', migrationsDownDirectory), 'utf8'));

    expect(db.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'playbook_versions%'").all()).toEqual([]);
    expect(db.prepare('SELECT COUNT(*) AS n FROM playbooks').get()).toEqual({ n: 1 });
  });
});
