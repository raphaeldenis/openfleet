import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { ManagerRepository } from '../managers/managerRepository.js';
import { applyMigrations } from './migrate.js';

const migrationsDirectory = new URL('./migrations/', import.meta.url);
const migrationsDownDirectory = new URL('./migrations-down/', import.meta.url);
const childAutoRestartMigrationFileName = '050_child_auto_restart.sql';

const migrationsBeforeChildAutoRestart = readdirSync(migrationsDirectory)
  .filter((fileName) => fileName.endsWith('.sql') && fileName < childAutoRestartMigrationFileName)
  .sort()
  .map((fileName) => ({ version: fileName.replace(/\.sql$/, ''), sql: readFileSync(new URL(fileName, migrationsDirectory), 'utf8') }));

const insertSession = (db: DatabaseSync, id: string) => {
  db.prepare(`INSERT INTO sessions (id, name, directory, model, harness, state, state_since, hook_token, mcp_token, permission_mode, branch, created_at, resolved_model, resolved_for_model)
    VALUES (?, 'Lead', '/tmp/wt', 'opus', 'fake', 'idle', 't0', ?, ?, 'plan', 'main', 't0', 'claude-opus-5-5', 'opus')`).run(id, `h-${id}`, `m-${id}`);
};

const insertManager = (db: DatabaseSync, id: string) => {
  insertSession(db, id);
  db.prepare("INSERT INTO managers (session_id, pulse_seconds, children_cap, mission_text, created_at) VALUES (?, 1800, 3, 'Ship it', 't0')").run(id);
};

describe('the child auto restart migration upgrading a database that predates it', () => {
  it('leaves every existing manager without automatic child restarts', () => {
    const db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys = ON;');
    applyMigrations(db, migrationsBeforeChildAutoRestart);
    insertManager(db, 'lead');

    applyMigrations(db);

    expect(new ManagerRepository(db).get('lead')?.childAutoRestart).toBe(false);
  });

  it('remembers the option after the database is reopened', () => {
    const db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys = ON;');
    applyMigrations(db);
    insertManager(db, 'lead');
    new ManagerRepository(db).setChildAutoRestart('lead', true);

    const managerAfterReopen = new ManagerRepository(db).get('lead');

    expect(managerAfterReopen?.childAutoRestart).toBe(true);
  });

  it('drops the restart records of a session when the session is deleted', () => {
    const db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys = ON;');
    applyMigrations(db);
    insertSession(db, 'child');
    db.prepare("INSERT INTO child_restarts (session_id, at) VALUES ('child', 't1')").run();

    db.prepare("DELETE FROM sessions WHERE id = 'child'").run();

    expect(db.prepare('SELECT COUNT(*) AS n FROM child_restarts').get()).toEqual({ n: 0 });
  });

  it('ships a down migration outside the migrations folder that removes what the migration adds', () => {
    const db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys = ON;');
    applyMigrations(db);

    db.exec(readFileSync(new URL('050_child_auto_restart.down.sql', migrationsDownDirectory), 'utf8'));

    const managerColumns = (db.prepare('PRAGMA table_info(managers)').all() as { name: string }[]).map((column) => column.name);
    const restartTable = db.prepare("SELECT name FROM sqlite_master WHERE name = 'child_restarts'").get();
    expect(managerColumns).not.toContain('child_auto_restart');
    expect(restartTable).toBeUndefined();
  });
});
