import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { ManagerRepository } from '../managers/managerRepository.js';
import { ReviewFindingsRepository, type ReviewFinding } from '../review/reviewFindingsRepository.js';
import { applyMigrations } from './migrate.js';

const migrationsDirectory = new URL('./migrations/', import.meta.url);
const reviewFindingsMigrationFileName = '033_review_findings.sql';

const migrationsBeforeReviewFindings = readdirSync(migrationsDirectory)
  .filter((fileName) => fileName.endsWith('.sql') && fileName < reviewFindingsMigrationFileName)
  .sort()
  .map((fileName) => ({ version: fileName.replace(/\.sql$/, ''), sql: readFileSync(new URL(fileName, migrationsDirectory), 'utf8') }));

const insertManager = (db: DatabaseSync, id: string) => {
  db.prepare(`INSERT INTO sessions (id, name, directory, model, harness, state, state_since, hook_token, mcp_token, permission_mode, branch, created_at, resolved_model, resolved_for_model)
    VALUES (?, 'Lead', '/tmp/wt', 'opus', 'fake', 'idle', 't0', ?, ?, 'plan', 'main', 't0', 'claude-opus-5-5', 'opus')`).run(id, `h-${id}`, `m-${id}`);
  db.prepare("INSERT INTO managers (session_id, pulse_seconds, children_cap, mission_text, created_at) VALUES (?, 1800, 3, 'Ship it', 't0')").run(id);
};

const SHA = 'a'.repeat(40);
const goLine: ReviewFinding = { ticket: 'CCM-1', step: 'adversarial', severity: 'go', claim: '', reasons: [], sha: SHA, authorSessionId: 'reviewer', managerSessionId: 'lead', createdAt: '2026-10-17T10:00:00.000Z' };

describe('the review findings migration upgrading a database that predates it', () => {
  it('keeps every existing manager and starts with no finding', () => {
    const db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys = ON;');
    applyMigrations(db, migrationsBeforeReviewFindings);
    insertManager(db, 'lead');

    applyMigrations(db);

    expect(new ManagerRepository(db).get('lead')).toMatchObject({ sessionId: 'lead', missionText: 'Ship it', childrenCap: 3 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM review_findings').get()).toEqual({ n: 0 });
  });

  it('remembers a line after the database is reopened, whatever happens to the session that wrote it', () => {
    const db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys = ON;');
    applyMigrations(db);
    insertManager(db, 'lead');
    new ReviewFindingsRepository(db).record(goLine);

    const lines = new ReviewFindingsRepository(db).adversarialLinesOf({ ticket: 'CCM-1' });

    expect(lines).toEqual([goLine]);
  });

  it('refuses a step or a severity the gate does not know', () => {
    const db = new DatabaseSync(':memory:');
    applyMigrations(db);
    const repository = new ReviewFindingsRepository(db);

    expect(() => repository.record({ ...goLine, step: 'vibes' as never })).toThrow();
    expect(() => repository.record({ ...goLine, severity: 'maybe' as never })).toThrow();
  });
});
