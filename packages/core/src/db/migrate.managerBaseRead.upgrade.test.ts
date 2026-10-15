import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { ManagerRepository } from '../managers/managerRepository.js';
import { applyMigrations } from './migrate.js';

const migrationsDirectory = new URL('./migrations/', import.meta.url);
const baseReadMigrationFileName = '032_manager_base_read.sql';

const migrationsBeforeBaseRead = readdirSync(migrationsDirectory)
  .filter((fileName) => fileName.endsWith('.sql') && fileName < baseReadMigrationFileName)
  .sort()
  .map((fileName) => ({ version: fileName.replace(/\.sql$/, ''), sql: readFileSync(new URL(fileName, migrationsDirectory), 'utf8') }));

const insertManager = (db: DatabaseSync, id: string) => {
  db.prepare(`INSERT INTO sessions (id, name, directory, model, harness, state, state_since, hook_token, mcp_token, permission_mode, branch, created_at, resolved_model, resolved_for_model)
    VALUES (?, 'Lead', '/tmp/wt', 'opus', 'fake', 'idle', 't0', ?, ?, 'plan', 'main', 't0', 'claude-opus-5-5', 'opus')`).run(id, `h-${id}`, `m-${id}`);
  db.prepare("INSERT INTO managers (session_id, pulse_seconds, children_cap, mission_text, created_at) VALUES (?, 1800, 3, 'Ship it', 't0')").run(id);
};

describe('the manager base read migration upgrading a database that predates it', () => {
  it('leaves every existing manager with a base it has not read', () => {
    const db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys = ON;');
    applyMigrations(db, migrationsBeforeBaseRead);
    insertManager(db, 'lead');

    applyMigrations(db);

    const upgraded = new ManagerRepository(db).get('lead');
    expect(upgraded).toMatchObject({ sessionId: 'lead', missionText: 'Ship it', childrenCap: 3 });
    expect(upgraded?.baseRead).toBeUndefined();
  });

  it('remembers the version, the sha and the date of a read after the database is reopened', () => {
    const db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys = ON;');
    applyMigrations(db);
    insertManager(db, 'lead');
    new ManagerRepository(db).recordBaseRead('lead', { version: 2, sha: 'abc123', readAt: '2026-10-15T10:00:00.000Z' });

    const managerAfterReopen = new ManagerRepository(db).get('lead');

    expect(managerAfterReopen?.baseRead).toEqual({ version: 2, sha: 'abc123', readAt: '2026-10-15T10:00:00.000Z' });
  });

  it('forgets nothing but the read when a manager is later edited', () => {
    const db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys = ON;');
    applyMigrations(db);
    insertManager(db, 'lead');
    const repository = new ManagerRepository(db);
    repository.recordBaseRead('lead', { version: 2, sha: 'abc123', readAt: '2026-10-15T10:00:00.000Z' });

    repository.update('lead', { missionText: 'Ship it faster' });

    expect(repository.get('lead')?.baseRead?.version).toBe(2);
  });
});
