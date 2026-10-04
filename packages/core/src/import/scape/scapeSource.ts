import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ScapeImportError } from './scapeImportError.js';
import { snapshotSqliteDatabase } from './sqliteSnapshot.js';

const NOTES_DATABASE_NAME = 'notes.sqlite';
const DATASTORES_FOLDER_NAME = 'datastores';

export interface ScapeProject { id: string; name: string; createdAt: unknown }
export interface ScapeNote { id: string; projectId: string; title: string; content: string; contentFormat: string; createdAt: unknown; updatedAt: unknown; isShared: boolean }
export interface ScapeNoteVersion { id: string; noteId: string; content: string; contentFormat: string; createdAt: number; source: string }
export interface ScapeStore { id: string; projectId: string; displayName: string; createdAt: unknown; updatedAt: unknown }
export interface ScapeColumn { id: string; storeId: string; displayName: string; columnType: string; sortOrder: number; options: string | null }
export interface ScapeView { id: string; storeId: string; name: string; viewType: string; sortOrder: number; config: string; createdAt: unknown }
export interface ScapeRow { id: string; createdAt: number; updatedAt: number; cells: Record<string, unknown> }
export interface ScapeRowChange { seq: number; storeId: string; rowId: string; kind: 'insert' | 'update' | 'delete'; oldValues: string | null; newValues: string | null; source: string; createdAt: number }

const CELL_KEY_PREFIX = 'col_';
const ROW_BOOKKEEPING_COLUMNS = new Set(['row_id', 'row_created_at', 'row_updated_at', 'ck_system_fields']);

const withoutHyphens = (id: string) => id.replaceAll('-', '');
const storeTableName = (storeId: string) => `store_${withoutHyphens(storeId)}`;

/** The key a cell of a Scape datastore file carries for a column id. */
export const cellKeyOf = (columnId: string) => `${CELL_KEY_PREFIX}${withoutHyphens(columnId)}`;

/**
 * Reads a snapshot of a Scape home: each database is copied once to a temp folder and read there, so the
 * Scape files are never opened for writing, no file appears beside them, and the rows and the change log
 * of a store come from the same moment.
 */
export class ScapeSource {
  private readonly scratchDir = mkdtempSync(join(tmpdir(), 'openfleet-scape-snapshot-'));
  private readonly notesDb: DatabaseSync;
  private readonly datastoreDbs = new Map<string, DatabaseSync | null>();

  constructor(private readonly scapeDir: string) {
    const notesPath = join(scapeDir, NOTES_DATABASE_NAME);
    if (!existsSync(notesPath)) {
      this.close();
      throw new ScapeImportError({ code: 'SCAPE_SOURCE_MISSING', message: `no ${NOTES_DATABASE_NAME} in ${scapeDir}` });
    }
    try {
      this.notesDb = this.openSnapshotOf(notesPath);
    } catch (cause) {
      this.close();
      throw cause;
    }
  }

  close(): void {
    this.notesDb?.close();
    this.datastoreDbs.forEach((db) => db?.close());
    rmSync(this.scratchDir, { recursive: true, force: true });
  }

  projects(): ScapeProject[] {
    return this.query(`SELECT id, name, createdAt FROM projects WHERE isSystemProject = 0 AND name <> 'Uncategorized' ORDER BY name`) as unknown as ScapeProject[];
  }

  notesOf(projectId: string): ScapeNote[] {
    const rows = this.query(
      `SELECT n.id, i.projectID AS projectId, n.title, n.content, n.contentFormat, n.createdAt, n.updatedAt, n.isShared
         FROM project_items i JOIN notes n ON n.id = i.noteID WHERE i.kind = 'note' AND i.projectID = ? ORDER BY n.noteNumber, n.id`,
      projectId,
    );
    return rows.map((row) => ({ ...row, isShared: row.isShared === 1 })) as unknown as ScapeNote[];
  }

  versionsOf(noteId: string): ScapeNoteVersion[] {
    return this.query(`SELECT id, noteID AS noteId, content, contentFormat, createdAt, source FROM note_versions WHERE noteID = ? ORDER BY createdAt, id`, noteId) as unknown as ScapeNoteVersion[];
  }

  storesOf(projectId: string): ScapeStore[] {
    return this.query(`SELECT id, projectID AS projectId, displayName, createdAt, updatedAt FROM data_store_meta WHERE projectID = ? ORDER BY displayName`, projectId) as unknown as ScapeStore[];
  }

  columnsOf(storeId: string): ScapeColumn[] {
    return this.query(`SELECT id, storeID AS storeId, displayName, columnType, sortOrder, options FROM data_store_column WHERE storeID = ? ORDER BY sortOrder, id`, storeId) as unknown as ScapeColumn[];
  }

  viewsOf(storeId: string): ScapeView[] {
    return this.query(`SELECT id, storeID AS storeId, name, viewType, sortOrder, config, createdAt FROM data_store_view WHERE storeID = ? ORDER BY sortOrder, id`, storeId) as unknown as ScapeView[];
  }

  rowsOf(store: { id: string; projectId: string }): ScapeRow[] {
    const datastore = this.datastoreOf(store.projectId);
    const hasTable = datastore?.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(storeTableName(store.id)) !== undefined;
    if (!datastore || !hasTable) return [];
    const rawRows = datastore.prepare(`SELECT * FROM "${storeTableName(store.id)}" ORDER BY row_created_at, row_id`).all() as Record<string, unknown>[];
    return rawRows.map((raw) => ({
      id: raw.row_id as string,
      createdAt: raw.row_created_at as number,
      updatedAt: raw.row_updated_at as number,
      cells: Object.fromEntries(Object.entries(raw).filter(([key]) => !ROW_BOOKKEEPING_COLUMNS.has(key))),
    }));
  }

  changesOf(store: { id: string; projectId: string }): ScapeRowChange[] {
    const datastore = this.datastoreOf(store.projectId);
    if (!datastore) return [];
    return datastore
      .prepare(`SELECT seq, storeID AS storeId, rowID AS rowId, kind, oldValues, newValues, source, createdAt FROM row_change_log WHERE storeID = ? ORDER BY seq`)
      .all(store.id) as unknown as ScapeRowChange[];
  }

  private datastoreOf(projectId: string): DatabaseSync | null {
    if (this.datastoreDbs.has(projectId)) return this.datastoreDbs.get(projectId) ?? null;
    const path = join(this.scapeDir, DATASTORES_FOLDER_NAME, `${projectId}.sqlite`);
    const db = existsSync(path) ? this.openSnapshotOf(path) : null;
    this.datastoreDbs.set(projectId, db);
    return db;
  }

  private openSnapshotOf(sourcePath: string): DatabaseSync {
    const targetPath = join(this.scratchDir, `${this.datastoreDbs.size}-${basename(sourcePath)}`);
    try {
      snapshotSqliteDatabase({ sourcePath, targetPath });
      return new DatabaseSync(targetPath);
    } catch (cause) {
      throw new ScapeImportError({ code: 'SCAPE_SOURCE_UNREADABLE', message: `cannot snapshot ${sourcePath}: ${(cause as Error).message}`, cause });
    }
  }

  private query(sql: string, ...params: string[]): Record<string, unknown>[] {
    try {
      return this.notesDb.prepare(sql).all(...params) as Record<string, unknown>[];
    } catch (cause) {
      throw new ScapeImportError({ code: 'SCAPE_SOURCE_UNREADABLE', message: `cannot read ${NOTES_DATABASE_NAME}: ${(cause as Error).message}`, cause });
    }
  }
}
