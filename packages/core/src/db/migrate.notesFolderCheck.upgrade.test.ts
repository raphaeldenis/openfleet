import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { applyMigrations } from './migrate.js';

const migrationsDirectory = new URL('./migrations/', import.meta.url);

const migrationFileNames = readdirSync(migrationsDirectory).filter((fileName) => fileName.endsWith('.sql')).sort();
const folderCheckMigrationFileName = migrationFileNames.find((fileName) => fileName.endsWith('_notes_folder_check.sql'))!;
const migrationsBeforeFolderCheck = migrationFileNames
  .filter((fileName) => fileName < folderCheckMigrationFileName)
  .map((fileName) => ({ version: fileName.replace(/\.sql$/, ''), sql: readFileSync(new URL(fileName, migrationsDirectory), 'utf8') }));

const insertNote = (db: DatabaseSync, id: string, folder: string | null) => {
  db.prepare(`INSERT INTO notes (id, project_id, title, body_md, folder, created_at, updated_at) VALUES (?, 'p1', ?, 'body', ?, 't0', 't0')`)
    .run(id, `title ${id}`, folder);
};

const openDatabaseHoldingNotesBeforeFolderCheck = () => {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  applyMigrations(db, migrationsBeforeFolderCheck);
  db.prepare(`INSERT INTO projects (id, name, docs_folder_path, created_at) VALUES ('p1', 'Project', '/docs', 't0')`).run();
  insertNote(db, 'in-specs', 'specs');
  insertNote(db, 'in-reports', 'reports');
  insertNote(db, 'unfiled', null);
  insertNote(db, 'in-bogus-folder', 'not-a-folder');
  db.prepare(`INSERT INTO note_versions (id, note_id, rev, body_md, author, created_at) VALUES ('v1', 'in-bogus-folder', 1, 'body', 'a', 't0')`).run();
  applyMigrations(db);
  return db;
};

const folderOf = (db: DatabaseSync, id: string) => (db.prepare('SELECT folder FROM notes WHERE id = ?').get(id) as { folder: string | null }).folder;

describe('the notes folder check migration upgrading a database that already holds notes', () => {
  it('keeps notes with a valid folder or no folder exactly where they are', () => {
    const db = openDatabaseHoldingNotesBeforeFolderCheck();

    expect([folderOf(db, 'in-specs'), folderOf(db, 'in-reports'), folderOf(db, 'unfiled')]).toEqual(['specs', 'reports', null]);
  });

  it('moves a note with an unexpected folder to unfiled instead of refusing the upgrade, keeping the note and its versions', () => {
    const db = openDatabaseHoldingNotesBeforeFolderCheck();

    const versionCount = (db.prepare("SELECT COUNT(*) AS n FROM note_versions WHERE note_id = 'in-bogus-folder'").get() as { n: number }).n;

    expect(folderOf(db, 'in-bogus-folder')).toBeNull();
    expect(versionCount).toBe(1);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });

  it('rejects an insert with an unexpected folder at the database level', () => {
    const db = openDatabaseHoldingNotesBeforeFolderCheck();

    expect(() => insertNote(db, 'new-bogus', 'not-a-folder')).toThrow(/folder/);
  });

  it('rejects moving an existing note to an unexpected folder at the database level', () => {
    const db = openDatabaseHoldingNotesBeforeFolderCheck();

    expect(() => db.prepare("UPDATE notes SET folder = 'not-a-folder' WHERE id = 'in-specs'").run()).toThrow(/folder/);
    expect(folderOf(db, 'in-specs')).toBe('specs');
  });

  it('still accepts every allowed folder and no folder on insert and update', () => {
    const db = openDatabaseHoldingNotesBeforeFolderCheck();

    for (const folder of ['specs', 'plans', 'handoffs', 'reports', null]) {
      insertNote(db, `new-${folder}`, folder);
      db.prepare('UPDATE notes SET folder = ? WHERE id = ?').run(folder, 'unfiled');
    }

    expect(folderOf(db, 'new-handoffs')).toBe('handoffs');
  });
});
