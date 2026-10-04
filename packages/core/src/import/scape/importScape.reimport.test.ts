import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { importScape } from './importScape.js';
import {
  BACKLOG_ROW_ID, BACKLOG_STORE_ID, buildScapeFixture, CCM_PROJECT_ID, editScapeDatastore, editScapeNotes, KANBAN_VIEW_ID, LEXICAL_NOTE_ID, MARKDOWN_NOTE_ID,
  OPENFLEET_PROJECT_ID, PRIORITY_COLUMN_ID, scapeBacklogTable, scapeTitleCellKey, STATUS_COLUMN_ID, TITLE_COLUMN_ID, type ScapeFixture,
} from './scapeFixture.testkit.js';

const OPENFLEET_EDIT_TIME = '2030-01-01T00:00:00.000Z';
const sha256OfFile = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');

describe('importScape on a home that already holds an import', () => {
  let fixture: ScapeFixture;
  let home: string;
  let superpowersRoot: string;
  const openConnections: DatabaseSync[] = [];

  const closeOpenConnections = () => openConnections.splice(0).forEach((db) => db.close());
  let scratchRoot: string;
  const run = (overrides: Partial<Parameters<typeof importScape>[0]> = {}) => {
    closeOpenConnections();
    return importScape({ scapeDir: fixture.scapeDir, home, superpowersRoot, scratchRoot, ...overrides });
  };
  const leftInScratchRoot = () => readdirSync(scratchRoot);
  const openTarget = () => {
    const db = new DatabaseSync(join(home, 'openfleet.db'));
    openConnections.push(db);
    return db;
  };
  const rowOf = <T>(sql: string, ...params: string[]) => openTarget().prepare(sql).get(...params) as T;
  const editTarget = (sql: string, ...params: (string | number)[]) => {
    closeOpenConnections();
    const db = new DatabaseSync(join(home, 'openfleet.db'));
    try {
      db.prepare(sql).run(...params);
    } finally {
      db.close();
    }
  };

  beforeEach(() => {
    fixture = buildScapeFixture();
    home = join(fixture.workDir, 'of-home');
    superpowersRoot = join(fixture.workDir, 'superpowers');
    scratchRoot = join(fixture.workDir, 'scratch');
    mkdirSync(join(superpowersRoot, 'openfleet'), { recursive: true });
    mkdirSync(scratchRoot);
  });

  afterEach(closeOpenConnections);

  describe('notes', () => {
    const changeMarkdownNoteInScape = () => editScapeNotes(fixture, (db) => db.prepare(`UPDATE notes SET content = '# Rules changed in Scape' WHERE id = ?`).run(MARKDOWN_NOTE_ID));

    it('never lowers the rev of a note OpenFleet moved forward, and counts the note as a conflict', () => {
      run();
      editTarget('UPDATE notes SET rev = 9 WHERE id = ?', MARKDOWN_NOTE_ID);
      changeMarkdownNoteInScape();

      const report = run();

      const note = rowOf<{ rev: number; body_md: string }>('SELECT rev, body_md FROM notes WHERE id = ?', MARKDOWN_NOTE_ID);
      expect(note).toEqual({ rev: 9, body_md: '# Rules\n\nbe kind' });
      expect(report.counts.notes).toMatchObject({ conflict: 1, updated: 0 });
    });

    it('leaves a note alone when one of its versions was written by someone else than the importer', () => {
      run();
      editTarget(`INSERT INTO note_versions (id, note_id, rev, body_md, author, created_at) VALUES ('edit-1', ?, 4, 'edited', 'human', ?)`, MARKDOWN_NOTE_ID, OPENFLEET_EDIT_TIME);
      changeMarkdownNoteInScape();

      const report = run();

      const note = rowOf<{ body_md: string }>('SELECT body_md FROM notes WHERE id = ?', MARKDOWN_NOTE_ID);
      const versionCount = rowOf<{ n: number }>('SELECT count(*) AS n FROM note_versions WHERE note_id = ?', MARKDOWN_NOTE_ID).n;
      expect(note.body_md).toBe('# Rules\n\nbe kind');
      expect(versionCount).toBe(4);
      expect(report.counts.notes.conflict).toBe(1);
      expect(report.counts.noteVersions.conflict).toBe(3);
    });

    it('updates a note changed only in Scape and replaces the stale current version by the new one', () => {
      run();
      changeMarkdownNoteInScape();
      editScapeNotes(fixture, (db) =>
        db.prepare(`INSERT INTO note_versions (id, noteID, title, content, contentFormat, createdAt, source) VALUES ('ver-c', ?, 'House rules', '# Rules v3', 'markdown', 811089680, 'user')`).run(MARKDOWN_NOTE_ID));

      const report = run();

      const note = rowOf<{ rev: number; body_md: string }>('SELECT rev, body_md FROM notes WHERE id = ?', MARKDOWN_NOTE_ID);
      const versionIds = openTarget().prepare('SELECT id FROM note_versions WHERE note_id = ? ORDER BY rev').all(MARKDOWN_NOTE_ID).map((v) => (v as { id: string }).id);
      expect(note).toEqual({ rev: 4, body_md: '# Rules changed in Scape' });
      expect(versionIds).toEqual(['ver-a', 'ver-b', 'ver-c', `${MARKDOWN_NOTE_ID}@rev4`]);
      expect(report.counts.notes).toMatchObject({ updated: 1, conflict: 0 });
    });
  });

  describe('rows', () => {
    const renameBacklogRowInScape = () =>
      editScapeDatastore(fixture, (db) => db.prepare(`UPDATE ${scapeBacklogTable} SET ${scapeTitleCellKey} = 'renamed in Scape', row_updated_at = row_updated_at + 1000 WHERE row_id = ?`).run(BACKLOG_ROW_ID));
    const titleOfBacklogRow = () => JSON.parse(rowOf<{ data_json: string }>('SELECT data_json FROM ds_rows WHERE id = ?', BACKLOG_ROW_ID).data_json)[TITLE_COLUMN_ID];

    it('keeps a row edited in OpenFleet after the Scape version and counts a conflict', () => {
      run();
      editTarget('UPDATE ds_rows SET data_json = ?, updated_at = ? WHERE id = ?', JSON.stringify({ [TITLE_COLUMN_ID]: 'edited in OpenFleet' }), OPENFLEET_EDIT_TIME, BACKLOG_ROW_ID);
      renameBacklogRowInScape();

      const report = run();

      expect(titleOfBacklogRow()).toBe('edited in OpenFleet');
      expect(report.counts.rows).toMatchObject({ conflict: 1, updated: 0 });
    });

    it('keeps a row that has a history entry written by someone else than the importer', () => {
      run();
      editTarget(
        `INSERT INTO ds_row_history (id, store_id, row_id, actor_kind, actor_label, change_json, created_at) VALUES ('h-of', ?, ?, 'human', 'raphael', '{}', ?)`,
        BACKLOG_STORE_ID, BACKLOG_ROW_ID, OPENFLEET_EDIT_TIME,
      );
      renameBacklogRowInScape();

      const report = run();

      expect(titleOfBacklogRow()).toBe('first task');
      expect(report.counts.rows.conflict).toBe(1);
    });

    it('does not bring back a row deleted in OpenFleet', () => {
      run();
      editTarget('DELETE FROM ds_rows WHERE id = ?', BACKLOG_ROW_ID);
      editTarget(
        `INSERT INTO ds_row_history (id, store_id, row_id, actor_kind, actor_label, change_json, created_at) VALUES ('h-del', ?, ?, 'agent', 'claude', '{"kind":"delete"}', ?)`,
        BACKLOG_STORE_ID, BACKLOG_ROW_ID, OPENFLEET_EDIT_TIME,
      );

      const report = run();

      expect(rowOf<{ n: number }>('SELECT count(*) AS n FROM ds_rows WHERE id = ?', BACKLOG_ROW_ID).n).toBe(0);
      expect(report.counts.rows).toMatchObject({ conflict: 1, written: 0 });
    });
  });

  describe('projects, stores, columns and views', () => {
    it('keeps what OpenFleet changed and counts each as a conflict', () => {
      run();
      editTarget(`UPDATE projects SET docs_folder_path = '/custom/docs' WHERE id = ?`, OPENFLEET_PROJECT_ID);
      editTarget(`UPDATE projects SET name = 'Renamed' WHERE id = ?`, CCM_PROJECT_ID);
      editTarget(`UPDATE data_stores SET display_name = 'Renamed store', updated_at = ? WHERE id = ?`, OPENFLEET_EDIT_TIME, BACKLOG_STORE_ID);
      editTarget(`UPDATE ds_views SET config_json = '{}' WHERE id = ?`, KANBAN_VIEW_ID);
      editTarget(`UPDATE ds_columns SET display_name = 'renamed column' WHERE id = ?`, STATUS_COLUMN_ID);

      const report = run();

      expect(rowOf<{ docs_folder_path: string }>('SELECT docs_folder_path FROM projects WHERE id = ?', OPENFLEET_PROJECT_ID).docs_folder_path).toBe('/custom/docs');
      expect(rowOf<{ name: string }>('SELECT name FROM projects WHERE id = ?', CCM_PROJECT_ID).name).toBe('Renamed');
      expect(rowOf<{ display_name: string }>('SELECT display_name FROM data_stores WHERE id = ?', BACKLOG_STORE_ID).display_name).toBe('Renamed store');
      expect(rowOf<{ config_json: string }>('SELECT config_json FROM ds_views WHERE id = ?', KANBAN_VIEW_ID).config_json).toBe('{}');
      expect(rowOf<{ display_name: string }>('SELECT display_name FROM ds_columns WHERE id = ?', STATUS_COLUMN_ID).display_name).toBe('renamed column');
      expect(report.counts).toMatchObject({
        projects: { conflict: 1, updated: 0 }, dataStores: { conflict: 1 }, views: { conflict: 1 }, columns: { conflict: 1 },
      });
    });
  });

  describe('write phase', () => {
    it('rolls back the notes of the same run when the rows family fails', () => {
      run();
      editTarget(`CREATE TRIGGER refuse_rows BEFORE INSERT ON ds_rows BEGIN SELECT RAISE(ABORT, 'refused'); END`);
      editScapeNotes(fixture, (db) => {
        db.prepare(`INSERT INTO notes (id, title, content, createdAt, updatedAt, contentFormat) VALUES ('N-new', 'Fresh', 'hi', 811089700, 811089700, 'markdown')`).run();
        db.prepare(`INSERT INTO project_items (id, projectID, kind, noteID) VALUES ('item-new', ?, 'note', 'N-new')`).run(CCM_PROJECT_ID);
      });
      editScapeDatastore(fixture, (db) => db.prepare(`INSERT INTO ${scapeBacklogTable} (row_id, row_created_at, row_updated_at) VALUES ('R-new', 1790246300, 1790246300)`).run());

      expect(() => run()).toThrow(expect.objectContaining({ code: 'IMPORT_WRITE_FAILED' }));

      expect(rowOf<{ n: number }>(`SELECT count(*) AS n FROM notes WHERE id = 'N-new'`).n).toBe(0);
    });

    it('refuses to write while another process holds the database', () => {
      run();
      editScapeNotes(fixture, (db) => db.prepare(`UPDATE notes SET content = 'changed' WHERE id = ?`).run(MARKDOWN_NOTE_ID));
      const daemonConnection = new DatabaseSync(join(home, 'openfleet.db'));
      daemonConnection.exec('PRAGMA journal_mode = WAL');
      daemonConnection.prepare('SELECT count(*) FROM notes').get();

      try {
        expect(() => importScape({ scapeDir: fixture.scapeDir, home, superpowersRoot })).toThrow(expect.objectContaining({ code: 'DAEMON_RUNNING' }));
      } finally {
        daemonConnection.close();
      }
    });

    it('still previews the changes with a dry run while another process holds the database', () => {
      run();
      editScapeNotes(fixture, (db) => db.prepare(`UPDATE notes SET content = 'changed' WHERE id = ?`).run(MARKDOWN_NOTE_ID));
      const daemonConnection = new DatabaseSync(join(home, 'openfleet.db'));
      daemonConnection.exec('PRAGMA journal_mode = WAL');
      daemonConnection.prepare('SELECT count(*) FROM notes').get();

      try {
        const report = importScape({ scapeDir: fixture.scapeDir, home, superpowersRoot, dryRun: true });
        expect(report.counts.notes.updated).toBe(1);
      } finally {
        daemonConnection.close();
      }
    });
  });

  describe('backup', () => {
    const backupsOf = () => (existsSync(join(home, 'backups')) ? readdirSync(join(home, 'backups')).filter((name) => name.endsWith('.db')) : []);

    it('is taken before a run that changes an existing database and skipped by a run that changes nothing', () => {
      run();
      expect(backupsOf()).toEqual([]);

      run();
      expect(backupsOf()).toEqual([]);

      editScapeNotes(fixture, (db) => db.prepare(`UPDATE notes SET content = 'changed' WHERE id = ?`).run(LEXICAL_NOTE_ID));
      run();
      expect(backupsOf()).toHaveLength(1);
    });

    it('leaves the database file untouched on a run that changes nothing', () => {
      run();
      const hashBefore = sha256OfFile(join(home, 'openfleet.db'));

      const report = run();

      expect(sha256OfFile(join(home, 'openfleet.db'))).toBe(hashBefore);
      expect(report.counts.notes.written + report.counts.notes.updated).toBe(0);
    });
  });

  describe('backup content', () => {
    it('holds the note body from before the run, so it is taken before the commit and after the begin', () => {
      run();
      editScapeNotes(fixture, (db) => db.prepare(`UPDATE notes SET content = '# Rules changed in Scape' WHERE id = ?`).run(MARKDOWN_NOTE_ID));

      run();

      const backupName = readdirSync(join(home, 'backups')).find((name) => name.endsWith('.db'))!;
      const backup = new DatabaseSync(join(home, 'backups', backupName), { readOnly: true });
      try {
        const old = backup.prepare('SELECT body_md FROM notes WHERE id = ?').get(MARKDOWN_NOTE_ID) as { body_md: string };
        expect(old.body_md).toBe('# Rules\n\nbe kind');
      } finally {
        backup.close();
      }
      expect(rowOf<{ body_md: string }>('SELECT body_md FROM notes WHERE id = ?', MARKDOWN_NOTE_ID).body_md).toBe('# Rules changed in Scape');
    });
  });

  describe('names already taken in OpenFleet', () => {
    const replaceImportedBacklogStoreByAnOpenFleetOne = () => {
      editTarget('DELETE FROM data_stores WHERE id = ?', BACKLOG_STORE_ID);
      editTarget(`INSERT INTO data_stores (id, project_id, display_name, created_at, updated_at) VALUES ('of-store', ?, 'BACKLOG', ?, ?)`, CCM_PROJECT_ID, OPENFLEET_EDIT_TIME, OPENFLEET_EDIT_TIME);
    };

    it('reports a store with a taken name (ignoring case) as a conflict, skips what hangs on it and imports the rest', () => {
      run();
      replaceImportedBacklogStoreByAnOpenFleetOne();

      const report = run();

      expect(report.counts.dataStores.conflict).toBe(1);
      expect(report.counts.columns.conflict).toBe(4);
      expect(report.counts.views.conflict).toBe(1);
      expect(report.counts.rows.conflict).toBe(2);
      expect(report.counts.history.conflict).toBe(3);
      expect(rowOf<{ n: number }>('SELECT count(*) AS n FROM ds_rows WHERE store_id = ?', BACKLOG_STORE_ID).n).toBe(0);
    });

    it('reports a column with a taken name as a conflict and leaves the rows of its store alone', () => {
      run();
      editTarget('DELETE FROM ds_columns WHERE id = ?', PRIORITY_COLUMN_ID);
      editTarget(`INSERT INTO ds_columns (id, store_id, display_name, column_type, sort_order, created_at) VALUES ('of-column', ?, 'PRIORITY', 'text', 9, ?)`, BACKLOG_STORE_ID, OPENFLEET_EDIT_TIME);
      editScapeDatastore(fixture, (db) => db.prepare(`UPDATE ${scapeBacklogTable} SET ${scapeTitleCellKey} = 'renamed in Scape', row_updated_at = row_updated_at + 1000 WHERE row_id = ?`).run(BACKLOG_ROW_ID));

      const report = run();

      const title = JSON.parse(rowOf<{ data_json: string }>('SELECT data_json FROM ds_rows WHERE id = ?', BACKLOG_ROW_ID).data_json)[TITLE_COLUMN_ID];
      expect(report.counts.columns.conflict).toBe(1);
      expect(report.counts.rows).toMatchObject({ conflict: 1, updated: 0 });
      expect(title).toBe('first task');
    });

    it('reports a view with a taken name as a conflict', () => {
      run();
      editTarget('DELETE FROM ds_views WHERE id = ?', KANBAN_VIEW_ID);
      editTarget(`INSERT INTO ds_views (id, store_id, display_name, view_type, config_json, sort_order, created_at) VALUES ('of-view', ?, 'KANBAN', 'grid', '{}', 0, ?)`, BACKLOG_STORE_ID, OPENFLEET_EDIT_TIME);

      const report = run();

      expect(report.counts.views.conflict).toBe(1);
      expect(rowOf<{ n: number }>('SELECT count(*) AS n FROM ds_views').n).toBe(1);
    });
  });

  describe('history of rows left alone', () => {
    const logAnotherUpdateInScape = () =>
      editScapeDatastore(fixture, (db) =>
        db.prepare(`INSERT INTO row_change_log (storeID, rowID, kind, oldValues, newValues, schemaVersion, source, createdAt) VALUES (?, ?, 'update', ?, ?, 1, 'mcp', 1790246400)`).run(
          BACKLOG_STORE_ID, BACKLOG_ROW_ID, JSON.stringify({ [`col_${TITLE_COLUMN_ID.replaceAll('-', '')}`]: 'first task' }), JSON.stringify({ [`col_${TITLE_COLUMN_ID.replaceAll('-', '')}`]: 'again' }),
        ));

    it('imports no history for a row deleted in OpenFleet', () => {
      run();
      editTarget('DELETE FROM ds_rows WHERE id = ?', BACKLOG_ROW_ID);
      editTarget(`INSERT INTO ds_row_history (id, store_id, row_id, actor_kind, actor_label, change_json, created_at) VALUES ('h-del', ?, ?, 'agent', 'claude', '{"kind":"delete"}', ?)`, BACKLOG_STORE_ID, BACKLOG_ROW_ID, OPENFLEET_EDIT_TIME);
      logAnotherUpdateInScape();

      const report = run();

      expect(rowOf<{ n: number }>(`SELECT count(*) AS n FROM ds_row_history WHERE id = ?`, `${BACKLOG_STORE_ID}#5`).n).toBe(0);
      expect(report.counts.history.conflict).toBe(1);
    });

    it('tells the importer prefix from a look-alike actor label by case', () => {
      run();
      editTarget(`INSERT INTO ds_row_history (id, store_id, row_id, actor_kind, actor_label, change_json, created_at) VALUES ('h-fake', ?, ?, 'human', 'SCAPE-IMPORT:me', '{}', ?)`, BACKLOG_STORE_ID, BACKLOG_ROW_ID, OPENFLEET_EDIT_TIME);
      editScapeDatastore(fixture, (db) => db.prepare(`UPDATE ${scapeBacklogTable} SET ${scapeTitleCellKey} = 'renamed in Scape', row_updated_at = row_updated_at + 1000 WHERE row_id = ?`).run(BACKLOG_ROW_ID));

      const report = run();

      expect(report.counts.rows.conflict).toBe(1);
    });
  });

  describe('failures while opening the target', () => {
    it('maps a home that is not a directory to IMPORT_WRITE_FAILED', () => {
      writeFileSync(home, 'not a directory');

      expect(() => run()).toThrow(expect.objectContaining({ code: 'IMPORT_WRITE_FAILED' }));
    });

    it('maps a database file that is not a database to IMPORT_WRITE_FAILED, not to DAEMON_RUNNING', () => {
      mkdirSync(home);
      writeFileSync(join(home, 'openfleet.db'), 'this is not a sqlite file '.repeat(200));

      expect(() => run()).toThrow(expect.objectContaining({ code: 'IMPORT_WRITE_FAILED' }));
    });
  });

  describe('temp folders', () => {
    it.each([
      ['a write run', () => run()],
      ['a dry run', () => run({ dryRun: true })],
      ['an unknown project', () => run({ projectName: 'nope' })],
      ['a missing Scape home', () => run({ scapeDir: join(fixture.workDir, 'absent') })],
    ])('leaves none behind after %s', (_label, work) => {
      try {
        work();
      } catch {
        // the outcome is not what is asserted here
      }

      expect(leftInScratchRoot()).toEqual([]);
    });

    it('leaves none behind when the write fails or the daemon holds the database', () => {
      run();
      editTarget(`CREATE TRIGGER refuse_rows BEFORE INSERT ON ds_rows BEGIN SELECT RAISE(ABORT, 'refused'); END`);
      editScapeDatastore(fixture, (db) => db.prepare(`INSERT INTO ${scapeBacklogTable} (row_id, row_created_at, row_updated_at) VALUES ('R-new', 1790246300, 1790246300)`).run());
      expect(() => run()).toThrow(expect.objectContaining({ code: 'IMPORT_WRITE_FAILED' }));
      expect(leftInScratchRoot()).toEqual([]);

      const daemonConnection = new DatabaseSync(join(home, 'openfleet.db'));
      daemonConnection.exec('PRAGMA journal_mode = WAL');
      daemonConnection.prepare('SELECT count(*) FROM notes').get();
      try {
        expect(() => importScape({ scapeDir: fixture.scapeDir, home, superpowersRoot, scratchRoot })).toThrow(expect.objectContaining({ code: 'DAEMON_RUNNING' }));
      } finally {
        daemonConnection.close();
      }
      expect(leftInScratchRoot()).toEqual([]);
    });
  });

  describe('refusing a re-import', () => {
    it('refuses a real run on a home that already holds imported projects when asked to, and writes nothing', () => {
      run();
      editScapeNotes(fixture, (db) => db.prepare(`UPDATE notes SET content = 'changed' WHERE id = ?`).run(MARKDOWN_NOTE_ID));

      expect(() => run({ refuseReimport: true })).toThrow(expect.objectContaining({ code: 'ALREADY_IMPORTED' }));

      expect(rowOf<{ body_md: string }>('SELECT body_md FROM notes WHERE id = ?', MARKDOWN_NOTE_ID).body_md).toBe('# Rules\n\nbe kind');
    });

    it('still previews with a dry run', () => {
      run();

      expect(run({ refuseReimport: true, dryRun: true }).dryRun).toBe(true);
    });

    it('lets the first import of a virgin home through', () => {
      expect(run({ refuseReimport: true }).counts.projects.written).toBe(2);
    });
  });

  describe('unreadable Scape data', () => {
    it.each([
      ['a view config that is not JSON', (db: DatabaseSync) => db.exec(`UPDATE data_store_view SET config = 'not json'`)],
      ['column options that are not JSON', (db: DatabaseSync) => db.exec(`UPDATE data_store_column SET options = 'nope' WHERE options IS NOT NULL`)],
      ['a lexical document without a root', (db: DatabaseSync) => db.exec(`UPDATE notes SET content = '{"root":1}' WHERE contentFormat = 'lexical'`)],
    ])('refuses %s with SCAPE_SOURCE_UNREADABLE before writing anything', (_label, corrupt) => {
      editScapeNotes(fixture, corrupt);

      expect(() => run()).toThrow(expect.objectContaining({ code: 'SCAPE_SOURCE_UNREADABLE' }));
      expect(existsSync(join(home, 'openfleet.db'))).toBe(false);
    });
  });
});
