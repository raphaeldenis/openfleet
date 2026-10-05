import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach } from 'vitest';

export const CCM_PROJECT_ID = 'AAAA0001-0000-0000-0000-000000000001';
export const OPENFLEET_PROJECT_ID = 'BBBB0002-0000-0000-0000-000000000002';
export const UNCATEGORIZED_PROJECT_ID = 'CCCC0003-0000-0000-0000-000000000003';
export const SYSTEM_PROJECT_ID = 'DDDD0004-0000-0000-0000-000000000004';
export const MARKDOWN_NOTE_ID = 'N0000001-0000-0000-0000-000000000001';
export const LEXICAL_NOTE_ID = 'N0000002-0000-0000-0000-000000000002';
export const PLAN_NOTE_ID = 'N0000003-0000-0000-0000-000000000003';
export const REPORT_NOTE_ID = 'N0000004-0000-0000-0000-000000000004';
export const OPENFLEET_NOTE_ID = 'N0000005-0000-0000-0000-000000000005';
export const MISLABELED_VERSION_ID = 'ver-mislabeled';
export const EMPTY_LEXICAL_VERSION_ID = 'ver-empty-lexical';
export const BACKLOG_STORE_ID = 'S0000001-0000-0000-0000-000000000001';
export const LOG_STORE_ID = 'S0000002-0000-0000-0000-000000000002';
export const TITLE_COLUMN_ID = 'C0000001-0000-0000-0000-000000000001';
export const STATUS_COLUMN_ID = 'C0000002-0000-0000-0000-000000000002';
export const PRIORITY_COLUMN_ID = 'C0000003-0000-0000-0000-000000000003';
export const DUE_COLUMN_ID = 'C0000004-0000-0000-0000-000000000004';
export const STATUS_TODO_OPTION_ID = 'O0000001-0000-0000-0000-000000000001';
export const STATUS_DONE_OPTION_ID = 'O0000002-0000-0000-0000-000000000002';
export const KANBAN_VIEW_ID = 'V0000001-0000-0000-0000-000000000001';
export const BACKLOG_ROW_ID = 'R0000001-0000-0000-0000-000000000001';

const APPLE_SECONDS = 811_089_628;
const UNIX_SECONDS = 1_790_246_214;
const columnKey = (columnId: string) => `col_${columnId.replaceAll('-', '')}`;
const storeTable = (storeId: string) => `store_${storeId.replaceAll('-', '')}`;

export interface ScapeFixture {
  scapeDir: string;
  workDir: string;
}

const NOTES_SCHEMA = `
  CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, isArchived BOOLEAN NOT NULL DEFAULT 0, createdAt DOUBLE NOT NULL, updatedAt DOUBLE NOT NULL, isSystemProject BOOLEAN NOT NULL DEFAULT 0);
  CREATE TABLE notes (id TEXT PRIMARY KEY, title TEXT NOT NULL DEFAULT '', content TEXT NOT NULL DEFAULT '{}', createdAt DOUBLE NOT NULL, updatedAt DOUBLE NOT NULL, noteNumber INTEGER, contentFormat TEXT NOT NULL DEFAULT 'lexical', isShared INTEGER NOT NULL DEFAULT 0, isArchived INTEGER NOT NULL DEFAULT 0);
  CREATE TABLE note_versions (id TEXT PRIMARY KEY, noteID TEXT NOT NULL, title TEXT NOT NULL, content TEXT NOT NULL, contentFormat TEXT NOT NULL, createdAt DOUBLE NOT NULL, source TEXT NOT NULL);
  CREATE TABLE project_items (id TEXT PRIMARY KEY, projectID TEXT NOT NULL, kind TEXT NOT NULL, noteID TEXT);
  CREATE TABLE data_store_meta (id TEXT PRIMARY KEY, projectID TEXT NOT NULL, displayName TEXT NOT NULL, naturalKeyColumnID TEXT, createdAt REAL NOT NULL, updatedAt REAL NOT NULL);
  CREATE TABLE data_store_column (id TEXT PRIMARY KEY, storeID TEXT NOT NULL, displayName TEXT NOT NULL, columnType TEXT NOT NULL, sortOrder INTEGER NOT NULL DEFAULT 0, options TEXT, format TEXT);
  CREATE TABLE data_store_view (id TEXT PRIMARY KEY, storeID TEXT NOT NULL, name TEXT NOT NULL, viewType TEXT NOT NULL, sortOrder INTEGER NOT NULL DEFAULT 0, config TEXT NOT NULL, createdAt REAL NOT NULL, updatedAt REAL NOT NULL);
`;

const STATUS_OPTIONS = JSON.stringify([
  { id: STATUS_TODO_OPTION_ID, label: 'todo' },
  { id: STATUS_DONE_OPTION_ID, label: 'done' },
]);

const KANBAN_CONFIG = JSON.stringify({
  groupByColumnID: STATUS_COLUMN_ID,
  cardTitleColumnID: TITLE_COLUMN_ID,
  cardFieldColumnIDs: [STATUS_COLUMN_ID, PRIORITY_COLUMN_ID],
  columnOrder: [STATUS_TODO_OPTION_ID, STATUS_DONE_OPTION_ID],
  showUngrouped: true,
});

function seedNotes(db: DatabaseSync): void {
  const insertProject = db.prepare('INSERT INTO projects (id, name, isSystemProject, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?)');
  insertProject.run(CCM_PROJECT_ID, 'ccm-project', 0, '2026-09-14 13:17:40.319', '2026-09-14 13:17:40.319');
  insertProject.run(OPENFLEET_PROJECT_ID, 'OpenFleet', 0, '2026-09-24 10:35:01.519', '2026-09-24 10:35:01.519');
  insertProject.run(UNCATEGORIZED_PROJECT_ID, 'Uncategorized', 0, '2026-09-24 13:57:47.628', '2026-09-24 13:57:47.628');
  insertProject.run(SYSTEM_PROJECT_ID, 'Scape internals', 1, '2026-09-24 13:57:47.628', '2026-09-24 13:57:47.628');

  const lexicalBody = JSON.stringify({ root: { type: 'root', children: [{ type: 'paragraph', children: [{ type: 'text', text: 'lexical hello', format: 0 }] }] } });
  const insertNote = db.prepare('INSERT INTO notes (id, title, content, createdAt, updatedAt, noteNumber, contentFormat, isShared) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  insertNote.run(MARKDOWN_NOTE_ID, 'House rules', '# Rules\n\nbe kind', APPLE_SECONDS, APPLE_SECONDS + 60, 1, 'markdown', 1);
  insertNote.run(LEXICAL_NOTE_ID, 'Mission', lexicalBody, '2026-09-14 13:57:17.173', APPLE_SECONDS + 10, 2, 'lexical', 0);
  insertNote.run(PLAN_NOTE_ID, 'Plan CCM-1234', 'the plan', APPLE_SECONDS, APPLE_SECONDS, 3, 'markdown', 0);
  insertNote.run(REPORT_NOTE_ID, 'Forge report 2026-09-18', 'the report', APPLE_SECONDS, APPLE_SECONDS, 4, 'markdown', 0);
  insertNote.run(OPENFLEET_NOTE_ID, 'Of note', 'of body', APPLE_SECONDS, APPLE_SECONDS, 5, 'markdown', 0);

  const insertItem = db.prepare('INSERT INTO project_items (id, projectID, kind, noteID) VALUES (?, ?, ?, ?)');
  [MARKDOWN_NOTE_ID, LEXICAL_NOTE_ID, PLAN_NOTE_ID, REPORT_NOTE_ID].forEach((noteId) => insertItem.run(`item-${noteId}`, CCM_PROJECT_ID, 'note', noteId));
  insertItem.run(`item-${OPENFLEET_NOTE_ID}`, OPENFLEET_PROJECT_ID, 'note', OPENFLEET_NOTE_ID);

  const insertVersion = db.prepare('INSERT INTO note_versions (id, noteID, title, content, contentFormat, createdAt, source) VALUES (?, ?, ?, ?, ?, ?, ?)');
  insertVersion.run('ver-b', MARKDOWN_NOTE_ID, 'House rules', '# Rules v2', 'markdown', APPLE_SECONDS + 30, 'mcp_append');
  insertVersion.run('ver-a', MARKDOWN_NOTE_ID, 'House rules', '# Rules v1', 'markdown', APPLE_SECONDS + 20, 'user');
  insertVersion.run(MISLABELED_VERSION_ID, PLAN_NOTE_ID, 'Plan CCM-1234', '# Plan as markdown', 'lexical', APPLE_SECONDS + 7, 'user');
  insertVersion.run(EMPTY_LEXICAL_VERSION_ID, PLAN_NOTE_ID, 'Plan CCM-1234', '{}', 'lexical', APPLE_SECONDS + 8, 'user');
  insertVersion.run('ver-lex', LEXICAL_NOTE_ID, 'Mission', lexicalBody, 'lexical', APPLE_SECONDS + 5, 'user');
}

function seedStoreDefinitions(db: DatabaseSync): void {
  const insertStore = db.prepare('INSERT INTO data_store_meta (id, projectID, displayName, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?)');
  insertStore.run(BACKLOG_STORE_ID, CCM_PROJECT_ID, 'backlog', '2026-09-14 14:00:00.000', '2026-09-14 14:00:00.000');
  insertStore.run(LOG_STORE_ID, CCM_PROJECT_ID, 'log', '2026-09-14 14:00:00.000', '2026-09-14 14:00:00.000');

  const insertColumn = db.prepare('INSERT INTO data_store_column (id, storeID, displayName, columnType, sortOrder, options) VALUES (?, ?, ?, ?, ?, ?)');
  insertColumn.run(TITLE_COLUMN_ID, BACKLOG_STORE_ID, 'title', 'text', 0, null);
  insertColumn.run(STATUS_COLUMN_ID, BACKLOG_STORE_ID, 'status', 'text', 1, STATUS_OPTIONS);
  insertColumn.run(PRIORITY_COLUMN_ID, BACKLOG_STORE_ID, 'priority', 'number', 2, null);
  insertColumn.run(DUE_COLUMN_ID, BACKLOG_STORE_ID, 'due', 'date', 3, null);

  db.prepare('INSERT INTO data_store_view (id, storeID, name, viewType, sortOrder, config, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
    KANBAN_VIEW_ID, BACKLOG_STORE_ID, 'Kanban', 'kanban', 0, KANBAN_CONFIG, '2026-09-14 14:00:00.000', '2026-09-14 14:00:00.000',
  );
}

function seedDatastoreFile(path: string): void {
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE row_change_log (seq INTEGER PRIMARY KEY AUTOINCREMENT, storeID TEXT NOT NULL, rowID TEXT NOT NULL, kind TEXT NOT NULL, oldValues TEXT, newValues TEXT, schemaVersion INTEGER NOT NULL, source TEXT NOT NULL, createdAt REAL NOT NULL);
    CREATE TABLE ${storeTable(BACKLOG_STORE_ID)} (row_id TEXT PRIMARY KEY NOT NULL, row_created_at REAL NOT NULL, row_updated_at REAL NOT NULL, ${columnKey(TITLE_COLUMN_ID)} TEXT, ${columnKey(STATUS_COLUMN_ID)} TEXT, ${columnKey(PRIORITY_COLUMN_ID)} REAL, ${columnKey(DUE_COLUMN_ID)} REAL);
    CREATE TABLE ${storeTable(LOG_STORE_ID)} (row_id TEXT PRIMARY KEY NOT NULL, row_created_at REAL NOT NULL, row_updated_at REAL NOT NULL);
  `);
  db.prepare(`INSERT INTO ${storeTable(BACKLOG_STORE_ID)} VALUES (?, ?, ?, ?, ?, ?, ?)`).run(BACKLOG_ROW_ID, UNIX_SECONDS, UNIX_SECONDS + 5, 'first task', STATUS_DONE_OPTION_ID, 1, UNIX_SECONDS + 100);
  db.prepare(`INSERT INTO ${storeTable(BACKLOG_STORE_ID)} VALUES (?, ?, ?, ?, ?, ?, ?)`).run('R0000002-0000-0000-0000-000000000002', UNIX_SECONDS, UNIX_SECONDS, 'second task', null, null, null);
  db.prepare(`INSERT INTO ${storeTable(LOG_STORE_ID)} VALUES (?, ?, ?)`).run('R0000003-0000-0000-0000-000000000003', UNIX_SECONDS, UNIX_SECONDS);

  const insertChange = db.prepare('INSERT INTO row_change_log (storeID, rowID, kind, oldValues, newValues, schemaVersion, source, createdAt) VALUES (?, ?, ?, ?, ?, 1, ?, ?)');
  insertChange.run(BACKLOG_STORE_ID, BACKLOG_ROW_ID, 'insert', null, JSON.stringify({ [columnKey(TITLE_COLUMN_ID)]: 'first task', [columnKey(STATUS_COLUMN_ID)]: STATUS_TODO_OPTION_ID }), 'mcp', UNIX_SECONDS);
  insertChange.run(BACKLOG_STORE_ID, BACKLOG_ROW_ID, 'update', JSON.stringify({ [columnKey(STATUS_COLUMN_ID)]: STATUS_TODO_OPTION_ID }), JSON.stringify({ [columnKey(STATUS_COLUMN_ID)]: STATUS_DONE_OPTION_ID }), 'mcp', UNIX_SECONDS + 5);
  insertChange.run(BACKLOG_STORE_ID, 'R0000009-0000-0000-0000-000000000009', 'delete', JSON.stringify({ [columnKey(TITLE_COLUMN_ID)]: 'gone' }), null, 'mcp', UNIX_SECONDS + 6);
  const unchangedTitle = JSON.stringify({ [columnKey(TITLE_COLUMN_ID)]: 'first task' });
  insertChange.run(BACKLOG_STORE_ID, BACKLOG_ROW_ID, 'update', unchangedTitle, unchangedTitle, 'mcp', UNIX_SECONDS + 7);
  db.close();
}

const withDatabase = (path: string, work: (db: DatabaseSync) => void) => {
  const db = new DatabaseSync(path);
  try {
    work(db);
  } finally {
    db.close();
  }
};

/** Runs statements against the fixture's notes.sqlite (a test changing Scape between two imports). */
export const editScapeNotes = (fixture: ScapeFixture, work: (db: DatabaseSync) => void) => withDatabase(join(fixture.scapeDir, 'notes.sqlite'), work);

/** Runs statements against the fixture's CCM datastore file. */
export const editScapeDatastore = (fixture: ScapeFixture, work: (db: DatabaseSync) => void) =>
  withDatabase(join(fixture.scapeDir, 'datastores', `${CCM_PROJECT_ID}.sqlite`), work);

export const scapeBacklogTable = storeTable(BACKLOG_STORE_ID);
export const scapeTitleCellKey = columnKey(TITLE_COLUMN_ID);

const createdWorkDirs: string[] = [];

// Registered when a test file imports this kit: every fixture a test builds is removed after that test.
afterEach(() => {
  createdWorkDirs.splice(0).forEach((workDir) => rmSync(workDir, { recursive: true, force: true }));
});

/** Builds a synthetic Scape home (notes.sqlite + datastores/*.sqlite) in a fresh temp dir, removed after the test; holds no real Scape content. */
export function buildScapeFixture(): ScapeFixture {
  const workDir = mkdtempSync(join(tmpdir(), 'openfleet-scape-import-'));
  createdWorkDirs.push(workDir);
  const scapeDir = join(workDir, 'scape');
  mkdirSync(join(scapeDir, 'datastores'), { recursive: true });

  const notesDb = new DatabaseSync(join(scapeDir, 'notes.sqlite'));
  notesDb.exec(NOTES_SCHEMA);
  seedNotes(notesDb);
  seedStoreDefinitions(notesDb);
  notesDb.close();

  seedDatastoreFile(join(scapeDir, 'datastores', `${CCM_PROJECT_ID}.sqlite`));
  return { scapeDir, workDir };
}
