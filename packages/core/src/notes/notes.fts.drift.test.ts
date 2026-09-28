import { describe, expect, it } from 'vitest';
import { openDatabase } from '../db/database.js';

type Db = ReturnType<typeof openDatabase>;

function openDatabaseWithProject(): Db {
  const db = openDatabase(':memory:');
  db.prepare(`INSERT INTO projects (id, name, created_at) VALUES ('p1', 'P', 't0')`).run();
  return db;
}

function insertNote(db: Db, id: string, title: string, body: string, filePath: string | null = null, insertVerb = 'INSERT') {
  db.prepare(
    `${insertVerb} INTO notes (id, project_id, title, body_md, folder, file_path, rev, shared, created_at, updated_at)
     VALUES (?, 'p1', ?, ?, NULL, ?, 1, 0, 't0', 't0')`,
  ).run(id, title, body, filePath);
}

function findNoteIds(db: Db, word: string): string[] {
  const hits = db.prepare(`SELECT note_id FROM note_fts WHERE note_fts MATCH ?`).all(`"${word}"`) as { note_id: string }[];
  return hits.map((hit) => hit.note_id);
}

function countIndexRows(db: Db, noteId: string): number {
  const indexedRows = db.prepare(`SELECT COUNT(*) AS n FROM note_fts WHERE note_id = ?`).get(noteId) as { n: number };
  return indexedRows.n;
}

describe('note_fts follows every kind of write to notes', () => {
  it('reflects a change to the title alone', () => {
    const db = openDatabaseWithProject();
    insertNote(db, 'n1', 'Alpha heading', 'body');

    db.prepare(`UPDATE notes SET title = 'Beta heading' WHERE id = 'n1'`).run();

    expect(findNoteIds(db, 'alpha')).toEqual([]);
    expect(findNoteIds(db, 'beta')).toEqual(['n1']);
  });

  it('follows a note whose id changes', () => {
    const db = openDatabaseWithProject();
    insertNote(db, 'n1', 'T', 'shared-word');

    db.prepare(`UPDATE notes SET id = 'n2' WHERE id = 'n1'`).run();

    expect(countIndexRows(db, 'n1')).toBe(0);
    expect(findNoteIds(db, 'shared-word')).toEqual(['n2']);
  });

  // Known defect: REPLACE deletes the old row without firing notes_fts_ad (recursive_triggers is off),
  // so the old index row survives. Flip to `it` once REPLACE is handled or banned.
  it.fails('leaves one index row with the new body after INSERT OR REPLACE on the same id', () => {
    const db = openDatabaseWithProject();
    insertNote(db, 'n1', 'T', 'oldword');

    insertNote(db, 'n1', 'T', 'newword', null, 'INSERT OR REPLACE');

    expect(findNoteIds(db, 'oldword')).toEqual([]);
    expect(countIndexRows(db, 'n1')).toBe(1);
  });

  it.fails('drops the replaced note from the index when INSERT OR REPLACE evicts it through a file_path conflict', () => {
    const db = openDatabaseWithProject();
    insertNote(db, 'n1', 'T', 'oldword', '/docs/specs/a.md');

    insertNote(db, 'n2', 'T', 'newword', '/docs/specs/a.md', 'INSERT OR REPLACE');

    expect(countIndexRows(db, 'n1')).toBe(0);
  });
});
