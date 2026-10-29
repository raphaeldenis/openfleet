import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { ReviewFindingsRepository, type ReviewFinding } from '../review/reviewFindingsRepository.js';
import { applyMigrations } from './migrate.js';

const downScriptsDirectory = new URL('./migrations-down/', import.meta.url);
const reproMigration = '053_review_finding_repro';
const downScriptOf = (version: string) => readFileSync(new URL(`${version}.down.sql`, downScriptsDirectory), 'utf8');

const SHA = 'a'.repeat(40);
const provenRepro = { status: 'proven', command: 'pnpm vitest run filter.test.ts', output: 'FAIL filter.test.ts\nexpected 1 filter' } as const;
const readInCodeRepro = { status: 'not_reproduced' } as const;

const qeReport: ReviewFinding = {
  ticket: 'CCM-1', step: 'qe', severity: 'no-go', claim: 'the filter is missing; a 500 on the stream', reasons: ['the filter is missing', 'a 500 on the stream'],
  repros: [provenRepro, readInCodeRepro],
  sha: SHA, authorSessionId: 'qe-1', managerSessionId: 'lead-1', createdAt: '2026-10-29T08:00:00.000Z',
};

const migratedRepository = () => {
  const db = new DatabaseSync(':memory:');
  applyMigrations(db);
  return { db, repository: new ReviewFindingsRepository(db) };
};

describe('the reproduction of each finding item', () => {
  it('stores the status, the command and the output of each finding of a report', () => {
    const { repository } = migratedRepository();

    repository.record(qeReport);

    const items = repository.itemsOf({ ticket: 'CCM-1' });
    expect(items.map((item) => item.repro)).toEqual([provenRepro, readInCodeRepro]);
  });

  it('keeps the line breaks of the output', () => {
    const { repository } = migratedRepository();

    repository.record(qeReport);

    expect(repository.itemsOf({ ticket: 'CCM-1' })[0]!.repro?.output).toBe('FAIL filter.test.ts\nexpected 1 filter');
  });

  it('reads a finding recorded without reproduction as repro null', () => {
    const { repository } = migratedRepository();
    const { repros: _repros, ...legacyReport } = qeReport;

    repository.record(legacyReport);

    expect(repository.itemsOf({ ticket: 'CCM-1' }).map((item) => item.repro)).toEqual([null, null]);
  });

  it('gives a report with another output its own rows', () => {
    const { repository } = migratedRepository();

    repository.record(qeReport);
    repository.record({ ...qeReport, repros: [{ ...provenRepro, output: 'FAIL elsewhere' }, readInCodeRepro] });

    expect(repository.itemsOf({ ticket: 'CCM-1' })).toHaveLength(4);
  });

  it('adds no row when the same report with its reproduction is replayed', () => {
    const { repository } = migratedRepository();

    repository.record(qeReport);
    repository.record(qeReport);

    expect(repository.itemsOf({ ticket: 'CCM-1' })).toHaveLength(2);
  });

  it('writes the "0 findings" row of a clean report with repro null', () => {
    const { repository } = migratedRepository();

    repository.record({ ...qeReport, severity: 'clean', claim: '', reasons: [], repros: [] });

    expect(repository.itemsOf({ ticket: 'CCM-1' })).toMatchObject([{ claim: '0 findings', repro: null }]);
  });

  it('keeps the report line the findings gate reads as it was', () => {
    const { repository } = migratedRepository();

    const { repros: _repros, ...reportLine } = qeReport;

    repository.record(qeReport);

    expect(repository.linesOf({ ticket: 'CCM-1' })).toEqual([reportLine]);
  });

  it('refuses a status outside proven, plausible and not_reproduced', () => {
    const { db } = migratedRepository();

    const insertUnknownStatus = () => db.prepare(`INSERT INTO review_finding_items (report_id, position, ticket, step, severity, claim, sha, author_session_id, created_at, repro_status) VALUES ('r', 0, 'CCM-1', 'qe', 'no-go', 'c', ?, 'qe-1', 't', 'maybe')`).run(SHA);

    expect(insertUnknownStatus).toThrow(/CHECK/);
  });
});

describe('the review finding repro migration', () => {
  it('leaves the items recorded before it readable, with repro null', () => {
    const { db, repository } = migratedRepository();
    db.exec(downScriptOf(reproMigration));
    db.prepare(`INSERT INTO review_finding_items (report_id, position, ticket, step, severity, claim, sha, author_session_id, manager_session_id, created_at) VALUES ('old', 0, 'CCM-1', 'qe', 'no-go', 'an old claim', ?, 'qe-1', 'lead-1', '2026-10-01T00:00:00.000Z')`).run(SHA);
    db.prepare('DELETE FROM schema_migrations WHERE version = ?').run(reproMigration);

    applyMigrations(db);

    expect(repository.itemsOf({ ticket: 'CCM-1' })).toMatchObject([{ claim: 'an old claim', repro: null }]);
  });

  it('its down script drops the three columns and the up applies again afterwards', () => {
    const { db } = migratedRepository();

    db.exec(downScriptOf(reproMigration));
    const columnsAfterDown = (db.prepare('PRAGMA table_info(review_finding_items)').all() as { name: string }[]).map((column) => column.name);
    db.prepare('DELETE FROM schema_migrations WHERE version = ?').run(reproMigration);
    applyMigrations(db);
    const columnsAfterUp = (db.prepare('PRAGMA table_info(review_finding_items)').all() as { name: string }[]).map((column) => column.name);

    expect(columnsAfterDown).not.toContain('repro_status');
    expect(columnsAfterUp).toEqual(expect.arrayContaining(['repro_status', 'repro_command', 'repro_output']));
  });
});
