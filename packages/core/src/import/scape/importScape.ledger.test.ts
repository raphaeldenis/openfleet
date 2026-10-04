import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { beforeEach, describe, expect, it } from 'vitest';
import { ENTITY_NAMES } from './importReport.js';
import { importScape } from './importScape.js';
import {
  BACKLOG_ROW_ID, BACKLOG_STORE_ID, buildScapeFixture, CCM_PROJECT_ID, editScapeDatastore, editScapeNotes, KANBAN_VIEW_ID, MARKDOWN_NOTE_ID,
  PRIORITY_COLUMN_ID, scapeBacklogTable, scapeTitleCellKey, STATUS_COLUMN_ID, STATUS_DONE_OPTION_ID, STATUS_TODO_OPTION_ID, TITLE_COLUMN_ID, type ScapeFixture,
} from './scapeFixture.testkit.js';

const OPENFLEET_EDIT_TIME = '2030-01-01T00:00:00.000Z';
const NEW_OPTION_ID = 'O0000009-0000-0000-0000-000000000009';
const SECOND_BACKLOG_ROW_ID = 'R0000002-0000-0000-0000-000000000002';

describe('importScape re-import against the ledger of the last import', () => {
  let fixture: ScapeFixture;
  let home: string;
  let scratchRoot: string;

  const run = (overrides: Partial<Parameters<typeof importScape>[0]> = {}) =>
    importScape({ scapeDir: fixture.scapeDir, home, superpowersRoot: join(fixture.workDir, 'superpowers'), scratchRoot, ...overrides });

  const withTarget = <T>(work: (db: DatabaseSync) => T): T => {
    const db = new DatabaseSync(join(home, 'openfleet.db'));
    try {
      return work(db);
    } finally {
      db.close();
    }
  };
  const editTarget = (sql: string, ...params: (string | number)[]) => withTarget((db) => db.prepare(sql).run(...params));
  const valueOf = <T>(sql: string, ...params: string[]) => withTarget((db) => db.prepare(sql).get(...params) as T);
  const ledgerCount = () => valueOf<{ n: number }>('SELECT count(*) AS n FROM scape_import_ledger').n;
  const rowData = (rowId: string) => JSON.parse(valueOf<{ data_json: string }>('SELECT data_json FROM ds_rows WHERE id = ?', rowId).data_json) as Record<string, unknown>;
  const statusOptionIds = () =>
    (JSON.parse(valueOf<{ options_json: string }>('SELECT options_json FROM ds_columns WHERE id = ?', STATUS_COLUMN_ID).options_json) as { id: string }[]).map((option) => option.id);

  const changeNoteInScape = () => editScapeNotes(fixture, (db) => db.prepare(`UPDATE notes SET content = '# Rules changed in Scape' WHERE id = ?`).run(MARKDOWN_NOTE_ID));
  const addStatusOptionInScape = () =>
    editScapeNotes(fixture, (db) =>
      db.prepare('UPDATE data_store_column SET options = ? WHERE id = ?').run(
        JSON.stringify([{ id: STATUS_TODO_OPTION_ID, label: 'todo' }, { id: STATUS_DONE_OPTION_ID, label: 'done' }, { id: NEW_OPTION_ID, label: 'blocked' }]), STATUS_COLUMN_ID,
      ));
  const moveSecondRowToNewOptionInScape = () =>
    editScapeDatastore(fixture, (db) => {
      const statusKey = `col_${STATUS_COLUMN_ID.replaceAll('-', '')}`;
      db.prepare(`UPDATE ${scapeBacklogTable} SET ${statusKey} = ?, row_updated_at = row_updated_at + 1000 WHERE row_id = ?`).run(NEW_OPTION_ID, SECOND_BACKLOG_ROW_ID);
    });
  const retitleBacklogRowInScape = () =>
    editScapeDatastore(fixture, (db) => db.prepare(`UPDATE ${scapeBacklogTable} SET ${scapeTitleCellKey} = 'renamed in Scape', row_updated_at = row_updated_at + 1000 WHERE row_id = ?`).run(BACKLOG_ROW_ID));

  beforeEach(() => {
    fixture = buildScapeFixture();
    home = join(fixture.workDir, 'of-home');
    scratchRoot = join(fixture.workDir, 'scratch');
    mkdirSync(scratchRoot);
    mkdirSync(join(fixture.workDir, 'superpowers', 'openfleet'), { recursive: true });
  });

  describe('a second run on an unchanged Scape', () => {
    it('writes, updates and conflicts nothing', () => {
      run();

      const report = run();

      for (const name of ENTITY_NAMES) expect(report.counts[name], name).toMatchObject({ written: 0, updated: 0, conflict: 0, deletedInOpenFleet: 0, removedInScape: 0 });
      expect(report.counts.rows.alreadyPresent).toBe(3);
    });

    it('records one ledger entry per imported entity', () => {
      const report = run();

      const importedCount = ENTITY_NAMES.reduce((sum, name) => sum + report.counts[name].written, 0);
      expect(ledgerCount()).toBeGreaterThanOrEqual(importedCount - report.counts.playbooks.written);
      expect(valueOf<{ n: number }>(`SELECT count(*) AS n FROM scape_import_ledger WHERE kind = 'row'`).n).toBe(3);
    });
  });

  describe('a change made in Scape while OpenFleet left the record alone', () => {
    it('is applied to a note, a store, a column, a view and a row', () => {
      run();
      changeNoteInScape();
      editScapeNotes(fixture, (db) => {
        db.prepare(`UPDATE data_store_meta SET displayName = 'backlog renamed in Scape', updatedAt = '2026-09-20 10:00:00.000' WHERE id = ?`).run(BACKLOG_STORE_ID);
        db.prepare(`UPDATE data_store_view SET name = 'Board' WHERE id = ?`).run(KANBAN_VIEW_ID);
        db.prepare(`UPDATE data_store_column SET sortOrder = 7 WHERE id = ?`).run(PRIORITY_COLUMN_ID);
      });
      retitleBacklogRowInScape();

      const report = run();

      expect(valueOf<{ body_md: string }>('SELECT body_md FROM notes WHERE id = ?', MARKDOWN_NOTE_ID).body_md).toBe('# Rules changed in Scape');
      expect(valueOf<{ display_name: string }>('SELECT display_name FROM data_stores WHERE id = ?', BACKLOG_STORE_ID).display_name).toBe('backlog renamed in Scape');
      expect(valueOf<{ display_name: string }>('SELECT display_name FROM ds_views WHERE id = ?', KANBAN_VIEW_ID).display_name).toBe('Board');
      expect(valueOf<{ sort_order: number }>('SELECT sort_order FROM ds_columns WHERE id = ?', PRIORITY_COLUMN_ID).sort_order).toBe(7);
      expect(rowData(BACKLOG_ROW_ID)[TITLE_COLUMN_ID]).toBe('renamed in Scape');
      expect(report.counts).toMatchObject({ notes: { updated: 1 }, dataStores: { updated: 1 }, views: { updated: 1 }, columns: { updated: 1 }, rows: { updated: 1 } });
      for (const name of ENTITY_NAMES) expect(report.counts[name].conflict, name).toBe(0);
    });

    it('is not applied again by the next run, which finds everything present', () => {
      run();
      changeNoteInScape();
      run();

      const report = run();

      expect(report.counts.notes).toMatchObject({ updated: 0, conflict: 0 });
    });

    it('adopts the stored record of a home imported before the ledger existed, then applies the next Scape change', () => {
      run();
      editTarget('DELETE FROM scape_import_ledger');

      const adoption = run();
      changeNoteInScape();
      const afterAScapeChange = run();

      expect(adoption.counts.notes).toMatchObject({ alreadyPresent: 5, conflict: 0, updated: 0 });
      expect(ledgerCount()).toBeGreaterThan(0);
      expect(afterAScapeChange.counts.notes).toMatchObject({ updated: 1, conflict: 0 });
    });
  });

  describe('a change made in OpenFleet', () => {
    it('keeps a store renamed in OpenFleet even when Scape changed the store too', () => {
      run();
      editTarget(`UPDATE data_stores SET display_name = 'my backlog', updated_at = ? WHERE id = ?`, '2020-01-01T00:00:00.000Z', BACKLOG_STORE_ID);
      editScapeNotes(fixture, (db) => db.prepare(`UPDATE data_store_meta SET displayName = 'renamed in Scape', updatedAt = '2026-09-30 10:00:00.000' WHERE id = ?`).run(BACKLOG_STORE_ID));

      const report = run();

      expect(valueOf<{ display_name: string }>('SELECT display_name FROM data_stores WHERE id = ?', BACKLOG_STORE_ID).display_name).toBe('my backlog');
      expect(report.counts.dataStores).toMatchObject({ conflict: 1, updated: 0 });
    });

    it('does not mistake the update time OpenFleet bumps on a store for an edit of the store', () => {
      run();
      editTarget('UPDATE data_stores SET updated_at = ? WHERE id = ?', OPENFLEET_EDIT_TIME, BACKLOG_STORE_ID);

      const report = run();

      expect(report.counts.dataStores).toMatchObject({ conflict: 0, alreadyPresent: 2 });
    });

    it('keeps a note edited in OpenFleet when Scape changed it too', () => {
      run();
      editTarget(`UPDATE notes SET body_md = 'mine', rev = rev + 1 WHERE id = ?`, MARKDOWN_NOTE_ID);
      changeNoteInScape();

      const report = run();

      expect(valueOf<{ body_md: string }>('SELECT body_md FROM notes WHERE id = ?', MARKDOWN_NOTE_ID).body_md).toBe('mine');
      expect(report.counts.notes).toMatchObject({ conflict: 1, updated: 0 });
    });

    it('keeps a row edited in OpenFleet when Scape changed it too', () => {
      run();
      editTarget('UPDATE ds_rows SET data_json = ? WHERE id = ?', JSON.stringify({ [TITLE_COLUMN_ID]: 'mine' }), BACKLOG_ROW_ID);
      retitleBacklogRowInScape();

      const report = run();

      expect(rowData(BACKLOG_ROW_ID)[TITLE_COLUMN_ID]).toBe('mine');
      expect(report.counts.rows).toMatchObject({ conflict: 1, updated: 0 });
    });
  });

  describe('a record deleted in OpenFleet', () => {
    it('is not brought back: a note, a view and a row are reported as deleted in OpenFleet', () => {
      run();
      editTarget('DELETE FROM notes WHERE id = ?', MARKDOWN_NOTE_ID);
      editTarget('DELETE FROM ds_views WHERE id = ?', KANBAN_VIEW_ID);
      editTarget('DELETE FROM ds_rows WHERE id = ?', SECOND_BACKLOG_ROW_ID);

      const report = run();

      expect(valueOf<{ n: number }>('SELECT count(*) AS n FROM notes WHERE id = ?', MARKDOWN_NOTE_ID).n).toBe(0);
      expect(valueOf<{ n: number }>('SELECT count(*) AS n FROM ds_views').n).toBe(0);
      expect(valueOf<{ n: number }>('SELECT count(*) AS n FROM ds_rows WHERE id = ?', SECOND_BACKLOG_ROW_ID).n).toBe(0);
      expect(report.counts.notes).toMatchObject({ conflict: 1, deletedInOpenFleet: 1, written: 0 });
      expect(report.counts.views).toMatchObject({ conflict: 1, deletedInOpenFleet: 1, written: 0 });
      expect(report.counts.rows).toMatchObject({ conflict: 1, deletedInOpenFleet: 1, written: 0 });
    });

    it('is not brought back when it is a store, and everything that hung on the store is a conflict too', () => {
      run();
      editTarget('DELETE FROM data_stores WHERE id = ?', BACKLOG_STORE_ID);

      const report = run();

      expect(valueOf<{ n: number }>('SELECT count(*) AS n FROM data_stores WHERE id = ?', BACKLOG_STORE_ID).n).toBe(0);
      expect(valueOf<{ n: number }>('SELECT count(*) AS n FROM ds_columns WHERE store_id = ?', BACKLOG_STORE_ID).n).toBe(0);
      expect(report.counts.dataStores).toMatchObject({ conflict: 1, deletedInOpenFleet: 1, written: 0 });
      expect(report.counts.columns).toMatchObject({ conflict: 4, written: 0 });
      expect(report.counts.views).toMatchObject({ conflict: 1, written: 0 });
      expect(report.counts.rows).toMatchObject({ conflict: 2, written: 0 });
      expect(report.counts.history).toMatchObject({ conflict: 3, written: 0 });
    });

    it('keeps a deleted note from being resurrected by a Scape change to it', () => {
      run();
      editTarget('DELETE FROM notes WHERE id = ?', MARKDOWN_NOTE_ID);
      changeNoteInScape();

      run();

      expect(valueOf<{ n: number }>('SELECT count(*) AS n FROM notes WHERE id = ?', MARKDOWN_NOTE_ID).n).toBe(0);
    });
  });

  describe('select options added in Scape', () => {
    it('are synced into the unmodified column before the rows that use them are written', () => {
      run();
      addStatusOptionInScape();
      moveSecondRowToNewOptionInScape();

      const report = run();

      expect(statusOptionIds()).toContain(NEW_OPTION_ID);
      expect(rowData(SECOND_BACKLOG_ROW_ID)[STATUS_COLUMN_ID]).toBe(NEW_OPTION_ID);
      expect(report.counts.columns.updated).toBe(1);
      expect(report.counts.rows).toMatchObject({ updated: 1, conflict: 0 });
    });

    it('are not synced into a column modified in OpenFleet, whose rows that use them are then conflicts', () => {
      run();
      editTarget(`UPDATE ds_columns SET display_name = 'state' WHERE id = ?`, STATUS_COLUMN_ID);
      addStatusOptionInScape();
      moveSecondRowToNewOptionInScape();

      const report = run();

      expect(statusOptionIds()).not.toContain(NEW_OPTION_ID);
      expect(rowData(SECOND_BACKLOG_ROW_ID)[STATUS_COLUMN_ID]).toBeUndefined();
      expect(report.counts.columns.conflict).toBe(1);
      expect(report.counts.rows).toMatchObject({ conflict: 1, updated: 0 });
    });
  });

  describe('a record deleted in Scape', () => {
    it('is reported as removed in Scape and stays in OpenFleet', () => {
      run();
      editScapeNotes(fixture, (db) => db.prepare(`DELETE FROM project_items WHERE noteID = ?`).run(MARKDOWN_NOTE_ID));
      editScapeDatastore(fixture, (db) => db.prepare(`DELETE FROM ${scapeBacklogTable} WHERE row_id = ?`).run(SECOND_BACKLOG_ROW_ID));

      const report = run();

      expect(valueOf<{ n: number }>('SELECT count(*) AS n FROM notes WHERE id = ?', MARKDOWN_NOTE_ID).n).toBe(1);
      expect(valueOf<{ n: number }>('SELECT count(*) AS n FROM ds_rows WHERE id = ?', SECOND_BACKLOG_ROW_ID).n).toBe(1);
      expect(report.counts.notes.removedInScape).toBe(1);
      expect(report.counts.noteVersions.removedInScape).toBe(3);
      expect(report.counts.rows.removedInScape).toBe(1);
      expect(report.counts.notes.conflict).toBe(0);
    });

    it('is reported again by every later run, never forgotten', () => {
      run();
      editScapeNotes(fixture, (db) => db.prepare(`DELETE FROM project_items WHERE noteID = ?`).run(MARKDOWN_NOTE_ID));
      run();

      expect(run().counts.notes.removedInScape).toBe(1);
    });

    it('is not reported by a run limited to another project', () => {
      run();
      editScapeNotes(fixture, (db) => db.prepare(`DELETE FROM project_items WHERE noteID = ?`).run(MARKDOWN_NOTE_ID));

      const report = run({ projectName: 'OpenFleet' });

      expect(report.counts.notes.removedInScape).toBe(0);
    });

    it('does not count the replaced current version of an updated note as removed in Scape', () => {
      run();
      changeNoteInScape();
      editScapeNotes(fixture, (db) =>
        db.prepare(`INSERT INTO note_versions (id, noteID, title, content, contentFormat, createdAt, source) VALUES ('ver-c', ?, 'House rules', '# Rules v3', 'markdown', 811089680, 'user')`).run(MARKDOWN_NOTE_ID));
      run();

      expect(run().counts.noteVersions.removedInScape).toBe(0);
    });
  });

  describe('a dry run', () => {
    it('reports the exact outcome per entity and leaves the ledger untouched', () => {
      run();
      changeNoteInScape();
      editTarget('DELETE FROM ds_rows WHERE id = ?', SECOND_BACKLOG_ROW_ID);
      const ledgerBefore = valueOf<{ hashes: string }>('SELECT group_concat(record_hash) AS hashes FROM scape_import_ledger ORDER BY kind, id').hashes;

      const report = run({ dryRun: true });

      expect(report.counts.notes.updated).toBe(1);
      expect(report.counts.rows.deletedInOpenFleet).toBe(1);
      expect(valueOf<{ hashes: string }>('SELECT group_concat(record_hash) AS hashes FROM scape_import_ledger ORDER BY kind, id').hashes).toBe(ledgerBefore);
    });
  });

  describe('a Scape file that is torn', () => {
    it('is refused with SCAPE_SOURCE_UNREADABLE before anything is written', () => {
      const datastorePath = join(fixture.scapeDir, 'datastores', `${CCM_PROJECT_ID}.sqlite`);
      const bytes = readFileSync(datastorePath);
      bytes.fill(0xff, 4096, 8192);
      writeFileSync(datastorePath, bytes);

      expect(() => run()).toThrow(expect.objectContaining({ code: 'SCAPE_SOURCE_UNREADABLE' }));

      expect(existsSync(join(home, 'openfleet.db'))).toBe(false);
    });
  });

  describe('a run that fails', () => {
    it('leaves no ledger entry of its own behind', () => {
      run();
      const ledgerBefore = ledgerCount();
      editTarget(`CREATE TRIGGER refuse_rows BEFORE INSERT ON ds_rows BEGIN SELECT RAISE(ABORT, 'refused'); END`);
      editScapeNotes(fixture, (db) => {
        db.prepare(`INSERT INTO notes (id, title, content, createdAt, updatedAt, contentFormat) VALUES ('N-new', 'Fresh', 'hi', 811089700, 811089700, 'markdown')`).run();
        db.prepare(`INSERT INTO project_items (id, projectID, kind, noteID) VALUES ('item-new', ?, 'note', 'N-new')`).run(CCM_PROJECT_ID);
      });
      editScapeDatastore(fixture, (db) => db.prepare(`INSERT INTO ${scapeBacklogTable} (row_id, row_created_at, row_updated_at) VALUES ('R-new', 1790246300, 1790246300)`).run());

      expect(() => run()).toThrow(expect.objectContaining({ code: 'IMPORT_WRITE_FAILED' }));

      expect(ledgerCount()).toBe(ledgerBefore);
    });
  });
});
