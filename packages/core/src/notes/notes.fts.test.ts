import { describe, expect, it } from 'vitest';
import { openDatabase } from '../db/database.js';

type Db = ReturnType<typeof openDatabase>;

function openDatabaseWithProject(): Db {
  const db = openDatabase(':memory:');
  db.prepare(`INSERT INTO projects (id, name, created_at) VALUES ('p1', 'P', 't0')`).run();
  return db;
}

function insertNote(db: Db, id: string, title: string, body: string, filePath: string | null = null) {
  db.prepare(
    `INSERT INTO notes (id, project_id, title, body_md, folder, file_path, rev, shared, created_at, updated_at)
     VALUES (?, 'p1', ?, ?, NULL, ?, 1, 0, 't0', 't0')`,
  ).run(id, title, body, filePath);
}

function insertVersion(db: Db, id: string, noteId: string, rev: number) {
  db.prepare(
    `INSERT INTO note_versions (id, note_id, rev, body_md, author, change_summary, created_at)
     VALUES (?, ?, ?, 'body', 'tester', NULL, 't0')`,
  ).run(id, noteId, rev);
}

function findNoteIds(db: Db, phrase: string): string[] {
  const quotedPhrase = `"${phrase}"`;
  const hits = db.prepare(`SELECT note_id FROM note_fts WHERE note_fts MATCH ?`).all(quotedPhrase) as { note_id: string }[];
  return hits.map((hit) => hit.note_id);
}

describe('note_fts stays in sync with notes', () => {
  it('finds a note by body content right after insert', () => {
    const db = openDatabaseWithProject();

    insertNote(db, 'n1', 'Daemon protocol', 'JSON-RPC over a local websocket');

    expect(findNoteIds(db, 'websocket')).toEqual(['n1']);
  });

  it('finds a note by title', () => {
    const db = openDatabaseWithProject();

    insertNote(db, 'n1', 'Daemon protocol', 'body');

    expect(findNoteIds(db, 'protocol')).toEqual(['n1']);
  });

  it('reflects an update without a stale hit for the old content', () => {
    const db = openDatabaseWithProject();
    insertNote(db, 'n1', 'Daemon protocol', 'old content about sockets');

    db.prepare(`UPDATE notes SET body_md = 'new content about pipes' WHERE id = 'n1'`).run();

    expect(findNoteIds(db, 'sockets')).toEqual([]);
    expect(findNoteIds(db, 'pipes')).toEqual(['n1']);
  });

  it('keeps exactly one index row per note across repeated updates', () => {
    const db = openDatabaseWithProject();
    insertNote(db, 'n1', 'T', 'first');

    db.prepare(`UPDATE notes SET body_md = 'second', rev = 2 WHERE id = 'n1'`).run();
    db.prepare(`UPDATE notes SET body_md = 'third', rev = 3 WHERE id = 'n1'`).run();

    const indexedRows = db.prepare(`SELECT COUNT(*) AS n FROM note_fts WHERE note_id = 'n1'`).get() as { n: number };
    expect(indexedRows.n).toBe(1);
  });

  it('removes the row from the index on delete', () => {
    const db = openDatabaseWithProject();
    insertNote(db, 'n1', 'x', 'unique-term-zzz');

    db.prepare(`DELETE FROM notes WHERE id = 'n1'`).run();

    expect(findNoteIds(db, 'unique-term-zzz')).toEqual([]);
  });
});

describe('notes schema constraints', () => {
  it('rejects a note whose project does not exist', () => {
    const db = openDatabaseWithProject();

    const insertOrphan = () =>
      db
        .prepare(
          `INSERT INTO notes (id, project_id, title, body_md, folder, file_path, rev, shared, created_at, updated_at)
           VALUES ('n1', 'missing', 'T', 'b', NULL, NULL, 1, 0, 't0', 't0')`,
        )
        .run();

    expect(insertOrphan).toThrow(/FOREIGN KEY/);
  });

  it('rejects two notes backed by the same file, but allows any number without a file', () => {
    const db = openDatabaseWithProject();
    insertNote(db, 'n1', 'A', 'a', '/docs/specs/a.md');
    insertNote(db, 'n2', 'B', 'b');
    insertNote(db, 'n3', 'C', 'c');

    expect(() => insertNote(db, 'n4', 'D', 'd', '/docs/specs/a.md')).toThrow(/UNIQUE/);
  });

  it('rejects a note with a revision below 1', () => {
    const db = openDatabaseWithProject();

    const insertRevisionZero = () =>
      db
        .prepare(
          `INSERT INTO notes (id, project_id, title, body_md, folder, file_path, rev, shared, created_at, updated_at)
           VALUES ('n1', 'p1', 'T', 'b', NULL, NULL, 0, 0, 't0', 't0')`,
        )
        .run();

    expect(insertRevisionZero).toThrow(/CHECK/);
  });

  it('rejects a shared flag other than 0 or 1', () => {
    const db = openDatabaseWithProject();

    const insertSharedTwo = () =>
      db
        .prepare(
          `INSERT INTO notes (id, project_id, title, body_md, folder, file_path, rev, shared, created_at, updated_at)
           VALUES ('n1', 'p1', 'T', 'b', NULL, NULL, 1, 2, 't0', 't0')`,
        )
        .run();

    expect(insertSharedTwo).toThrow(/CHECK/);
  });

  it('rejects a source hash on a note that has no file', () => {
    const db = openDatabaseWithProject();

    const insertHashWithoutFile = () =>
      db
        .prepare(
          `INSERT INTO notes (id, project_id, title, body_md, folder, file_path, rev, shared, source_hash, created_at, updated_at)
           VALUES ('n1', 'p1', 'T', 'b', NULL, NULL, 1, 0, 'abc123', 't0', 't0')`,
        )
        .run();

    expect(insertHashWithoutFile).toThrow(/CHECK/);
  });

  it('rejects two versions with the same revision of one note', () => {
    const db = openDatabaseWithProject();
    insertNote(db, 'n1', 'T', 'b');
    insertVersion(db, 'v1', 'n1', 1);

    expect(() => insertVersion(db, 'v2', 'n1', 1)).toThrow(/UNIQUE/);
  });

  it('deletes a note’s versions together with the note', () => {
    const db = openDatabaseWithProject();
    insertNote(db, 'n1', 'T', 'b');
    insertVersion(db, 'v1', 'n1', 1);

    db.prepare(`DELETE FROM notes WHERE id = 'n1'`).run();

    const remainingVersions = db.prepare(`SELECT COUNT(*) AS n FROM note_versions`).get() as { n: number };
    expect(remainingVersions.n).toBe(0);
  });
});
