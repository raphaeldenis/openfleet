import { describe, expect, it } from 'vitest';
import type { Note } from '@openfleet/shared';
import { openDatabase } from '../db/database.js';
import { ProjectRepository } from '../projects/projectRepository.js';
import { NoteRepository } from './noteRepository.js';

function openRepositoryWithProjects(...projectIds: string[]) {
  const db = openDatabase(':memory:');
  const projects = new ProjectRepository(db);
  projectIds.forEach((id) => projects.insert({ id, name: id, docsFolderPath: null, createdAt: 't0' }));
  return { db, repository: new NoteRepository(db) };
}

function aNote(overrides: Partial<Note> = {}): Note {
  return {
    id: 'n1', projectId: 'p1', title: 'Title', bodyMd: 'body', folder: null, filePath: null,
    rev: 1, shared: false, createdAt: 't0', updatedAt: 't0', ...overrides,
  };
}

function searchNoteIds(db: ReturnType<typeof openDatabase>, term: string): string[] {
  const hits = db.prepare('SELECT note_id FROM note_fts WHERE note_fts MATCH ?').all(`"${term}"`) as { note_id: string }[];
  return hits.map((hit) => hit.note_id);
}

function insertVersion(db: ReturnType<typeof openDatabase>, noteId: string, rev: number) {
  db.prepare(
    `INSERT INTO note_versions (id, note_id, rev, body_md, author, change_summary, created_at)
     VALUES (?, ?, ?, 'body', 'tester', NULL, 't0')`,
  ).run(`${noteId}-v${rev}`, noteId, rev);
}

function countVersions(db: ReturnType<typeof openDatabase>, noteId: string): number {
  const row = db.prepare('SELECT COUNT(*) AS n FROM note_versions WHERE note_id = ?').get(noteId) as { n: number };
  return row.n;
}

describe('NoteRepository insert and get', () => {
  it('reads back exactly what was inserted', () => {
    const { repository } = openRepositoryWithProjects('p1');
    const note = aNote({ folder: 'specs', filePath: '/docs/specs/a.md', shared: true, rev: 3, updatedAt: 't5' });

    repository.insert(note);

    expect(repository.get('n1')).toEqual(note);
  });

  it('returns undefined for an unknown note', () => {
    const { repository } = openRepositoryWithProjects('p1');

    expect(repository.get('nope')).toBeUndefined();
  });

  it('refuses to insert over an existing id and keeps the original note and its versions', () => {
    const { db, repository } = openRepositoryWithProjects('p1');
    repository.insert(aNote({ bodyMd: 'original' }));
    insertVersion(db, 'n1', 1);

    const insertDuplicate = () => repository.insert(aNote({ bodyMd: 'intruder' }));

    expect(insertDuplicate).toThrow(/UNIQUE|PRIMARY KEY/);
    expect(repository.get('n1')!.bodyMd).toBe('original');
    expect(countVersions(db, 'n1')).toBe(1);
  });

  it('refuses a note for an unknown project', () => {
    const { repository } = openRepositoryWithProjects('p1');

    const insertOrphan = () => repository.insert(aNote({ projectId: 'missing' }));

    expect(insertOrphan).toThrow(/FOREIGN KEY/);
  });
});

describe('NoteRepository list', () => {
  it('lists only the notes of the given project', () => {
    const { repository } = openRepositoryWithProjects('p1', 'p2');
    repository.insert(aNote({ id: 'a', projectId: 'p1' }));
    repository.insert(aNote({ id: 'b', projectId: 'p2' }));

    const ids = repository.list('p1').map((note) => note.id);

    expect(ids).toEqual(['a']);
  });

  it('lists notes oldest first, breaking ties by id', () => {
    const { repository } = openRepositoryWithProjects('p1');
    repository.insert(aNote({ id: 'n3', createdAt: 't2' }));
    repository.insert(aNote({ id: 'n2', createdAt: 't1' }));
    repository.insert(aNote({ id: 'n1', createdAt: 't1' }));

    const ids = repository.list('p1').map((note) => note.id);

    expect(ids).toEqual(['n1', 'n2', 'n3']);
  });

  it('returns an empty list for a project without notes', () => {
    const { repository } = openRepositoryWithProjects('p1');

    expect(repository.list('p1')).toEqual([]);
  });
});

describe('NoteRepository update', () => {
  it('replaces the body, bumps the revision by one and stamps the update time when the revision matches', () => {
    const { repository } = openRepositoryWithProjects('p1');
    repository.insert(aNote({ bodyMd: 'v1', rev: 1, createdAt: 't0', updatedAt: 't0' }));

    const result = repository.update('n1', { bodyMd: 'v2', expectedRev: 1, updatedAt: 't1' });

    const expectedNote = aNote({ bodyMd: 'v2', rev: 2, createdAt: 't0', updatedAt: 't1' });
    expect(result).toEqual({ outcome: 'updated', note: expectedNote });
    expect(repository.get('n1')).toEqual(expectedNote);
  });

  it('reports a stale revision with the current one and leaves the note untouched', () => {
    const { repository } = openRepositoryWithProjects('p1');
    repository.insert(aNote({ bodyMd: 'v1', rev: 1 }));
    repository.update('n1', { bodyMd: 'v2', expectedRev: 1, updatedAt: 't1' });

    const result = repository.update('n1', { bodyMd: 'v3-stale', expectedRev: 1, updatedAt: 't2' });

    expect(result).toEqual({ outcome: 'stale_revision', currentRev: 2 });
    expect(repository.get('n1')).toMatchObject({ bodyMd: 'v2', rev: 2, updatedAt: 't1' });
  });

  it('reports a revision from the future as stale as well', () => {
    const { repository } = openRepositoryWithProjects('p1');
    repository.insert(aNote({ rev: 1 }));

    const result = repository.update('n1', { bodyMd: 'x', expectedRev: 7, updatedAt: 't1' });

    expect(result).toEqual({ outcome: 'stale_revision', currentRev: 1 });
  });

  it('lets only one of two writers holding the same revision win', () => {
    const { repository } = openRepositoryWithProjects('p1');
    repository.insert(aNote({ rev: 1 }));

    const first = repository.update('n1', { bodyMd: 'first', expectedRev: 1, updatedAt: 't1' });
    const second = repository.update('n1', { bodyMd: 'second', expectedRev: 1, updatedAt: 't2' });

    expect(first.outcome).toBe('updated');
    expect(second.outcome).toBe('stale_revision');
    expect(repository.get('n1')!.bodyMd).toBe('first');
  });

  it('reports not_found, distinct from a stale revision, for an unknown note', () => {
    const { repository } = openRepositoryWithProjects('p1');

    const result = repository.update('nope', { bodyMd: 'x', expectedRev: 1, updatedAt: 't1' });

    expect(result).toEqual({ outcome: 'not_found' });
  });

  it('makes search find the new body and forget the old one', () => {
    const { db, repository } = openRepositoryWithProjects('p1');
    repository.insert(aNote({ bodyMd: 'sockets everywhere' }));

    repository.update('n1', { bodyMd: 'pipes everywhere', expectedRev: 1, updatedAt: 't1' });

    expect(searchNoteIds(db, 'sockets')).toEqual([]);
    expect(searchNoteIds(db, 'pipes')).toEqual(['n1']);
  });

  it('keeps search on the old body when the revision is stale', () => {
    const { db, repository } = openRepositoryWithProjects('p1');
    repository.insert(aNote({ bodyMd: 'sockets everywhere', rev: 2 }));

    repository.update('n1', { bodyMd: 'pipes everywhere', expectedRev: 1, updatedAt: 't1' });

    expect(searchNoteIds(db, 'sockets')).toEqual(['n1']);
    expect(searchNoteIds(db, 'pipes')).toEqual([]);
  });

  it('keeps the note versions across updates', () => {
    const { db, repository } = openRepositoryWithProjects('p1');
    repository.insert(aNote());
    insertVersion(db, 'n1', 1);

    repository.update('n1', { bodyMd: 'v2', expectedRev: 1, updatedAt: 't1' });

    expect(countVersions(db, 'n1')).toBe(1);
  });
});

describe('NoteRepository move', () => {
  it('changes the folder without touching the body, the revision or the update time', () => {
    const { repository } = openRepositoryWithProjects('p1');
    repository.insert(aNote({ folder: null, bodyMd: 'keep', rev: 4, updatedAt: 't3' }));

    repository.move('n1', 'plans');

    expect(repository.get('n1')).toEqual(aNote({ folder: 'plans', bodyMd: 'keep', rev: 4, updatedAt: 't3' }));
  });

  it('moves a note out of its folder', () => {
    const { repository } = openRepositoryWithProjects('p1');
    repository.insert(aNote({ folder: 'specs' }));

    repository.move('n1', null);

    expect(repository.get('n1')!.folder).toBeNull();
  });
});

describe('NoteRepository delete', () => {
  it('removes the note, its versions and its search entry', () => {
    const { db, repository } = openRepositoryWithProjects('p1');
    repository.insert(aNote({ bodyMd: 'findable-term' }));
    insertVersion(db, 'n1', 1);
    insertVersion(db, 'n1', 2);

    repository.delete('n1');

    expect(repository.get('n1')).toBeUndefined();
    expect(countVersions(db, 'n1')).toBe(0);
    expect(searchNoteIds(db, 'findable')).toEqual([]);
  });

  it('leaves the other notes and their search entries alone', () => {
    const { db, repository } = openRepositoryWithProjects('p1');
    repository.insert(aNote({ id: 'n1', bodyMd: 'shared-word one' }));
    repository.insert(aNote({ id: 'n2', bodyMd: 'shared-word two' }));

    repository.delete('n1');

    expect(repository.list('p1').map((note) => note.id)).toEqual(['n2']);
    expect(searchNoteIds(db, 'two')).toEqual(['n2']);
  });
});
