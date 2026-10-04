import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { beforeEach, describe, expect, it } from 'vitest';
import { runImportCli } from '../importCli.js';
import { renderImportReport } from './importReport.js';
import { importScape } from './importScape.js';
import {
  buildScapeFixture, CCM_PROJECT_ID, DUE_COLUMN_ID, editScapeDatastore, editScapeNotes,
  KANBAN_VIEW_ID, LEXICAL_NOTE_ID, LOG_STORE_ID, MARKDOWN_NOTE_ID, OPENFLEET_PROJECT_ID, PRIORITY_COLUMN_ID,
  STATUS_COLUMN_ID, TITLE_COLUMN_ID, type ScapeFixture,
} from './scapeFixture.testkit.js';

describe('Scape import cutover follow-ups', () => {
  let fixture: ScapeFixture;
  let home: string;
  let scratchRoot: string;
  const run = (overrides: Partial<Parameters<typeof importScape>[0]> = {}) => importScape({
    scapeDir: fixture.scapeDir, home, scratchRoot,
    superpowersRoot: join(fixture.workDir, 'docs'), ...overrides,
  });
  const targetRows = (sql: string) => {
    const db = new DatabaseSync(join(home, 'openfleet.db'), { readOnly: true });
    try { return db.prepare(sql).all(); } finally { db.close(); }
  };

  beforeEach(() => {
    fixture = buildScapeFixture();
    home = join(fixture.workDir, 'target');
    scratchRoot = join(fixture.workDir, 'scratch');
    mkdirSync(scratchRoot);
  });

  it('excludes archived projects and everything that belongs to them', () => {
    editScapeNotes(fixture, (db) => db.prepare('UPDATE projects SET isArchived = 1 WHERE id = ?').run(CCM_PROJECT_ID));

    const report = run();

    expect(targetRows('SELECT id FROM projects')).toEqual([{ id: OPENFLEET_PROJECT_ID }]);
    expect(report.counts.notes.expected).toBe(1);
    expect(report.counts.dataStores.expected).toBe(0);
  });

  it('excludes archived notes and their versions', () => {
    editScapeNotes(fixture, (db) => {
      db.prepare('UPDATE notes SET isArchived = 1 WHERE id = ?').run(MARKDOWN_NOTE_ID);
    });

    const report = run();

    expect(targetRows(`SELECT id FROM notes WHERE id = '${MARKDOWN_NOTE_ID}'`)).toEqual([]);
    expect(targetRows(`SELECT id FROM note_versions WHERE note_id = '${MARKDOWN_NOTE_ID}'`)).toEqual([]);
    expect(report.counts.notes.expected).toBe(4);
  });

  it('reports orphan datastore files without importing or reading their tables', () => {
    const orphanName = 'FDD4ACA0-0000-0000-0000-000000000000.sqlite';
    copyFileSync(join(fixture.scapeDir, 'datastores', `${CCM_PROJECT_ID}.sqlite`), join(fixture.scapeDir, 'datastores', orphanName));

    const report = run({ dryRun: true });

    expect(renderImportReport(report)).toContain(orphanName);
    expect(report.counts.rows.expected).toBe(3);
    expect(existsSync(home)).toBe(false);
    expect(readdirSync(scratchRoot)).toEqual([]);
  });

  it('reports a store whose metadata has no backing table while keeping its definition', () => {
    editScapeDatastore(fixture, (db) => db.exec(`DROP TABLE store_${LOG_STORE_ID.replaceAll('-', '')}`));

    const report = run();

    expect(renderImportReport(report)).toContain(LOG_STORE_ID);
    expect(report.counts.dataStores.written).toBe(2);
    expect(report.counts.rows.written).toBe(2);
  });

  it('distinguishes an empty table from a missing table', () => {
    editScapeDatastore(fixture, (db) => db.exec(`DELETE FROM store_${LOG_STORE_ID.replaceAll('-', '')}`));

    const report = run({ dryRun: true });

    expect(renderImportReport(report)).not.toContain(LOG_STORE_ID);
  });

  it('reports the dropped column formats without dropping cell values or changing column types', () => {
    const formats = [
      { columnId: TITLE_COLUMN_ID, format: 'url' },
      { columnId: STATUS_COLUMN_ID, format: 'longText' },
      { columnId: PRIORITY_COLUMN_ID, format: 'rank' },
      { columnId: DUE_COLUMN_ID, format: 'datetime' },
    ];
    editScapeNotes(fixture, (db) => {
      for (const { columnId, format } of formats) db.prepare('UPDATE data_store_column SET format = ? WHERE id = ?').run(format, columnId);
    });

    const report = run();

    const markdown = renderImportReport(report);
    for (const { columnId, format } of formats) expect(markdown).toContain(`${columnId}: ${format}`);
    expect(report.counts.columns).toMatchObject({ written: 4, notConverted: 4 });
    expect(targetRows(`SELECT column_type FROM ds_columns WHERE id = '${DUE_COLUMN_ID}'`)).toEqual([{ column_type: 'date' }]);
    expect(report.counts.rows.written).toBe(3);
  });

  it('names the lost kanban columnOrder in the report', () => {
    const report = run({ dryRun: true });

    const markdown = renderImportReport(report);
    expect(markdown).toContain(KANBAN_VIEW_ID);
    expect(markdown).toContain('columnOrder');
    expect(report.counts.views.notConverted).toBe(1);
  });

  it('does not label native text and select presentation as lost formatting', () => {
    editScapeNotes(fixture, (db) => {
      db.prepare('UPDATE data_store_column SET format = ? WHERE id = ?').run('singleLine', TITLE_COLUMN_ID);
      db.prepare('UPDATE data_store_column SET format = ? WHERE id = ?').run('singleSelect', STATUS_COLUMN_ID);
    });

    const report = run({ dryRun: true });

    expect(report.counts.columns.notConverted).toBe(0);
    expect(report.droppedColumnFormats).toEqual([]);
  });

  it('writes the CLI cutover report into the project docs folder named by --report-dir', () => {
    const reportDir = join(fixture.workDir, 'docs', 'openfleet');
    const args = ['scape', '--home', home, '--scape-dir', fixture.scapeDir, '--report-dir', reportDir];

    const result = runImportCli(args, { homeDirectory: fixture.workDir, env: {} });

    expect(result.exitCode).toBe(0);
    expect(result.output).toContain(join(reportDir, 'import-report.md'));
    expect(readFileSync(join(reportDir, 'import-report.md'), 'utf8')).toContain('| rows | 3 | 3 |');
    expect(existsSync(join(home, 'import-report.md'))).toBe(false);
  });

  it('stores the converted heading and ragged table from a synthetic Lexical note and leaves them unchanged on re-import', () => {
    const text = (value: string) => ({ type: 'text', text: value });
    const cell = (value: string) => ({ type: 'tablecell', children: [{ type: 'paragraph', children: [text(value)] }] });
    const content = JSON.stringify({ root: { type: 'root', children: [
      { type: 'heading', tag: 'h2', children: [text('First'), { type: 'linebreak' }, text('second')] },
      { type: 'table', children: [
        { type: 'tablerow', children: [cell('Header')] },
        { type: 'tablerow', children: [cell('left|right'), cell('extra')] },
      ] },
    ] } });
    editScapeNotes(fixture, (db) => db.prepare('UPDATE notes SET content = ? WHERE id = ?').run(content, LEXICAL_NOTE_ID));

    const first = run();
    const second = run();

    expect(targetRows(`SELECT body_md FROM notes WHERE id = '${LEXICAL_NOTE_ID}'`)).toEqual([
      { body_md: '## First second\n\n| Header |  |\n| --- | --- |\n| left\\|right | extra |' },
    ]);
    expect(first.counts.notes.notConverted).toBe(0);
    expect(second.counts.notes).toMatchObject({ written: 0, updated: 0, conflict: 0, alreadyPresent: 5 });
    expect(readdirSync(scratchRoot)).toEqual([]);
  });
});
