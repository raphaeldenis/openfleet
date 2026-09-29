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
    id: 'n1', projectId: 'p1', title: 'Title', bodyMd: 'body', folder: null, filePath: null, sourceHash: null,
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

  it('orders by creation time before id when the two orders disagree', () => {
    const { repository } = openRepositoryWithProjects('p1');
    repository.insert(aNote({ id: 'a', createdAt: 't2' }));
    repository.insert(aNote({ id: 'b', createdAt: 't1' }));

    const ids = repository.list('p1').map((note) => note.id);

    expect(ids).toEqual(['b', 'a']);
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

  it('keeps the note versions across updates', () => {
    const { db, repository } = openRepositoryWithProjects('p1');
    repository.insert(aNote());
    insertVersion(db, 'n1', 1);

    repository.update('n1', { bodyMd: 'v2', expectedRev: 1, updatedAt: 't1' });

    expect(countVersions(db, 'n1')).toBe(1);
  });
});

describe('NoteRepository getByFilePath', () => {
  it('finds the note owning that file path', () => {
    const { repository } = openRepositoryWithProjects('p1');
    repository.insert(aNote({ filePath: '/docs/specs/a.md', sourceHash: 'h1' }));

    expect(repository.getByFilePath('/docs/specs/a.md')).toEqual(repository.get('n1'));
  });

  it('returns undefined for a path no note owns', () => {
    const { repository } = openRepositoryWithProjects('p1');

    expect(repository.getByFilePath('/docs/specs/nope.md')).toBeUndefined();
  });
});

describe('NoteRepository updateFileBacked', () => {
  it('replaces the body and source hash together, bumping the revision by one, when the revision matches', () => {
    const { repository } = openRepositoryWithProjects('p1');
    repository.insert(aNote({ filePath: '/docs/specs/a.md', sourceHash: 'h1', bodyMd: 'v1', rev: 1 }));

    const result = repository.updateFileBacked('n1', { bodyMd: 'v2', sourceHash: 'h2', expectedRev: 1, updatedAt: 't1' });

    const expectedNote = aNote({ filePath: '/docs/specs/a.md', sourceHash: 'h2', bodyMd: 'v2', rev: 2, updatedAt: 't1' });
    expect(result).toEqual({ outcome: 'updated', note: expectedNote });
    expect(repository.get('n1')).toEqual(expectedNote);
  });

  it('reports a stale revision and leaves the body and hash untouched', () => {
    const { repository } = openRepositoryWithProjects('p1');
    repository.insert(aNote({ filePath: '/docs/specs/a.md', sourceHash: 'h1', bodyMd: 'v1', rev: 1 }));

    const result = repository.updateFileBacked('n1', { bodyMd: 'v2-stale', sourceHash: 'h2', expectedRev: 99, updatedAt: 't1' });

    expect(result).toEqual({ outcome: 'stale_revision', currentRev: 1 });
    expect(repository.get('n1')).toMatchObject({ bodyMd: 'v1', sourceHash: 'h1', rev: 1 });
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

  it('leaves the folder of the other notes untouched', () => {
    const { repository } = openRepositoryWithProjects('p1');
    repository.insert(aNote({ id: 'n1', folder: null }));
    repository.insert(aNote({ id: 'n2', folder: 'specs' }));

    repository.move('n1', 'plans');

    expect(repository.get('n2')!.folder).toBe('specs');
  });

  it('reports whether a note was found', () => {
    const { repository } = openRepositoryWithProjects('p1');
    repository.insert(aNote());

    expect(repository.move('n1', 'plans')).toBe(true);
    expect(repository.move('nope', 'plans')).toBe(false);
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

  it('reports whether a note was found', () => {
    const { repository } = openRepositoryWithProjects('p1');
    repository.insert(aNote());

    expect(repository.delete('n1')).toBe(true);
    expect(repository.delete('n1')).toBe(false);
  });
});

describe('NoteRepository version reads', () => {
  it('getVersion returns the one version with its body, or undefined', () => {
    const { db, repository } = openRepositoryWithProjects('p1');
    repository.insert(aNote());
    insertVersion(db, 'n1', 1);
    insertVersion(db, 'n1', 2);

    expect(repository.getVersion('n1', 2)).toMatchObject({ noteId: 'n1', rev: 2, bodyMd: 'body', author: 'tester' });
    expect(repository.getVersion('n1', 3)).toBeUndefined();
  });

  it('listVersionSummaries returns id, rev, author and createdAt per version, oldest first, with no body', () => {
    const { db, repository } = openRepositoryWithProjects('p1');
    repository.insert(aNote());
    insertVersion(db, 'n1', 2);
    insertVersion(db, 'n1', 1);

    expect(repository.listVersionSummaries('n1')).toEqual([
      { id: 'n1-v1', rev: 1, author: 'tester', createdAt: 't0' },
      { id: 'n1-v2', rev: 2, author: 'tester', createdAt: 't0' },
    ]);
  });
});
