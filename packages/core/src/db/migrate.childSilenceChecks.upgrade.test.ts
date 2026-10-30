import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { applyMigrations } from './migrate.js';

const migrationsDownDirectory = new URL('./migrations-down/', import.meta.url);

const insertSession = (db: DatabaseSync, id: string) => {
  db.prepare(`INSERT INTO sessions (id, name, directory, model, harness, state, state_since, hook_token, mcp_token, permission_mode, branch, created_at, resolved_model, resolved_for_model)
    VALUES (?, 'S', '/tmp/wt', 'opus', 'fake', 'idle', 't0', ?, ?, 'plan', 'main', 't0', 'claude-opus-5-5', 'opus')`).run(id, `h-${id}`, `m-${id}`);
};

const openMigratedDatabase = () => {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  applyMigrations(db);
  return db;
};

describe('the child silence checks migration', () => {
  it('drops the check of a session when the child or the manager is deleted', () => {
    const db = openMigratedDatabase();
    for (const id of ['lead', 'child-a', 'child-b']) insertSession(db, id);
    const insertCheck = db.prepare("INSERT INTO child_silence_checks (child_id, manager_id, armed_at, due_at) VALUES (?, 'lead', 't1', 't2')");
    insertCheck.run('child-a');
    insertCheck.run('child-b');

    db.prepare("DELETE FROM sessions WHERE id = 'child-a'").run();
    expect(db.prepare('SELECT COUNT(*) AS n FROM child_silence_checks').get()).toEqual({ n: 1 });
    db.prepare("DELETE FROM sessions WHERE id = 'lead'").run();

    expect(db.prepare('SELECT COUNT(*) AS n FROM child_silence_checks').get()).toEqual({ n: 0 });
  });

  it('ships a down migration outside the migrations folder that removes the table', () => {
    const db = openMigratedDatabase();

    db.exec(readFileSync(new URL('062_child_silence_checks.down.sql', migrationsDownDirectory), 'utf8'));

    expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'child_silence_checks'").get()).toBeUndefined();
  });
});
