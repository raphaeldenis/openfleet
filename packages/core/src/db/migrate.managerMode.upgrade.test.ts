import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { ManagerRepository } from '../managers/managerRepository.js';
import { applyMigrations } from './migrate.js';

const migrationsDirectory = new URL('./migrations/', import.meta.url);
const migrationsDownDirectory = new URL('./migrations-down/', import.meta.url);
const managerModeMigrationFileName = '051_manager_mode.sql';

const migrationsBeforeManagerMode = readdirSync(migrationsDirectory)
  .filter((fileName) => fileName.endsWith('.sql') && fileName < managerModeMigrationFileName)
  .sort()
  .map((fileName) => ({ version: fileName.replace(/\.sql$/, ''), sql: readFileSync(new URL(fileName, migrationsDirectory), 'utf8') }));

const insertManager = (db: DatabaseSync, { id, pulseEnabled }: { id: string; pulseEnabled: boolean }) => {
  db.prepare(`INSERT INTO sessions (id, name, directory, model, harness, state, state_since, hook_token, mcp_token, permission_mode, branch, created_at, resolved_model, resolved_for_model)
    VALUES (?, 'Lead', '/tmp/wt', 'opus', 'fake', 'idle', 't0', ?, ?, 'plan', 'main', 't0', 'claude-opus-5-5', 'opus')`).run(id, `h-${id}`, `m-${id}`);
  db.prepare("INSERT INTO managers (session_id, pulse_seconds, children_cap, mission_text, created_at, pulse_enabled) VALUES (?, 1800, 3, 'Ship it', 't0', ?)").run(id, Number(pulseEnabled));
};

const databaseBefore = (): DatabaseSync => {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  applyMigrations(db, migrationsBeforeManagerMode);
  return db;
};

describe('the manager mode migration upgrading a database that predates it', () => {
  it('turns a manager paused before the migration into a sleeping one, owing no [sleep] message', () => {
    const db = databaseBefore();
    insertManager(db, { id: 'paused', pulseEnabled: false });

    applyMigrations(db);

    expect(new ManagerRepository(db).get('paused')).toMatchObject({ mode: 'sleeping', pulseEnabled: false, sleepHandoffPending: false });
  });

  it('leaves a running manager watching', () => {
    const db = databaseBefore();
    insertManager(db, { id: 'running', pulseEnabled: true });

    applyMigrations(db);

    expect(new ManagerRepository(db).get('running')).toMatchObject({ mode: 'watching', pulseEnabled: true });
  });

  it('refuses a mode outside watching, sleeping and disabled', () => {
    const db = new DatabaseSync(':memory:');
    applyMigrations(db);
    insertManager(db, { id: 'lead', pulseEnabled: true });

    expect(() => db.prepare("UPDATE managers SET mode = 'napping' WHERE session_id = 'lead'").run()).toThrow(/CHECK/);
  });

  it('keeps pulse_enabled and the mode in step whichever way the mode is written', () => {
    const db = new DatabaseSync(':memory:');
    applyMigrations(db);
    insertManager(db, { id: 'lead', pulseEnabled: true });
    const managers = new ManagerRepository(db);

    const seen = (['sleeping', 'disabled', 'watching'] as const).map((mode) => {
      managers.setMode({ sessionId: 'lead', mode, at: `t-${mode}` });
      return { mode, pulseEnabled: managers.get('lead')?.pulseEnabled };
    });

    expect(seen).toEqual([{ mode: 'sleeping', pulseEnabled: false }, { mode: 'disabled', pulseEnabled: false }, { mode: 'watching', pulseEnabled: true }]);
  });

  it('ships a down migration outside the migrations folder that removes the mode columns', () => {
    const db = new DatabaseSync(':memory:');
    applyMigrations(db);

    db.exec(readFileSync(new URL('051_manager_mode.down.sql', migrationsDownDirectory), 'utf8'));

    const managerColumns = (db.prepare('PRAGMA table_info(managers)').all() as { name: string }[]).map((column) => column.name);
    expect(managerColumns).not.toContain('mode');
    expect(managerColumns).not.toContain('sleep_handoff_pending');
    expect(managerColumns).not.toContain('mode_changed_at');
    expect(managerColumns).not.toContain('sleep_handoff_delivered_at');
  });
});
