import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { SessionRepository } from '../sessions/sessionRepository.js';
import { applyMigrations } from './migrate.js';

const migrationsDirectory = new URL('./migrations/', import.meta.url);
const sessionEffortMigrationFileName = '039_session_effort.sql';

const migrationsBeforeSessionEffort = readdirSync(migrationsDirectory)
  .filter((fileName) => fileName.endsWith('.sql') && fileName < sessionEffortMigrationFileName)
  .sort()
  .map((fileName) => ({ version: fileName.replace(/\.sql$/, ''), sql: readFileSync(new URL(fileName, migrationsDirectory), 'utf8') }));

const insertSession = (db: DatabaseSync, id: string) => {
  db.prepare(`INSERT INTO sessions (id, name, directory, model, harness, state, state_since, hook_token, mcp_token, permission_mode, branch, created_at)
    VALUES (?, 'Lead', '/tmp/wt', 'opus', 'claude-cli', 'idle', 't0', ?, ?, 'plan', 'main', 't0')`).run(id, `h-${id}`, `m-${id}`);
};

describe('the session effort migration upgrading a database that predates it', () => {
  it('leaves every existing session without an effort', () => {
    const db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys = ON;');
    applyMigrations(db, migrationsBeforeSessionEffort);
    insertSession(db, 'old-session');

    applyMigrations(db);

    const upgraded = new SessionRepository(db).get('old-session');
    expect(upgraded).toMatchObject({ id: 'old-session', name: 'Lead', model: 'opus' });
    expect(upgraded?.effort).toBeUndefined();
  });

  it('remembers the effort of a new session after the database is reopened', () => {
    const db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys = ON;');
    applyMigrations(db);
    new SessionRepository(db).insert({
      id: 'new-session', name: 'Lead', emoji: '🧭', directory: '/tmp/wt', worktree: null, model: null, parent_id: null, role: null, harness: 'claude-cli',
      state: 'starting', state_since: 't0', hook_token: 'h', mcp_token: 'm', permission_mode: null, branch: null, effort: 'max', created_at: 't0',
    });

    const afterReopen = new SessionRepository(db).get('new-session');

    expect(afterReopen?.effort).toBe('max');
  });
});
