import { describe, expect, it, vi } from 'vitest';
import { openDatabase } from '../db/database.js';
import { ProjectRepository } from '../projects/projectRepository.js';
import { expandMentions } from './mentionExpander.js';
import { NoteRepository } from './noteRepository.js';
import { FileBackedNoteError, NoteNotFoundError, NoteService, NoteTooLargeError, StaleRevisionError } from './noteService.js';
import { replaceSection } from './noteSections.js';

const AUTHOR = 'rdenisfr@gmail.com';
const MAX_BODY_BYTES = 1024 * 1024;

function setup(projectIds: string[] = ['p1']) {
  const db = openDatabase(':memory:');
  const projects = new ProjectRepository(db);
  projectIds.forEach((id) => projects.insert({ id, name: id, docsFolderPath: null, createdAt: 't0' }));
  const repo = new NoteRepository(db);

  let tick = 0;
  const clock = () => `t${tick++}`;
  let sequence = 0;
  const newId = () => `id-${sequence++}`;

  const service = new NoteService({ repo, db, expandMentions, clock, newId });
  return { db, repo, service, clock };
}

describe('NoteService create', () => {
  it('creates a note at revision 1 with an id and timestamp from its dependencies', () => {
    const { service } = setup();

    const note = service.create({ projectId: 'p1', title: 'Title', bodyMd: 'body', author: AUTHOR });

    expect(note).toMatchObject({ id: 'id-0', projectId: 'p1', title: 'Title', bodyMd: 'body', folder: null, shared: false, rev: 1, createdAt: 't0', updatedAt: 't0' });
  });

  it('defaults folder to null and shared to false when not given', () => {
    const { service } = setup();

    const note = service.create({ projectId: 'p1', title: 'Title', bodyMd: 'body', author: AUTHOR });

    expect(note.folder).toBeNull();
    expect(note.shared).toBe(false);
  });

  it('honors an explicit folder and shared flag', () => {
    const { service } = setup();

    const note = service.create({ projectId: 'p1', title: 'Title', bodyMd: 'body', folder: 'specs', shared: true, author: AUTHOR });

    expect(note.folder).toBe('specs');
    expect(note.shared).toBe(true);
  });

  it('refuses a body over the 1 MiB cap and writes nothing', () => {
    const { service, repo } = setup();
    const oneByteOverCap = 'a'.repeat(MAX_BODY_BYTES + 1);

    expect(() => service.create({ projectId: 'p1', title: 'Title', bodyMd: oneByteOverCap, author: AUTHOR })).toThrow(NoteTooLargeError);
    expect(repo.list('p1')).toEqual([]);
  });

  it('accepts a body exactly at the 1 MiB cap', () => {
    const { service } = setup();
    const exactlyAtCap = 'a'.repeat(MAX_BODY_BYTES);

    const note = service.create({ projectId: 'p1', title: 'Title', bodyMd: exactlyAtCap, author: AUTHOR });

    expect(note.bodyMd).toHaveLength(MAX_BODY_BYTES);
  });

  it('measures the cap in UTF-8 bytes, not characters, near a multibyte boundary', () => {
    const { service } = setup();
    // U+00E9 (é) is 2 bytes in UTF-8: one ASCII byte short of the cap, then one multibyte char pushes it over.
    const bodyOneByteUnderCap = 'a'.repeat(MAX_BODY_BYTES - 1) + 'é';

    expect(() => service.create({ projectId: 'p1', title: 'Title', bodyMd: bodyOneByteUnderCap, author: AUTHOR })).toThrow(NoteTooLargeError);
  });
});

describe('NoteService versioning', () => {
  it('inserts exactly one version row on create, with rev 1 and the created body', () => {
    const { service, repo } = setup();

    const note = service.create({ projectId: 'p1', title: 'Title', bodyMd: 'v1', author: AUTHOR });

    const versions = repo.listVersions(note.id);
    expect(versions).toHaveLength(1);
    expect(versions[0]).toMatchObject({ rev: 1, bodyMd: 'v1', author: AUTHOR });
  });

  it('inserts one version row per update, revs 1..3 with their own bodies, after create plus two updates', () => {
    const { service, repo } = setup();
    const note = service.create({ projectId: 'p1', title: 'Title', bodyMd: 'v1', author: AUTHOR });

    const afterFirstUpdate = service.update(note.id, { bodyMd: 'v2', expectedRev: 1, author: AUTHOR });
    service.update(note.id, { bodyMd: 'v3', expectedRev: afterFirstUpdate.rev, author: AUTHOR });

    const versions = repo.listVersions(note.id);
    expect(versions.map((v) => [v.rev, v.bodyMd])).toEqual([[1, 'v1'], [2, 'v2'], [3, 'v3']]);
  });

  it('adds no version row when a write is refused for a stale revision', () => {
    const { service, repo } = setup();
    const note = service.create({ projectId: 'p1', title: 'Title', bodyMd: 'v1', author: AUTHOR });
    service.update(note.id, { bodyMd: 'v2', expectedRev: 1, author: AUTHOR });

    expect(() => service.update(note.id, { bodyMd: 'v3-stale', expectedRev: 1, author: AUTHOR })).toThrow(StaleRevisionError);

    expect(repo.listVersions(note.id)).toHaveLength(2);
  });

  it('inserts exactly one version row on a successful append, matching the returned note\'s rev and body', () => {
    const { service, repo } = setup();
    const note = service.create({ projectId: 'p1', title: 'Title', bodyMd: 'start', author: AUTHOR });

    const appended = service.append(note.id, { content: 'tail', author: AUTHOR });

    const versions = repo.listVersions(note.id);
    expect(versions).toHaveLength(2);
    expect(versions[1]).toMatchObject({ rev: appended.rev, bodyMd: appended.bodyMd });
  });

  it('rolls back the notes write when the version write fails in the same transaction', () => {
    const { service, repo } = setup();
    const note = service.create({ projectId: 'p1', title: 'Title', bodyMd: 'v1', author: AUTHOR });
    vi.spyOn(repo, 'insertVersion').mockImplementation(() => {
      throw new Error('simulated version-write failure');
    });

    expect(() => service.update(note.id, { bodyMd: 'v2', expectedRev: 1, author: AUTHOR })).toThrow('simulated version-write failure');

    expect(repo.get(note.id)).toMatchObject({ bodyMd: 'v1', rev: 1 });
    expect(repo.listVersions(note.id)).toHaveLength(1);
  });

  it('rolls back the version write when the notes write fails in the same transaction, leaving neither', () => {
    const { service, repo, db } = setup();
    const note = service.create({ projectId: 'p1', title: 'Title', bodyMd: 'v1', author: AUTHOR });
    db.exec(`
      CREATE TRIGGER poison_update BEFORE UPDATE OF body_md ON notes
      WHEN new.body_md = 'poison'
      BEGIN SELECT RAISE(ABORT, 'poisoned update');
      END;
    `);

    expect(() => service.update(note.id, { bodyMd: 'poison', expectedRev: 1, author: AUTHOR })).toThrow(/poisoned update/);

    expect(repo.get(note.id)).toMatchObject({ bodyMd: 'v1', rev: 1 });
    expect(repo.listVersions(note.id)).toHaveLength(1);
  });
});

describe('NoteService update', () => {
  it('replaces the body and bumps the revision', () => {
    const { service } = setup();
    const note = service.create({ projectId: 'p1', title: 'Title', bodyMd: 'v1', author: AUTHOR });

    const updated = service.update(note.id, { bodyMd: 'v2', expectedRev: 1, author: AUTHOR });

    expect(updated).toMatchObject({ bodyMd: 'v2', rev: 2 });
  });

  it('throws StaleRevisionError carrying the current revision, and leaves the body unchanged, when the revision is stale', () => {
    const { service, repo } = setup();
    const note = service.create({ projectId: 'p1', title: 'Title', bodyMd: 'v1', author: AUTHOR });
    service.update(note.id, { bodyMd: 'v2', expectedRev: 1, author: AUTHOR });

    let caught: unknown;
    try {
      service.update(note.id, { bodyMd: 'v3-stale', expectedRev: 1, author: AUTHOR });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(StaleRevisionError);
    expect((caught as StaleRevisionError).currentRev).toBe(2);
    expect(repo.get(note.id)!.bodyMd).toBe('v2');
  });

  it('throws NoteNotFoundError for an unknown note', () => {
    const { service } = setup();

    expect(() => service.update('nope', { bodyMd: 'x', expectedRev: 1, author: AUTHOR })).toThrow(NoteNotFoundError);
  });

  it('refuses an update whose resulting body is over the cap and writes nothing', () => {
    const { service, repo } = setup();
    const note = service.create({ projectId: 'p1', title: 'Title', bodyMd: 'v1', author: AUTHOR });
    const overCap = 'a'.repeat(MAX_BODY_BYTES + 1);

    expect(() => service.update(note.id, { bodyMd: overCap, expectedRev: 1, author: AUTHOR })).toThrow(NoteTooLargeError);

    expect(repo.get(note.id)!.bodyMd).toBe('v1');
    expect(repo.listVersions(note.id)).toHaveLength(1);
  });
});

describe('NoteService updateSection', () => {
  it('replaces the named section and bumps the revision', () => {
    const { service } = setup();
    const note = service.create({ projectId: 'p1', title: 'Title', bodyMd: '## Status\nold\n## Other\nkeep', author: AUTHOR });

    const updated = service.updateSection(note.id, { heading: 'Status', content: 'new', expectedRev: 1, author: AUTHOR });

    expect(updated.bodyMd).toContain('new');
    expect(updated.bodyMd).toContain('keep');
    expect(updated.rev).toBe(2);
  });

  it('propagates a section error unchanged, writing nothing and no version row', () => {
    const { service, repo } = setup();
    const note = service.create({ projectId: 'p1', title: 'Title', bodyMd: '## Status\nold', author: AUTHOR });

    expect(() => service.updateSection(note.id, { heading: 'Missing', content: 'new', expectedRev: 1, author: AUTHOR })).toThrow(/section "Missing" not found/);

    expect(repo.get(note.id)!.bodyMd).toBe('## Status\nold');
    expect(repo.listVersions(note.id)).toHaveLength(1);
  });

  it('throws StaleRevisionError when the revision does not match, leaving the section untouched', () => {
    const { service, repo } = setup();
    const note = service.create({ projectId: 'p1', title: 'Title', bodyMd: '## Status\nold', author: AUTHOR });
    service.update(note.id, { bodyMd: '## Status\nunrelated-change', expectedRev: 1, author: AUTHOR });

    expect(() => service.updateSection(note.id, { heading: 'Status', content: 'new', expectedRev: 1, author: AUTHOR })).toThrow(StaleRevisionError);

    expect(repo.get(note.id)!.bodyMd).toBe('## Status\nunrelated-change');
  });

  it('accepts a resulting body exactly at the 1 MiB cap and refuses one byte over, writing nothing', () => {
    const { service, repo } = setup();
    const note = service.create({ projectId: 'p1', title: 'Title', bodyMd: '## Status\nplaceholder', author: AUTHOR });
    // Measure the fixed overhead (heading text, line breaks) that replaceSection wraps around the section content.
    const probeBody = replaceSection(note.bodyMd, 'Status', 'x');
    const overheadBytes = Buffer.byteLength(probeBody, 'utf8') - 1;
    const exactContent = 'a'.repeat(MAX_BODY_BYTES - overheadBytes);

    const atCap = service.updateSection(note.id, { heading: 'Status', content: exactContent, expectedRev: 1, author: AUTHOR });
    expect(Buffer.byteLength(atCap.bodyMd, 'utf8')).toBe(MAX_BODY_BYTES);
    expect(atCap.rev).toBe(2);

    const overContent = exactContent + 'a';
    expect(() => service.updateSection(atCap.id, { heading: 'Status', content: overContent, expectedRev: atCap.rev, author: AUTHOR })).toThrow(NoteTooLargeError);

    expect(repo.get(atCap.id)).toMatchObject({ bodyMd: atCap.bodyMd, rev: 2 });
    expect(repo.listVersions(atCap.id)).toHaveLength(2);
  });
});

describe('NoteService append', () => {
  it('appends under the given heading via appendSection', () => {
    const { service } = setup();
    const note = service.create({ projectId: 'p1', title: 'Title', bodyMd: '## Log\nfirst', author: AUTHOR });

    const appended = service.append(note.id, { content: 'second', heading: 'Log', author: AUTHOR });

    expect(appended.bodyMd).toContain('first');
    expect(appended.bodyMd).toContain('second');
  });

  it('appends at the end of the body when no heading is given', () => {
    const { service } = setup();
    const note = service.create({ projectId: 'p1', title: 'Title', bodyMd: 'intro', author: AUTHOR });

    const appended = service.append(note.id, { content: 'tail', author: AUTHOR });

    expect(appended.bodyMd).toContain('intro');
    expect(appended.bodyMd).toContain('tail');
  });

  it('bumps the revision by exactly one per append, and keeps the content of an update made between two appends', () => {
    const { service } = setup();
    const note = service.create({ projectId: 'p1', title: 'Title', bodyMd: 'start', author: AUTHOR });

    const firstAppend = service.append(note.id, { content: 'appended-1', author: AUTHOR });
    expect(firstAppend.rev).toBe(note.rev + 1);

    const betweenUpdate = service.update(note.id, { bodyMd: `${firstAppend.bodyMd}\ninterleaved-update`, expectedRev: firstAppend.rev, author: AUTHOR });

    const secondAppend = service.append(note.id, { content: 'appended-2', author: AUTHOR });
    expect(secondAppend.rev).toBe(betweenUpdate.rev + 1);
    expect(secondAppend.bodyMd).toContain('interleaved-update');
    expect(secondAppend.bodyMd).toContain('appended-2');
  });

  it('takes no expectedRev and never reports staleness against the caller', () => {
    const { service } = setup();
    const note = service.create({ projectId: 'p1', title: 'Title', bodyMd: 'start', author: AUTHOR });
    service.update(note.id, { bodyMd: 'changed-out-from-under-append', expectedRev: note.rev, author: AUTHOR });

    const appended = service.append(note.id, { content: 'tail', author: AUTHOR });

    expect(appended.bodyMd).toContain('changed-out-from-under-append');
    expect(appended.bodyMd).toContain('tail');
  });

  it('retries a CAS that goes stale between its read and its write, then succeeds', () => {
    const { service, repo } = setup();
    const note = service.create({ projectId: 'p1', title: 'Title', bodyMd: 'start', author: AUTHOR });
    const realUpdate = repo.update.bind(repo);
    let hasInjectedRace = false;
    vi.spyOn(repo, 'update').mockImplementation((id, patch) => {
      if (!hasInjectedRace) {
        hasInjectedRace = true;
        realUpdate(id, { bodyMd: 'raced-in', expectedRev: note.rev, updatedAt: 'raced-at' });
      }
      return realUpdate(id, patch);
    });

    const appended = service.append(note.id, { content: 'tail', author: AUTHOR });

    expect(appended.bodyMd).toContain('raced-in');
    expect(appended.bodyMd).toContain('tail');
    expect(repo.update).toHaveBeenCalledTimes(2);
  });

  it('throws after exhausting its retries when the CAS keeps going stale', () => {
    const { service, repo } = setup();
    const note = service.create({ projectId: 'p1', title: 'Title', bodyMd: 'start', author: AUTHOR });
    vi.spyOn(repo, 'update').mockReturnValue({ outcome: 'stale_revision', currentRev: note.rev + 99 });

    expect(() => service.append(note.id, { content: 'tail', author: AUTHOR })).toThrow(StaleRevisionError);
  });

  it('absorbs 3 concurrent interleavings between read and CAS, then succeeds', () => {
    const { service, repo } = setup();
    const note = service.create({ projectId: 'p1', title: 'Title', bodyMd: 'start', author: AUTHOR });
    const realUpdate = repo.update.bind(repo);
    let racesLeft = 3;
    vi.spyOn(repo, 'update').mockImplementation((id, patch) => {
      if (racesLeft > 0) {
        racesLeft--;
        const current = repo.get(id)!;
        realUpdate(id, { bodyMd: `raced-${racesLeft}`, expectedRev: current.rev, updatedAt: `raced-at-${racesLeft}` });
      }
      return realUpdate(id, patch);
    });

    const appended = service.append(note.id, { content: 'tail', author: AUTHOR });

    expect(appended.bodyMd).toContain('tail');
    expect(repo.update).toHaveBeenCalledTimes(4);
  });

  it('throws StaleRevisionError carrying the actual current revision after 4 concurrent interleavings', () => {
    const { service, repo } = setup();
    const note = service.create({ projectId: 'p1', title: 'Title', bodyMd: 'start', author: AUTHOR });
    const realUpdate = repo.update.bind(repo);
    let racesLeft = 4;
    vi.spyOn(repo, 'update').mockImplementation((id, patch) => {
      if (racesLeft > 0) {
        racesLeft--;
        const current = repo.get(id)!;
        realUpdate(id, { bodyMd: `raced-${racesLeft}`, expectedRev: current.rev, updatedAt: `raced-at-${racesLeft}` });
      }
      return realUpdate(id, patch);
    });

    let caught: unknown;
    try {
      service.append(note.id, { content: 'tail', author: AUTHOR });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(StaleRevisionError);
    expect((caught as StaleRevisionError).currentRev).toBe(repo.get(note.id)!.rev);
    expect(repo.update).toHaveBeenCalledTimes(4);
  });

  it('refuses an append whose resulting body is over the cap and writes nothing', () => {
    const { service, repo } = setup();
    const note = service.create({ projectId: 'p1', title: 'Title', bodyMd: 'a'.repeat(MAX_BODY_BYTES - 1), author: AUTHOR });

    expect(() => service.append(note.id, { content: 'aa', author: AUTHOR })).toThrow(NoteTooLargeError);

    expect(repo.get(note.id)!.rev).toBe(1);
    expect(repo.listVersions(note.id)).toHaveLength(1);
  });

  it('throws NoteNotFoundError for an unknown note', () => {
    const { service } = setup();

    expect(() => service.append('nope', { content: 'x', author: AUTHOR })).toThrow(NoteNotFoundError);
  });
});

describe('NoteService rename', () => {
  it('replaces the title and bumps the revision', () => {
    const { service } = setup();
    const note = service.create({ projectId: 'p1', title: 'Old', bodyMd: 'body', author: AUTHOR });

    const renamed = service.rename(note.id, { title: 'New', expectedRev: 1, author: AUTHOR });

    expect(renamed).toMatchObject({ title: 'New', rev: 2, bodyMd: 'body' });
  });

  it('reindexes the title for search', () => {
    const { service, db } = setup();
    const note = service.create({ projectId: 'p1', title: 'Old Title', bodyMd: 'body', author: AUTHOR });

    service.rename(note.id, { title: 'Brand New Title', expectedRev: 1, author: AUTHOR });

    const hits = db.prepare('SELECT note_id FROM note_fts WHERE note_fts MATCH ?').all('"Brand New"') as { note_id: string }[];
    expect(hits.map((h) => h.note_id)).toEqual([note.id]);
  });

  it('throws StaleRevisionError when the revision does not match', () => {
    const { service } = setup();
    const note = service.create({ projectId: 'p1', title: 'Old', bodyMd: 'body', author: AUTHOR });
    service.rename(note.id, { title: 'New', expectedRev: 1, author: AUTHOR });

    expect(() => service.rename(note.id, { title: 'Stale', expectedRev: 1, author: AUTHOR })).toThrow(StaleRevisionError);
  });

  it('inserts a version row for the rename, with the unchanged body', () => {
    const { service, repo } = setup();
    const note = service.create({ projectId: 'p1', title: 'Old', bodyMd: 'body', author: AUTHOR });

    service.rename(note.id, { title: 'New', expectedRev: 1, author: AUTHOR });

    const versions = repo.listVersions(note.id);
    expect(versions).toHaveLength(2);
    expect(versions[1]).toMatchObject({ rev: 2, bodyMd: 'body' });
  });
});

describe('NoteService move', () => {
  it('moves a note into a folder', () => {
    const { service } = setup();
    const note = service.create({ projectId: 'p1', title: 'Title', bodyMd: 'body', author: AUTHOR });

    const moved = service.move(note.id, 'plans');

    expect(moved.folder).toBe('plans');
  });

  it('moves a note out of a folder', () => {
    const { service } = setup();
    const note = service.create({ projectId: 'p1', title: 'Title', bodyMd: 'body', folder: 'specs', author: AUTHOR });

    const moved = service.move(note.id, null);

    expect(moved.folder).toBeNull();
  });

  it('throws NoteNotFoundError for an unknown note', () => {
    const { service } = setup();

    expect(() => service.move('nope', 'plans')).toThrow(NoteNotFoundError);
  });

  it('writes no version row for a move', () => {
    const { service, repo } = setup();
    const note = service.create({ projectId: 'p1', title: 'Title', bodyMd: 'body', author: AUTHOR });
    const versionsBefore = repo.listVersions(note.id).length;

    service.move(note.id, 'plans');

    expect(repo.listVersions(note.id)).toHaveLength(versionsBefore);
  });
});

describe('NoteService nested transactions (caller-managed)', () => {
  it('persists two nested writes and their version rows after an outer COMMIT', () => {
    const { service, repo, db } = setup();
    const note = service.create({ projectId: 'p1', title: 'Title', bodyMd: 'v1', author: AUTHOR });

    db.exec('BEGIN');
    const afterFirst = service.update(note.id, { bodyMd: 'v2', expectedRev: 1, author: AUTHOR });
    const afterSecond = service.update(note.id, { bodyMd: 'v3', expectedRev: afterFirst.rev, author: AUTHOR });
    db.exec('COMMIT');

    expect(afterSecond).toMatchObject({ bodyMd: 'v3', rev: 3 });
    expect(repo.get(note.id)).toMatchObject({ bodyMd: 'v3', rev: 3 });
    expect(repo.listVersions(note.id).map((v) => [v.rev, v.bodyMd])).toEqual([[1, 'v1'], [2, 'v2'], [3, 'v3']]);
  });

  it('keeps only the writes that succeeded around a mid-transaction failure, and leaves the db usable after COMMIT', () => {
    const { service, repo, db } = setup();
    const note = service.create({ projectId: 'p1', title: 'Title', bodyMd: 'v1', author: AUTHOR });

    db.exec('BEGIN');
    const afterFirst = service.update(note.id, { bodyMd: 'v2', expectedRev: 1, author: AUTHOR });
    expect(() => service.update(note.id, { bodyMd: 'stale', expectedRev: 1, author: AUTHOR })).toThrow(StaleRevisionError);
    const afterThird = service.update(note.id, { bodyMd: 'v3', expectedRev: afterFirst.rev, author: AUTHOR });
    db.exec('COMMIT');

    expect(afterThird).toMatchObject({ bodyMd: 'v3', rev: 3 });
    expect(repo.get(note.id)).toMatchObject({ bodyMd: 'v3', rev: 3 });
    expect(repo.listVersions(note.id).map((v) => [v.rev, v.bodyMd])).toEqual([[1, 'v1'], [2, 'v2'], [3, 'v3']]);

    const afterCommitWrite = service.update(note.id, { bodyMd: 'v4', expectedRev: 3, author: AUTHOR });
    expect(afterCommitWrite).toMatchObject({ bodyMd: 'v4', rev: 4 });
  });

  it('discards nested writes when the caller rolls back the outer transaction', () => {
    const { service, repo, db } = setup();
    const note = service.create({ projectId: 'p1', title: 'Title', bodyMd: 'v1', author: AUTHOR });

    db.exec('BEGIN');
    service.update(note.id, { bodyMd: 'v2', expectedRev: 1, author: AUTHOR });
    service.update(note.id, { bodyMd: 'v3', expectedRev: 2, author: AUTHOR });
    db.exec('ROLLBACK');

    expect(repo.get(note.id)).toMatchObject({ bodyMd: 'v1', rev: 1 });
    expect(repo.listVersions(note.id)).toHaveLength(1);
  });
});

describe('NoteService createFileBacked', () => {
  it('inserts a file-backed note at revision 1 with the given filePath and sourceHash', () => {
    const { service } = setup();

    const note = service.createFileBacked({ projectId: 'p1', title: 'Title', bodyMd: '# v1', folder: 'specs', filePath: '/docs/specs/a.md', sourceHash: 'h1', author: AUTHOR });

    expect(note).toMatchObject({ filePath: '/docs/specs/a.md', sourceHash: 'h1', rev: 1, folder: 'specs' });
  });

  it('refuses a body over the cap and inserts nothing', () => {
    const { service, repo } = setup();
    const overCap = 'a'.repeat(MAX_BODY_BYTES + 1);

    expect(() => service.createFileBacked({ projectId: 'p1', title: 'Title', bodyMd: overCap, filePath: '/docs/specs/a.md', sourceHash: 'h1', author: AUTHOR })).toThrow(NoteTooLargeError);
    expect(repo.list('p1')).toEqual([]);
  });
});

describe('NoteService updateFileBacked', () => {
  it('replaces the body and source hash together and bumps the revision', () => {
    const { service } = setup();
    const note = service.createFileBacked({ projectId: 'p1', title: 'Title', bodyMd: 'v1', filePath: '/docs/a.md', sourceHash: 'h1', author: AUTHOR });

    const updated = service.updateFileBacked(note.id, { bodyMd: 'v2', sourceHash: 'h2', expectedRev: 1, author: AUTHOR });

    expect(updated).toMatchObject({ bodyMd: 'v2', sourceHash: 'h2', rev: 2, filePath: '/docs/a.md' });
  });

  it('throws StaleRevisionError and leaves the body and hash unchanged when the revision is stale', () => {
    const { service, repo } = setup();
    const note = service.createFileBacked({ projectId: 'p1', title: 'Title', bodyMd: 'v1', filePath: '/docs/a.md', sourceHash: 'h1', author: AUTHOR });
    service.updateFileBacked(note.id, { bodyMd: 'v2', sourceHash: 'h2', expectedRev: 1, author: AUTHOR });

    expect(() => service.updateFileBacked(note.id, { bodyMd: 'v3-stale', sourceHash: 'h3', expectedRev: 1, author: AUTHOR })).toThrow(StaleRevisionError);
    expect(repo.get(note.id)).toMatchObject({ bodyMd: 'v2', sourceHash: 'h2', rev: 2 });
  });

  it('inserts one version row per successful write', () => {
    const { service, repo } = setup();
    const note = service.createFileBacked({ projectId: 'p1', title: 'Title', bodyMd: 'v1', filePath: '/docs/a.md', sourceHash: 'h1', author: AUTHOR });

    service.updateFileBacked(note.id, { bodyMd: 'v2', sourceHash: 'h2', expectedRev: 1, author: AUTHOR });

    expect(repo.listVersions(note.id)).toHaveLength(2);
  });
});

describe('NoteService refuses plain writes on a file-backed note', () => {
  it('update throws FileBackedNoteError and writes nothing', () => {
    const { service, repo } = setup();
    const note = service.createFileBacked({ projectId: 'p1', title: 'Title', bodyMd: 'v1', filePath: '/docs/a.md', sourceHash: 'h1', author: AUTHOR });

    expect(() => service.update(note.id, { bodyMd: 'v2', expectedRev: 1, author: AUTHOR })).toThrow(FileBackedNoteError);

    expect(repo.get(note.id)).toMatchObject({ bodyMd: 'v1', rev: 1 });
    expect(repo.listVersions(note.id)).toHaveLength(1);
  });

  it('updateSection throws FileBackedNoteError and writes nothing', () => {
    const { service, repo } = setup();
    const note = service.createFileBacked({ projectId: 'p1', title: 'Title', bodyMd: '## Status\nold', filePath: '/docs/a.md', sourceHash: 'h1', author: AUTHOR });

    expect(() => service.updateSection(note.id, { heading: 'Status', content: 'new', expectedRev: 1, author: AUTHOR })).toThrow(FileBackedNoteError);

    expect(repo.get(note.id)!.bodyMd).toBe('## Status\nold');
    expect(repo.listVersions(note.id)).toHaveLength(1);
  });

  it('append throws FileBackedNoteError and writes nothing', () => {
    const { service, repo } = setup();
    const note = service.createFileBacked({ projectId: 'p1', title: 'Title', bodyMd: 'start', filePath: '/docs/a.md', sourceHash: 'h1', author: AUTHOR });

    expect(() => service.append(note.id, { content: 'tail', author: AUTHOR })).toThrow(FileBackedNoteError);

    expect(repo.get(note.id)!.bodyMd).toBe('start');
    expect(repo.listVersions(note.id)).toHaveLength(1);
  });

  it('rename throws FileBackedNoteError and writes nothing', () => {
    const { service, repo } = setup();
    const note = service.createFileBacked({ projectId: 'p1', title: 'Old', bodyMd: 'body', filePath: '/docs/a.md', sourceHash: 'h1', author: AUTHOR });

    expect(() => service.rename(note.id, { title: 'New', expectedRev: 1, author: AUTHOR })).toThrow(FileBackedNoteError);

    expect(repo.get(note.id)).toMatchObject({ title: 'Old', rev: 1 });
    expect(repo.listVersions(note.id)).toHaveLength(1);
  });

  it('does not affect updateFileBacked, which still writes through the file-backed CAS path', () => {
    const { service } = setup();
    const note = service.createFileBacked({ projectId: 'p1', title: 'Title', bodyMd: 'v1', filePath: '/docs/a.md', sourceHash: 'h1', author: AUTHOR });

    const updated = service.updateFileBacked(note.id, { bodyMd: 'v2', sourceHash: 'h2', expectedRev: 1, author: AUTHOR });

    expect(updated).toMatchObject({ bodyMd: 'v2', sourceHash: 'h2', rev: 2 });
  });

  it('does not refuse a plain (non-file-backed) note', () => {
    const { service } = setup();
    const note = service.create({ projectId: 'p1', title: 'Title', bodyMd: 'v1', author: AUTHOR });

    const updated = service.update(note.id, { bodyMd: 'v2', expectedRev: 1, author: AUTHOR });

    expect(updated.bodyMd).toBe('v2');
  });

  it('still throws NoteNotFoundError, not FileBackedNoteError, for an unknown note', () => {
    const { service } = setup();

    expect(() => service.update('nope', { bodyMd: 'x', expectedRev: 1, author: AUTHOR })).toThrow(NoteNotFoundError);
  });
});

describe('NoteService getExpanded', () => {
  it('renders another project\'s non-shared note exactly like an unknown id', () => {
    const { service } = setup(['p1', 'p2']);
    const otherNote = service.create({ projectId: 'p2', title: 'Secret', bodyMd: 'secret content', author: AUTHOR });
    const unknownId = 'does-not-exist';
    const rootWithOther = service.create({ projectId: 'p1', title: 'Root', bodyMd: `see @note:${otherNote.id}`, author: AUTHOR });
    const rootWithUnknown = service.create({ projectId: 'p1', title: 'Root2', bodyMd: `see @note:${unknownId}`, author: AUTHOR });

    const { expandedBody: expandedOther } = service.getExpanded(rootWithOther.id, { viewerProjectId: 'p1' });
    const { expandedBody: expandedUnknown } = service.getExpanded(rootWithUnknown.id, { viewerProjectId: 'p1' });

    expect(expandedOther).not.toContain('secret content');
    expect(expandedOther.replaceAll(otherNote.id, unknownId)).toBe(expandedUnknown);
  });

  it('expands a shared note from another project', () => {
    const { service } = setup(['p1', 'p2']);
    const otherNote = service.create({ projectId: 'p2', title: 'Shared', bodyMd: 'shared content', shared: true, author: AUTHOR });
    const root = service.create({ projectId: 'p1', title: 'Root', bodyMd: `see @note:${otherNote.id}`, author: AUTHOR });

    const { expandedBody } = service.getExpanded(root.id, { viewerProjectId: 'p1' });

    expect(expandedBody).toContain('shared content');
  });

  it('expands a non-shared note from the viewer\'s own project', () => {
    const { service } = setup();
    const otherNote = service.create({ projectId: 'p1', title: 'Own', bodyMd: 'own content', author: AUTHOR });
    const root = service.create({ projectId: 'p1', title: 'Root', bodyMd: `see @note:${otherNote.id}`, author: AUTHOR });

    const { expandedBody } = service.getExpanded(root.id, { viewerProjectId: 'p1' });

    expect(expandedBody).toContain('own content');
  });

  it('returns the note alongside the expanded body', () => {
    const { service } = setup();
    const note = service.create({ projectId: 'p1', title: 'Root', bodyMd: 'plain body', author: AUTHOR });

    const { note: returnedNote, expandedBody } = service.getExpanded(note.id, { viewerProjectId: 'p1' });

    expect(returnedNote).toEqual(note);
    expect(expandedBody).toContain('plain body');
  });

  it('throws NoteNotFoundError for an unknown note', () => {
    const { service } = setup();

    expect(() => service.getExpanded('nope', { viewerProjectId: 'p1' })).toThrow(NoteNotFoundError);
  });
});
