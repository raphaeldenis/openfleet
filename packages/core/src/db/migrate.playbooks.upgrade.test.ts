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
  return db;
};

const insertPlaybook = (db: DatabaseSync, overrides: { id?: string; origin?: string; agentLocked?: number } = {}) =>
  db.prepare("INSERT INTO playbooks (id, project_id, name, inputs_json, flow_json, policy_json, origin, agent_locked, created_at, updated_at) VALUES (?, 'p1', 'P', '[]', '{\"cells\":[]}', '{}', ?, ?, 'n', 'n')")
    .run(overrides.id ?? 'pb1', overrides.origin ?? 'native', overrides.agentLocked ?? 0);

describe('the playbooks migration', () => {
  it('creates the table on an empty database and starts a playbook unlocked, unapproved, at revision 1', () => {
    const db = openMigratedDatabase();

    insertPlaybook(db);

    expect(db.prepare('SELECT content_rev, agent_locked, approved_digest, approved_by, approved_at FROM playbooks').get())
      .toEqual({ content_rev: 1, agent_locked: 0, approved_digest: null, approved_by: null, approved_at: null });
  });

  it('refuses an origin outside native, imported and agent', () => {
    const db = openMigratedDatabase();

    expect(() => insertPlaybook(db, { origin: 'cloud' })).toThrow(/CHECK constraint/);
  });

  it('refuses a lock value other than 0 or 1', () => {
    const db = openMigratedDatabase();

    expect(() => insertPlaybook(db, { agentLocked: 2 })).toThrow(/CHECK constraint/);
  });

  it('refuses an approval that lacks its approver or its date, and an approver without a digest', () => {
    const db = openMigratedDatabase();
    insertPlaybook(db);

    expect(() => db.prepare("UPDATE playbooks SET approved_digest = 'd' WHERE id = 'pb1'").run()).toThrow(/CHECK constraint/);
    expect(() => db.prepare("UPDATE playbooks SET approved_by = 'h' WHERE id = 'pb1'").run()).toThrow(/CHECK constraint/);
  });

  it('removes the playbooks of a deleted project', () => {
    const db = openMigratedDatabase();
    insertPlaybook(db);

    db.prepare("DELETE FROM projects WHERE id = 'p1'").run();

    expect(db.prepare('SELECT COUNT(*) AS n FROM playbooks').get()).toEqual({ n: 0 });
  });

  it('ships a down migration outside the migrations folder that removes the table', () => {
    const db = openMigratedDatabase();

    db.exec(readFileSync(new URL('067_playbooks.down.sql', migrationsDownDirectory), 'utf8'));

    expect(db.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'playbooks%'").all()).toEqual([]);
  });
});
