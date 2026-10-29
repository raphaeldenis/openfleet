import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { ReviewFindingsRepository, type ReviewFinding } from '../review/reviewFindingsRepository.js';
import { applyMigrations } from './migrate.js';

const migrationsDirectory = new URL('./migrations/', import.meta.url);
const stepSkipsMigrationFileName = '034_review_step_skips.sql';

const migrationsBeforeStepSkips = readdirSync(migrationsDirectory)
  .filter((fileName) => fileName.endsWith('.sql') && fileName < stepSkipsMigrationFileName)
  .sort()
  .map((fileName) => ({ version: fileName.replace(/\.sql$/, ''), sql: readFileSync(new URL(fileName, migrationsDirectory), 'utf8') }));

const provenanceMigrationFileName = '040_review_step_skip_provenance.sql';

const migrationsBeforeStepSkipProvenance = readdirSync(migrationsDirectory)
  .filter((fileName) => fileName.endsWith('.sql') && fileName < provenanceMigrationFileName)
  .sort()
  .map((fileName) => ({ version: fileName.replace(/\.sql$/, ''), sql: readFileSync(new URL(fileName, migrationsDirectory), 'utf8') }));

const goLine: ReviewFinding = { ticket: 'CCM-1', step: 'adversarial', severity: 'go', claim: '', reasons: [], sha: 'a'.repeat(40), authorSessionId: 'reviewer', managerSessionId: null, createdAt: '2026-10-17T10:00:00.000Z' };

describe('the review step skips migration upgrading a database that predates it', () => {
  it('keeps the findings already recorded and starts with no skip', () => {
    const db = new DatabaseSync(':memory:');
    applyMigrations(db, migrationsBeforeStepSkips);
    db.prepare('INSERT INTO review_findings (ticket, step, severity, claim, reasons_json, sha, author_session_id, manager_session_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(goLine.ticket, goLine.step, goLine.severity, goLine.claim, JSON.stringify(goLine.reasons), goLine.sha, goLine.authorSessionId, goLine.managerSessionId, goLine.createdAt);

    applyMigrations(db);

    expect(new ReviewFindingsRepository(db).linesOf({ ticket: 'CCM-1' })).toEqual([goLine]);
    expect(db.prepare('SELECT COUNT(*) AS n FROM review_step_skips').get()).toEqual({ n: 0 });
  });

  it('remembers a skip with its reason', () => {
    const db = new DatabaseSync(':memory:');
    applyMigrations(db);
    const repository = new ReviewFindingsRepository(db);
    const skip = { ticket: 'CCM-1', step: 'qa' as const, reason: 'no browser here', createdAt: '2026-10-17T10:00:00.000Z' };

    repository.recordSkip(skip);

    expect(repository.skipsOf({ ticket: 'CCM-1' })).toEqual([skip]);
  });

  it('upgrades a skip recorded before the provenance columns: its author and head stay absent', () => {
    const db = new DatabaseSync(':memory:');
    applyMigrations(db, migrationsBeforeStepSkipProvenance);
    db.prepare('INSERT INTO review_step_skips (ticket, step, reason, created_at) VALUES (?, ?, ?, ?)').run('CCM-1', 'qa', 'old', '2026-10-17T10:00:00.000Z');

    applyMigrations(db);

    expect(new ReviewFindingsRepository(db).skipsOf({ ticket: 'CCM-1' })).toEqual([{ ticket: 'CCM-1', step: 'qa', reason: 'old', createdAt: '2026-10-17T10:00:00.000Z' }]);
  });

  it('remembers the author and the head of a skip', () => {
    const db = new DatabaseSync(':memory:');
    applyMigrations(db);
    const repository = new ReviewFindingsRepository(db);
    const skip = { ticket: 'CCM-1', step: 'qa' as const, reason: 'ok', createdAt: 't', author: 'human', headSha: 'a'.repeat(40) };

    repository.recordSkip(skip);

    expect(repository.skipsOf({ ticket: 'CCM-1' })).toEqual([skip]);
  });

  it('refuses to skip the adversarial review, an unknown step or a blank reason', () => {
    const db = new DatabaseSync(':memory:');
    applyMigrations(db);
    const repository = new ReviewFindingsRepository(db);
    const skip = { ticket: 'CCM-1', step: 'qa' as const, reason: 'ok', createdAt: 't' };

    expect(() => repository.recordSkip({ ...skip, step: 'adversarial' as never })).toThrow();
    expect(() => repository.recordSkip({ ...skip, step: 'vibes' as never })).toThrow();
    expect(() => repository.recordSkip({ ...skip, reason: '   ' })).toThrow();
  });
});
