import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { ReviewFindingsRepository, type ReviewFinding } from '../review/reviewFindingsRepository.js';
import { applyMigrations } from './migrate.js';

const downScriptsDirectory = new URL('./migrations-down/', import.meta.url);
const findingItemsMigration = '045_review_finding_items';
const downScriptOf = (version: string) => readFileSync(new URL(`${version}.down.sql`, downScriptsDirectory), 'utf8');

const qeReport: ReviewFinding = {
  ticket: 'CCM-1', step: 'qe', severity: 'no-go', claim: 'the filter is missing; a 500 on the stream', reasons: ['the filter is missing', 'a 500 on the stream'],
  sha: 'a'.repeat(40), authorSessionId: 'qe-1', managerSessionId: 'lead-1', createdAt: '2026-10-29T08:00:00.000Z',
};
const cleanReport: ReviewFinding = { ...qeReport, severity: 'clean', claim: '', reasons: [] };

const migratedRepository = () => {
  const db = new DatabaseSync(':memory:');
  applyMigrations(db);
  return { db, repository: new ReviewFindingsRepository(db) };
};

describe('the review finding items: one row per finding of a structured report', () => {
  it('a qe report with 2 findings creates 2 rows that share one report id', () => {
    const { repository } = migratedRepository();

    repository.record(qeReport);

    const items = repository.itemsOf({ ticket: 'CCM-1' });
    expect(items.map((item) => item.claim)).toEqual(['the filter is missing', 'a 500 on the stream']);
    expect(items.map((item) => item.position)).toEqual([0, 1]);
    expect(new Set(items.map((item) => item.reportId)).size).toBe(1);
    expect(items[0]).toMatchObject({ ticket: 'CCM-1', step: 'qe', severity: 'no-go', sha: 'a'.repeat(40), authorSessionId: 'qe-1', managerSessionId: 'lead-1', createdAt: '2026-10-29T08:00:00.000Z' });
  });

  it('the same report replayed creates no row more', () => {
    const { repository } = migratedRepository();

    repository.record(qeReport);
    repository.record(qeReport);

    expect(repository.itemsOf({ ticket: 'CCM-1' })).toHaveLength(2);
  });

  it('a report with 0 finding creates the explicit "0 findings" row, once', () => {
    const { repository } = migratedRepository();

    repository.record(cleanReport);
    repository.record(cleanReport);

    expect(repository.itemsOf({ ticket: 'CCM-1' })).toMatchObject([{ position: 0, step: 'qe', severity: 'clean', claim: '0 findings' }]);
  });

  it('a different report on the same ticket gets its own rows', () => {
    const { repository } = migratedRepository();

    repository.record(qeReport);
    repository.record({ ...qeReport, sha: 'b'.repeat(40) });

    expect(repository.itemsOf({ ticket: 'CCM-1' })).toHaveLength(4);
  });

  it('keeps the tickets apart and the adversarial reasons as findings', () => {
    const { repository } = migratedRepository();

    repository.record({ ...qeReport, ticket: 'CCM-2', step: 'adversarial', reasons: ['a race'], claim: 'a race' });

    expect(repository.itemsOf({ ticket: 'CCM-1' })).toEqual([]);
    expect(repository.itemsOf({ ticket: 'CCM-2' })).toMatchObject([{ step: 'adversarial', claim: 'a race' }]);
  });
});

describe('the review finding items migration', () => {
  it('leaves the existing report lines untouched and starts with no item', () => {
    const { db, repository } = migratedRepository();
    repository.record(qeReport);
    db.exec('DELETE FROM review_finding_items');
    applyMigrations(db);

    expect(repository.linesOf({ ticket: 'CCM-1' })).toEqual([qeReport]);
    expect(db.prepare('SELECT COUNT(*) AS n FROM review_finding_items').get()).toEqual({ n: 0 });
  });

  it('its down script drops the table and the up applies again afterwards', () => {
    const { db } = migratedRepository();

    db.exec(downScriptOf(findingItemsMigration));
    const tableAfterDown = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'review_finding_items'`).all();
    db.prepare('DELETE FROM schema_migrations WHERE version = ?').run(findingItemsMigration);
    applyMigrations(db);

    expect(tableAfterDown).toEqual([]);
    expect(db.prepare('SELECT COUNT(*) AS n FROM review_finding_items').get()).toEqual({ n: 0 });
  });
});
