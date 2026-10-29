import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { SessionRepository } from '../sessions/sessionRepository.js';
import { applyMigrations } from './migrate.js';

const migrationsDirectory = new URL('./migrations/', import.meta.url);
const launchReadinessMigrationFileName = '041_session_launch_readiness.sql';

const migrationsBeforeLaunchReadiness = readdirSync(migrationsDirectory)
  .filter((fileName) => fileName.endsWith('.sql') && fileName < launchReadinessMigrationFileName)
  .sort()
  .map((fileName) => ({ version: fileName.replace(/\.sql$/, ''), sql: readFileSync(new URL(fileName, migrationsDirectory), 'utf8') }));

const insertSession = (db: DatabaseSync, id: string) => {
  db.prepare(`INSERT INTO sessions (id, name, directory, model, harness, state, state_since, hook_token, mcp_token, permission_mode, branch, created_at)
    VALUES (?, 'Lead', '/tmp/wt', 'opus', 'claude-cli', 'idle', 't0', ?, ?, 'plan', 'main', 't0')`).run(id, `h-${id}`, `m-${id}`);
};

const aNewSessionRow = (id: string) => ({
  id, name: 'Lead', emoji: '🧭', directory: '/tmp/wt', worktree: null, model: null, parent_id: null, role: null, harness: 'claude-cli' as const,
  state: 'starting' as const, state_since: 't0', hook_token: 'h', mcp_token: 'm', permission_mode: null, branch: null, created_at: 't0',
});

describe('the session launch readiness migration upgrading a database that predates it', () => {
  it('leaves every existing session without a readiness and without a retry', () => {
    const db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys = ON;');
    applyMigrations(db, migrationsBeforeLaunchReadiness);
    insertSession(db, 'old-session');

    applyMigrations(db);

    const repository = new SessionRepository(db);
    expect(repository.get('old-session')).toMatchObject({ id: 'old-session', name: 'Lead', model: 'opus' });
    expect(repository.get('old-session')?.readiness).toBeUndefined();
    expect(repository.get('old-session')?.readinessReason).toBeUndefined();
    expect(repository.launchRetriesOf('old-session')).toBe(0);
  });

  it('remembers a failed readiness and its reason after the database is reopened', () => {
    const db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys = ON;');
    applyMigrations(db);
    new SessionRepository(db).insert(aNewSessionRow('new-session'));
    new SessionRepository(db).setReadiness('new-session', { readiness: 'failed', reason: 'no_output_at_launch' });

    const afterReopen = new SessionRepository(db).get('new-session');

    expect(afterReopen).toMatchObject({ readiness: 'failed', readinessReason: 'no_output_at_launch' });
  });

  it('counts the automatic launch retries of a session', () => {
    const db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys = ON;');
    applyMigrations(db);
    const repository = new SessionRepository(db);
    repository.insert(aNewSessionRow('new-session'));

    repository.incrementLaunchRetries('new-session');

    expect(repository.launchRetriesOf('new-session')).toBe(1);
  });
});
