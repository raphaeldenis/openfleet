import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DataStoreRepository } from '../../stores/dataStoreRepository.js';
import { DataStoreService } from '../../stores/dataStoreService.js';
import { importScape } from './importScape.js';
import {
  BACKLOG_ROW_ID, BACKLOG_STORE_ID, buildScapeFixture, CCM_PROJECT_ID, DUE_COLUMN_ID, EMPTY_LEXICAL_VERSION_ID, KANBAN_VIEW_ID, LEXICAL_NOTE_ID, MARKDOWN_NOTE_ID, MISLABELED_VERSION_ID, OPENFLEET_NOTE_ID,
  OPENFLEET_PROJECT_ID, PLAN_NOTE_ID, PRIORITY_COLUMN_ID, REPORT_NOTE_ID, STATUS_COLUMN_ID, STATUS_DONE_OPTION_ID, STATUS_TODO_OPTION_ID, TITLE_COLUMN_ID,
  SYSTEM_PROJECT_ID, UNCATEGORIZED_PROJECT_ID, type ScapeFixture,
} from './scapeFixture.testkit.js';

const sha256OfFile = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');
const countOf = (db: DatabaseSync, table: string) => (db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;
const rowsOf = <T>(db: DatabaseSync, sql: string, ...params: string[]) => db.prepare(sql).all(...params) as T[];

const TABLES = ['projects', 'notes', 'note_versions', 'data_stores', 'ds_columns', 'ds_views', 'ds_rows', 'ds_row_history'];
const snapshotCounts = (db: DatabaseSync) => Object.fromEntries(TABLES.map((table) => [table, countOf(db, table)]));

describe('importScape', () => {
  let fixture: ScapeFixture;
  let home: string;
  let superpowersRoot: string;
  const openConnections: DatabaseSync[] = [];
  const openTarget = () => {
    const db = new DatabaseSync(join(home, 'openfleet.db'));
    openConnections.push(db);
    return db;
  };

  const closeOpenConnections = () => openConnections.splice(0).forEach((db) => db.close());

  afterEach(closeOpenConnections);

  // An open connection stands for a running daemon, which the importer refuses: a test reads, then runs again.
  const run = (overrides: Partial<Parameters<typeof importScape>[0]> = {}) => {
    closeOpenConnections();
    return importScape({ scapeDir: fixture.scapeDir, home, superpowersRoot, ...overrides });
  };

  beforeEach(() => {
    fixture = buildScapeFixture();
    home = join(fixture.workDir, 'of-home');
    superpowersRoot = join(fixture.workDir, 'superpowers');
    mkdirSync(join(superpowersRoot, 'openfleet'), { recursive: true });
  });

  describe('projects', () => {
    it('imports the real projects under their Scape id and ignores Uncategorized by name and system projects by flag', () => {
      run();

      const db = openTarget();
      const ids = rowsOf<{ id: string; name: string }>(db, 'SELECT id, name FROM projects ORDER BY name').map((project) => project.id);
      expect(ids.sort()).toEqual([CCM_PROJECT_ID, OPENFLEET_PROJECT_ID].sort());
      expect(ids).not.toContain(UNCATEGORIZED_PROJECT_ID);
      expect(ids).not.toContain(SYSTEM_PROJECT_ID);
    });

    it('resolves docs_folder_path against existing directories only and reports the projects left without one', () => {
      const report = run();

      const db = openTarget();
      const docsPaths = Object.fromEntries(rowsOf<{ id: string; docs_folder_path: string | null }>(db, 'SELECT id, docs_folder_path FROM projects').map((p) => [p.id, p.docs_folder_path]));
      expect(docsPaths[OPENFLEET_PROJECT_ID]).toBe(join(superpowersRoot, 'openfleet'));
      expect(docsPaths[CCM_PROJECT_ID]).toBeNull();
      expect(report.projectsWithoutDocsFolder).toEqual(['ccm-project']);
      expect(existsSync(join(superpowersRoot, 'ccm-project'))).toBe(false);
    });

    it('imports a single project selected by name', () => {
      const report = run({ projectName: 'OPENFLEET' });

      const db = openTarget();
      expect(rowsOf<{ id: string }>(db, 'SELECT id FROM projects').map((p) => p.id)).toEqual([OPENFLEET_PROJECT_ID]);
      expect(rowsOf<{ id: string }>(db, 'SELECT id FROM notes').map((n) => n.id)).toEqual([OPENFLEET_NOTE_ID]);
      expect(report.counts.dataStores.expected).toBe(0);
    });

    it('refuses an unknown project name with UNKNOWN_PROJECT', () => {
      expect(() => run({ projectName: 'nope' })).toThrow(expect.objectContaining({ code: 'UNKNOWN_PROJECT' }));
    });
  });

  describe('notes', () => {
    it('keeps a markdown note as is and converts a lexical one', () => {
      run();

      const db = openTarget();
      const bodies = Object.fromEntries(rowsOf<{ id: string; body_md: string }>(db, 'SELECT id, body_md FROM notes').map((n) => [n.id, n.body_md]));
      expect(bodies[MARKDOWN_NOTE_ID]).toBe('# Rules\n\nbe kind');
      expect(bodies[LEXICAL_NOTE_ID]).toBe('lexical hello');
    });

    it('files plans and forge reports, leaves the others unfiled and keeps the Scape shared flag', () => {
      run();

      const db = openTarget();
      const notes = Object.fromEntries(rowsOf<{ id: string; folder: string | null; shared: number }>(db, 'SELECT id, folder, shared FROM notes').map((n) => [n.id, n]));
      expect(notes[PLAN_NOTE_ID]?.folder).toBe('plans');
      expect(notes[REPORT_NOTE_ID]?.folder).toBe('reports');
      expect(notes[MARKDOWN_NOTE_ID]?.folder).toBeNull();
      expect([notes[MARKDOWN_NOTE_ID]?.shared, notes[PLAN_NOTE_ID]?.shared]).toEqual([1, 0]);
    });

    it('sets rev to the number of versions plus one and ISO dates from both Scape date formats', () => {
      run();

      const db = openTarget();
      const markdown = db.prepare('SELECT rev, created_at, updated_at FROM notes WHERE id = ?').get(MARKDOWN_NOTE_ID) as { rev: number; created_at: string; updated_at: string };
      const lexical = db.prepare('SELECT rev, created_at FROM notes WHERE id = ?').get(LEXICAL_NOTE_ID) as { rev: number; created_at: string };
      expect(markdown).toEqual({ rev: 3, created_at: '2026-09-14T14:40:28.000Z', updated_at: '2026-09-14T14:41:28.000Z' });
      expect(lexical).toEqual({ rev: 2, created_at: '2026-09-14T13:57:17.173Z' });
    });

    it('imports the versions with a rev increasing by creation date, then the current body as the version of the note rev', () => {
      run();

      const db = openTarget();
      const versions = rowsOf<{ id: string; rev: number; body_md: string; author: string; change_summary: string }>(
        db, 'SELECT id, rev, body_md, author, change_summary FROM note_versions WHERE note_id = ? ORDER BY rev', MARKDOWN_NOTE_ID,
      );
      expect(versions).toEqual([
        { id: 'ver-a', rev: 1, body_md: '# Rules v1', author: 'scape-import', change_summary: 'user' },
        { id: 'ver-b', rev: 2, body_md: '# Rules v2', author: 'scape-import', change_summary: 'mcp_append' },
        { id: `${MARKDOWN_NOTE_ID}@rev3`, rev: 3, body_md: '# Rules\n\nbe kind', author: 'scape-import', change_summary: 'current' },
      ]);
    });

    it('gives a note without any Scape version the rev 1 and a version holding its body', () => {
      run();

      const db = openTarget();
      const note = db.prepare('SELECT rev FROM notes WHERE id = ?').get(OPENFLEET_NOTE_ID) as { rev: number };
      const versions = rowsOf<{ id: string; rev: number; body_md: string }>(db, 'SELECT id, rev, body_md FROM note_versions WHERE note_id = ?', OPENFLEET_NOTE_ID);
      expect(note.rev).toBe(1);
      expect(versions).toEqual([{ id: `${OPENFLEET_NOTE_ID}@rev1`, rev: 1, body_md: 'of body' }]);
    });

    it('keeps as markdown a version labelled lexical whose content is not a lexical document', () => {
      const report = run();

      const version = openTarget().prepare('SELECT body_md FROM note_versions WHERE id = ?').get(MISLABELED_VERSION_ID) as { body_md: string };
      expect(version.body_md).toBe('# Plan as markdown');
      expect(report.counts.noteVersions.notConverted).toBe(0);
    });

    it('imports the empty lexical document as an empty body', () => {
      run();

      const version = openTarget().prepare('SELECT body_md FROM note_versions WHERE id = ?').get(EMPTY_LEXICAL_VERSION_ID) as { body_md: string };
      expect(version.body_md).toBe('');
    });

    it('indexes the imported notes in the full-text search', () => {
      run();

      const hits = rowsOf<{ note_id: string }>(openTarget(), `SELECT note_id FROM note_fts WHERE note_fts MATCH 'kind'`);
      expect(hits.map((hit) => hit.note_id)).toEqual([MARKDOWN_NOTE_ID]);
    });
  });

  describe('data stores', () => {
    it('turns a text column with options into a select column and keeps the other types', () => {
      run();

      const db = openTarget();
      const columns = Object.fromEntries(
        rowsOf<{ id: string; column_type: string; options_json: string | null }>(db, 'SELECT id, column_type, options_json FROM ds_columns WHERE store_id = ?', BACKLOG_STORE_ID).map((c) => [c.id, c]),
      );
      expect(columns[TITLE_COLUMN_ID]?.column_type).toBe('text');
      expect(columns[STATUS_COLUMN_ID]?.column_type).toBe('select');
      expect(JSON.parse(columns[STATUS_COLUMN_ID]!.options_json!)).toEqual([
        { id: STATUS_TODO_OPTION_ID, label: 'todo' },
        { id: STATUS_DONE_OPTION_ID, label: 'done' },
      ]);
      expect(columns[PRIORITY_COLUMN_ID]?.column_type).toBe('number');
      expect(columns[DUE_COLUMN_ID]?.column_type).toBe('date');
    });

    it('remaps the complete kanban view onto the OpenFleet config', () => {
      const report = run();

      const view = openTarget().prepare('SELECT view_type, display_name, config_json FROM ds_views WHERE id = ?').get(KANBAN_VIEW_ID) as { view_type: string; display_name: string; config_json: string };
      expect(view.view_type).toBe('kanban');
      expect(JSON.parse(view.config_json)).toEqual({ groupByColumnId: STATUS_COLUMN_ID, cardTitleColumnId: TITLE_COLUMN_ID, cardFields: [STATUS_COLUMN_ID, PRIORITY_COLUMN_ID], columnOrder: [STATUS_TODO_OPTION_ID, STATUS_DONE_OPTION_ID], showUngrouped: true });
      expect(report.counts.views).toMatchObject({ expected: 1, written: 1, notConverted: 0 });
    });

    it('renders the imported kanban through the OpenFleet data store service with the rows in their option buckets', () => {
      run();
      const db = openTarget();
      const service = new DataStoreService({ repo: new DataStoreRepository(db), db, clock: () => '2026-10-04T00:00:00.000Z', newId: () => 'unused' });

      const groups = service.kanbanGroups(KANBAN_VIEW_ID, { projectId: CCM_PROJECT_ID });

      expect(groups.map((group) => [group.option.label, group.rows.map((row) => row.id)])).toEqual([['todo', []], ['done', [BACKLOG_ROW_ID]], ['No value', ['R0000002-0000-0000-0000-000000000002']]]);
    });

    it('imports rows keyed by column id with ISO dates, option ids kept and empty cells left out', () => {
      run();

      const rows = Object.fromEntries(rowsOf<{ id: string; data_json: string; created_at: string }>(openTarget(), 'SELECT id, data_json, created_at FROM ds_rows WHERE store_id = ?', BACKLOG_STORE_ID).map((r) => [r.id, r]));
      expect(JSON.parse(rows[BACKLOG_ROW_ID]!.data_json)).toEqual({
        [TITLE_COLUMN_ID]: 'first task',
        [STATUS_COLUMN_ID]: STATUS_DONE_OPTION_ID,
        [PRIORITY_COLUMN_ID]: 1,
        [DUE_COLUMN_ID]: '2026-09-24T10:38:34.000Z',
      });
      expect(rows[BACKLOG_ROW_ID]!.created_at).toBe('2026-09-24T10:36:54.000Z');
      expect(JSON.parse(rows['R0000002-0000-0000-0000-000000000002']!.data_json)).toEqual({ [TITLE_COLUMN_ID]: 'second task' });
    });

    it('imports the change log as agent history with deterministic ids', () => {
      run();

      const history = rowsOf<{ id: string; row_id: string; actor_kind: string; actor_label: string; change_json: string }>(
        openTarget(), 'SELECT id, row_id, actor_kind, actor_label, change_json FROM ds_row_history WHERE store_id = ? ORDER BY id', BACKLOG_STORE_ID,
      );
      expect(history.map((entry) => [entry.id, entry.actor_kind, entry.actor_label, JSON.parse(entry.change_json)])).toEqual([
        [`${BACKLOG_STORE_ID}#1`, 'agent', 'scape-import:mcp', { kind: 'create' }],
        [`${BACKLOG_STORE_ID}#2`, 'agent', 'scape-import:mcp', { [STATUS_COLUMN_ID]: { from: STATUS_TODO_OPTION_ID, to: STATUS_DONE_OPTION_ID } }],
        [`${BACKLOG_STORE_ID}#3`, 'agent', 'scape-import:mcp', { kind: 'delete' }],
      ]);
    });
  });

  describe('change log entries that changed nothing', () => {
    it('are left out of the history and counted as not converted', () => {
      const report = run();

      expect(report.counts.history).toMatchObject({ expected: 4, written: 3, notConverted: 1 });
      const emptyChanges = rowsOf<{ id: string }>(openTarget(), `SELECT id FROM ds_row_history WHERE change_json = '{}'`);
      expect(emptyChanges).toEqual([]);
    });
  });

  describe('idempotence', () => {
    it('writes nothing on a second run and leaves every table count unchanged', () => {
      const first = run();
      const countsAfterFirstRun = snapshotCounts(openTarget());

      const second = run();

      expect(snapshotCounts(openTarget())).toEqual(countsAfterFirstRun);
      expect(first.counts.rows.written).toBe(2 + 1);
      Object.values(second.counts).forEach((counts) => expect(counts).toMatchObject({ written: 0, updated: 0, conflict: 0 }));
      expect(second.counts.notes.alreadyPresent).toBe(second.counts.notes.expected);
    });

    it('updates a row that changed in Scape and reports it as updated, not written', () => {
      run();
      const datastore = new DatabaseSync(join(fixture.scapeDir, 'datastores', `${CCM_PROJECT_ID}.sqlite`));
      datastore.prepare(`UPDATE store_${BACKLOG_STORE_ID.replaceAll('-', '')} SET col_${TITLE_COLUMN_ID.replaceAll('-', '')} = 'renamed' WHERE row_id = ?`).run(BACKLOG_ROW_ID);
      datastore.close();

      const report = run();

      expect(report.counts.rows).toMatchObject({ written: 0, updated: 1 });
      const data = openTarget().prepare('SELECT data_json FROM ds_rows WHERE id = ?').get(BACKLOG_ROW_ID) as { data_json: string };
      expect(JSON.parse(data.data_json)[TITLE_COLUMN_ID]).toBe('renamed');
    });

    it('writes only what is new when a note appears in Scape between two runs', () => {
      run();
      const notes = new DatabaseSync(join(fixture.scapeDir, 'notes.sqlite'));
      notes.prepare(`INSERT INTO notes (id, title, content, createdAt, updatedAt, contentFormat) VALUES ('N-new', 'Fresh', 'hi', 811089700, 811089700, 'markdown')`).run();
      notes.prepare(`INSERT INTO project_items (id, projectID, kind, noteID) VALUES ('item-new', '${CCM_PROJECT_ID}', 'note', 'N-new')`).run();
      notes.close();

      const report = run();

      expect(report.counts.notes).toMatchObject({ expected: 6, written: 1, alreadyPresent: 5 });
    });
  });

  describe('dry run', () => {
    it('leaves the target database byte for byte unchanged while reporting what it would write', () => {
      run();
      const notes = new DatabaseSync(join(fixture.scapeDir, 'notes.sqlite'));
      notes.prepare(`INSERT INTO notes (id, title, content, createdAt, updatedAt, contentFormat) VALUES ('N-new', 'Fresh', 'hi', 811089700, 811089700, 'markdown')`).run();
      notes.prepare(`INSERT INTO project_items (id, projectID, kind, noteID) VALUES ('item-new', '${CCM_PROJECT_ID}', 'note', 'N-new')`).run();
      notes.close();
      const hashBefore = sha256OfFile(join(home, 'openfleet.db'));
      const filesBefore = readdirSync(home).sort();

      const report = run({ dryRun: true });

      expect(sha256OfFile(join(home, 'openfleet.db'))).toBe(hashBefore);
      expect(readdirSync(home).sort()).toEqual(filesBefore);
      expect(report.dryRun).toBe(true);
      expect(report.counts.notes).toMatchObject({ written: 1 });
    });

    it('creates no database and no report in a home that does not exist yet', () => {
      const report = run({ dryRun: true });

      expect(existsSync(home)).toBe(false);
      expect(report.counts.rows.written).toBe(3);
      expect(report.reportPath).toBeUndefined();
    });
  });

  describe('sources', () => {
    it('never modifies the Scape files', () => {
      const scapeFiles = [join(fixture.scapeDir, 'notes.sqlite'), join(fixture.scapeDir, 'datastores', `${CCM_PROJECT_ID}.sqlite`)];
      const hashesBefore = scapeFiles.map(sha256OfFile);

      run();
      run({ dryRun: true });

      expect(scapeFiles.map(sha256OfFile)).toEqual(hashesBefore);
      expect(readdirSync(join(fixture.scapeDir, 'datastores')).sort()).toEqual([`${CCM_PROJECT_ID}.sqlite`]);
    });

    it('refuses a Scape directory without notes.sqlite with SCAPE_SOURCE_MISSING', () => {
      expect(() => run({ scapeDir: join(fixture.workDir, 'absent') })).toThrow(expect.objectContaining({ code: 'SCAPE_SOURCE_MISSING' }));
      expect(existsSync(home)).toBe(false);
    });
  });

  describe('report', () => {
    it('writes import-report.md in the home with expected, written, already present and not converted per entity', () => {
      const report = run();

      expect(report.reportPath).toBe(join(home, 'import-report.md'));
      const markdown = readFileSync(report.reportPath!, 'utf8');
      expect(markdown).toContain('| notes | 5 | 5 | 0 | 0 | 0 | 0 | 0 | 0 |');
      expect(markdown).toContain('| views | 1 | 1 | 0 | 0 | 0 | 0 | 0 | 0 |');
      expect(markdown).toContain('ccm-project');
    });

    it('writes the report in the requested report directory instead of the home', () => {
      const reportDir = join(fixture.workDir, 'docs');
      mkdirSync(reportDir);

      const report = run({ reportDir });

      expect(report.reportPath).toBe(join(reportDir, 'import-report.md'));
      expect(existsSync(join(home, 'import-report.md'))).toBe(false);
    });
  });
});
