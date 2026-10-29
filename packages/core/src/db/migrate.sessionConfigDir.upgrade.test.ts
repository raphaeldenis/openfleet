import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { SessionRepository } from '../sessions/sessionRepository.js';
import { applyMigrations } from './migrate.js';

const migrationsDirectory = new URL('./migrations/', import.meta.url);
const sessionConfigDirMigrationFileName = '044_session_config_dir.sql';

const migrationsBeforeSessionConfigDir = readdirSync(migrationsDirectory)
  .filter((fileName) => fileName.endsWith('.sql') && fileName < sessionConfigDirMigrationFileName)
  .sort()
  .map((fileName) => ({ version: fileName.replace(/\.sql$/, ''), sql: readFileSync(new URL(fileName, migrationsDirectory), 'utf8') }));

const insertSession = (db: DatabaseSync, id: string) => {
  db.prepare(`INSERT INTO sessions (id, name, directory, model, harness, state, state_since, hook_token, mcp_token, permission_mode, branch, created_at)
    VALUES (?, 'Lead', '/tmp/wt', 'opus', 'claude-cli', 'idle', 't0', ?, ?, 'plan', 'main', 't0')`).run(id, `h-${id}`, `m-${id}`);
};

const newSessionRow = (configDir?: string) => ({
  id: 'new-session', name: 'Lead', emoji: '🧭', directory: '/tmp/wt', worktree: null, model: null, parent_id: null, role: null, harness: 'claude-cli' as const,
  state: 'starting' as const, state_since: 't0', hook_token: 'h', mcp_token: 'm', permission_mode: null, branch: null, config_dir: configDir ?? null, created_at: 't0',
});

describe('the session config_dir migration upgrading a database that predates it', () => {
  it('leaves every existing session without a config profile and without a config dir', () => {
    const db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys = ON;');
    applyMigrations(db, migrationsBeforeSessionConfigDir);
    insertSession(db, 'old-session');

    applyMigrations(db);

    const repository = new SessionRepository(db);
    expect(repository.get('old-session')).toMatchObject({ id: 'old-session', name: 'Lead' });
    expect(repository.get('old-session')?.configProfile).toBeUndefined();
    expect(repository.configDirOf('old-session')).toBeUndefined();
  });

  it('exposes only the profile name publicly and keeps the path for the launch, after the database is reopened', () => {
    const db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys = ON;');
    applyMigrations(db);
    new SessionRepository(db).insert(newSessionRow('/Users/synthetic/.claude-work'));

    const reopened = new SessionRepository(db);

    expect(reopened.get('new-session')?.configProfile).toBe('.claude-work');
    expect(JSON.stringify(reopened.get('new-session'))).not.toContain('/Users/synthetic');
    expect(reopened.configDirOf('new-session')).toBe('/Users/synthetic/.claude-work');
  });
});
