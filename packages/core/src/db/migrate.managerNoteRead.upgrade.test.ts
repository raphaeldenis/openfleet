import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { ManagerRepository } from '../managers/managerRepository.js';
import type { NoteReadProgress } from '../managers/noteReadGuard.js';
import { applyMigrations } from './migrate.js';

const migrationsDirectory = new URL('./migrations/', import.meta.url);
const noteReadMigrationFileName = '038_manager_note_read.sql';

const migrationsBeforeNoteRead = readdirSync(migrationsDirectory)
  .filter((fileName) => fileName.endsWith('.sql') && fileName < noteReadMigrationFileName)
  .sort()
  .map((fileName) => ({ version: fileName.replace(/\.sql$/, ''), sql: readFileSync(new URL(fileName, migrationsDirectory), 'utf8') }));

const insertManager = (db: DatabaseSync, id: string) => {
  db.prepare(`INSERT INTO sessions (id, name, directory, model, harness, state, state_since, hook_token, mcp_token, permission_mode, branch, created_at, resolved_model, resolved_for_model)
    VALUES (?, 'Lead', '/tmp/wt', 'opus', 'fake', 'idle', 't0', ?, ?, 'plan', 'main', 't0', 'claude-opus-5-5', 'opus')`).run(id, `h-${id}`, `m-${id}`);
  db.prepare("INSERT INTO managers (session_id, pulse_seconds, children_cap, mission_text, created_at) VALUES (?, 1800, 3, 'Ship it', 't0')").run(id);
};

const progress: NoteReadProgress = { noteId: 'mission', rev: 2, totalBytes: 10, bodyRanges: [[0, 10]], mentionIdsToRead: ['annex'], mentionIdsRead: [] };

describe('the manager note read migration upgrading a database that predates it', () => {
  it('leaves every existing manager with a mission note it has not read', () => {
    const db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys = ON;');
    applyMigrations(db, migrationsBeforeNoteRead);
    insertManager(db, 'lead');

    applyMigrations(db);

    const upgraded = new ManagerRepository(db).get('lead');
    expect(upgraded).toMatchObject({ sessionId: 'lead', missionText: 'Ship it', childrenCap: 3 });
    expect(upgraded?.noteRead).toBeUndefined();
    expect(upgraded?.noteReadResetAt).toBeUndefined();
  });

  it('remembers what was read of the mission note after the database is reopened', () => {
    const db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys = ON;');
    applyMigrations(db);
    insertManager(db, 'lead');
    new ManagerRepository(db).setNoteRead('lead', progress);

    const managerAfterReopen = new ManagerRepository(db).get('lead');

    expect(managerAfterReopen?.noteRead).toEqual(progress);
  });

  it('forgets the read and dates the reset, then stops reminding once the reset is cleared', () => {
    const db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys = ON;');
    applyMigrations(db);
    insertManager(db, 'lead');
    const repository = new ManagerRepository(db);
    repository.setNoteRead('lead', progress);

    repository.resetNoteRead('lead', '2026-10-28T23:00:00.000Z');
    const afterReset = repository.get('lead');
    repository.clearNoteReadReset('lead');

    expect(afterReset?.noteRead).toBeUndefined();
    expect(afterReset?.noteReadResetAt).toBe('2026-10-28T23:00:00.000Z');
    expect(repository.get('lead')?.noteReadResetAt).toBeUndefined();
  });

  it('forgets nothing but the read when a manager is later edited', () => {
    const db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys = ON;');
    applyMigrations(db);
    insertManager(db, 'lead');
    const repository = new ManagerRepository(db);
    repository.setNoteRead('lead', progress);

    repository.update('lead', { missionText: 'Ship it faster' });

    expect(repository.get('lead')?.noteRead).toEqual(progress);
  });
});
