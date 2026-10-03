import { createHash } from 'node:crypto';
import type { Note } from '@openfleet/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openDatabase } from '../db/database.js';
import { createDegradedRegistry, type DegradedRegistry } from '../process/degradedRegistry.js';
import { ProjectRepository } from '../projects/projectRepository.js';
import type { DocsFolderFs } from './docsFolderFs.js';
import {
  DocsFolderService, NoteFileUnreadableError, NoteIsNotFileBackedError, PathEscapesDocsFolderError, ProjectHasNoDocsFolderError, ProjectNotFoundError,
} from './docsFolderService.js';
import { expandMentions } from './mentionExpander.js';
import { NoteRepository } from './noteRepository.js';
import { NoteService, NoteTooLargeError, StaleRevisionError } from './noteService.js';

const AUTHOR = 'rdenisfr@gmail.com';
const FIXED_DOCS_CLOCK = '2026-01-15T10:00:00.000Z';
const MAX_BODY_BYTES = 1024 * 1024;

function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function errnoError(code: string, path: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`${code}: ${path}`), { code });
}

class FakeDocsFolderFs implements DocsFolderFs {
  readonly files = new Map<string, string>();
  /** Files whose read fails with the given errno code (e.g. EACCES) even though they exist. */
  readonly unreadableFiles = new Map<string, string>();
  readonly symlinks = new Map<string, string>();
  readonly dirs = new Set<string>();
  private watchers: { dirPath: string; onEvent: (eventType: 'rename' | 'change', relativePath: string | null) => void }[] = [];

  readFileSync(path: string): string {
    const real = this.realpathSync(path);
    const failureCode = this.unreadableFiles.get(real);
    if (failureCode) throw errnoError(failureCode, path);
    const content = this.files.get(real);
    if (content === undefined) throw errnoError('ENOENT', path);
    return content;
  }

  writeFileExclusiveSync(path: string, contents: string): void {
    if (this.files.has(path)) throw new Error(`EEXIST: ${path}`);
    this.files.set(path, contents);
  }

  renameSync(fromPath: string, toPath: string): void {
    const content = this.files.get(fromPath);
    if (content === undefined) throw errnoError('ENOENT', fromPath);
    this.files.delete(fromPath);
    this.files.set(toPath, content);
  }

  unlinkSync(path: string): void {
    this.files.delete(path);
  }

  existsSync(path: string): boolean {
    return this.files.has(path) || this.dirs.has(path);
  }

  mkdirSync(path: string): void {
    this.dirs.add(path);
  }

  realpathSync(path: string): string {
    return this.symlinks.get(path) ?? path;
  }

  listFilesSync(dirPath: string): string[] {
    const prefix = `${dirPath}/`;
    return [...this.files.keys(), ...this.symlinks.keys()]
      .filter((path) => path.startsWith(prefix) && !path.slice(prefix.length).includes('/'))
      .map((path) => path.slice(prefix.length));
  }

  watch(dirPath: string, onEvent: (eventType: 'rename' | 'change', relativePath: string | null) => void): () => void {
    const entry = { dirPath, onEvent };
    this.watchers.push(entry);
    return () => {
      this.watchers = this.watchers.filter((w) => w !== entry);
    };
  }

  /** Test helper simulating what a real fs.watch would fire once `relativePath` under `dirPath` changes. */
  emit(dirPath: string, relativePath: string, eventType: 'rename' | 'change' = 'change'): void {
    for (const watcher of this.watchers) if (watcher.dirPath === dirPath) watcher.onEvent(eventType, relativePath);
  }
}

function setup({ docsFolderPath = '/docs', degraded }: { docsFolderPath?: string | null; degraded?: DegradedRegistry } = {}) {
  const db = openDatabase(':memory:');
  const projects = new ProjectRepository(db);
  projects.insert({ id: 'p1', name: 'P1', docsFolderPath, createdAt: 't0' });
  const noteRepo = new NoteRepository(db);

  let tick = 0;
  const clock = () => `t${tick++}`;
  let sequence = 0;
  const newId = () => `id-${sequence++}`;
  const notes = new NoteService({ repo: noteRepo, db, expandMentions, clock, newId });

  const fakeFs = new FakeDocsFolderFs();
  const docs = new DocsFolderService({ notes, noteRepo, projects, fs: fakeFs, clock: () => FIXED_DOCS_CLOCK, degraded });

  return { db, projects, noteRepo, notes, fakeFs, docs };
}

describe('DocsFolderService ensureLayout', () => {
  it('creates the four fixed docs subfolders', () => {
    const { fakeFs, docs } = setup();

    docs.ensureLayout('/docs');

    expect(fakeFs.dirs.has('/docs/specs')).toBe(true);
    expect(fakeFs.dirs.has('/docs/plans')).toBe(true);
    expect(fakeFs.dirs.has('/docs/handoffs')).toBe(true);
    expect(fakeFs.dirs.has('/docs/reports')).toBe(true);
  });
});

describe('DocsFolderService createFileBackedNote', () => {
  it('writing through the service updates both the DB row and the file, and the stored hash matches', () => {
    const { fakeFs, noteRepo, docs } = setup();

    const note = docs.createFileBackedNote({ projectId: 'p1', folder: 'specs', title: 'daemon-protocol', bodyMd: '# v1', author: AUTHOR });

    const onDisk = fakeFs.files.get(note.filePath!);
    expect(onDisk).toBe('# v1');
    expect(sha256Hex(onDisk!)).toBe(noteRepo.get(note.id)!.sourceHash);
  });

  it('names the file YYYY-MM-DD-<kebab-slug>.md under the chosen folder', () => {
    const { docs } = setup();

    const note = docs.createFileBackedNote({ projectId: 'p1', folder: 'specs', title: 'Daemon Protocol', bodyMd: 'x', author: AUTHOR });

    expect(note.filePath).toBe('/docs/specs/2026-01-15-daemon-protocol.md');
  });

  it('gives a same-day title collision a -2, then a -3 suffix', () => {
    const { docs } = setup();

    const first = docs.createFileBackedNote({ projectId: 'p1', folder: 'specs', title: 'Daemon Protocol', bodyMd: 'a', author: AUTHOR });
    const second = docs.createFileBackedNote({ projectId: 'p1', folder: 'specs', title: 'Daemon Protocol', bodyMd: 'b', author: AUTHOR });
    const third = docs.createFileBackedNote({ projectId: 'p1', folder: 'specs', title: 'Daemon Protocol', bodyMd: 'c', author: AUTHOR });

    expect(first.filePath).toBe('/docs/specs/2026-01-15-daemon-protocol.md');
    expect(second.filePath).toBe('/docs/specs/2026-01-15-daemon-protocol-2.md');
    expect(third.filePath).toBe('/docs/specs/2026-01-15-daemon-protocol-3.md');
  });

  it('leaves no temp file behind once the note is written', () => {
    const { fakeFs, docs } = setup();

    docs.createFileBackedNote({ projectId: 'p1', folder: 'specs', title: 'x', bodyMd: 'x', author: AUTHOR });

    expect([...fakeFs.files.keys()].some((path) => path.endsWith('.tmp'))).toBe(false);
  });

  it('refuses a symlinked target folder that escapes the docs folder, writing nothing', () => {
    const { fakeFs, noteRepo, docs } = setup();
    fakeFs.symlinks.set('/docs/specs', '/outside');

    expect(() => docs.createFileBackedNote({ projectId: 'p1', folder: 'specs', title: 'x', bodyMd: 'x', author: AUTHOR })).toThrow(PathEscapesDocsFolderError);

    expect(fakeFs.files.size).toBe(0);
    expect(noteRepo.list('p1')).toEqual([]);
  });

  it('throws ProjectNotFoundError for an unknown project', () => {
    const { docs } = setup();

    expect(() => docs.createFileBackedNote({ projectId: 'nope', folder: 'specs', title: 'x', bodyMd: 'x', author: AUTHOR })).toThrow(ProjectNotFoundError);
  });

  it('throws ProjectHasNoDocsFolderError when the project has no docs folder configured', () => {
    const { docs } = setup({ docsFolderPath: null });

    expect(() => docs.createFileBackedNote({ projectId: 'p1', folder: 'specs', title: 'x', bodyMd: 'x', author: AUTHOR })).toThrow(ProjectHasNoDocsFolderError);
  });

  it('checks the size cap before writing any temp file', () => {
    const { fakeFs, docs } = setup();
    const writeSpy = vi.spyOn(fakeFs, 'writeFileExclusiveSync');
    const oversized = 'a'.repeat(MAX_BODY_BYTES + 1);

    expect(() => docs.createFileBackedNote({ projectId: 'p1', folder: 'specs', title: 'x', bodyMd: oversized, author: AUTHOR })).toThrow(NoteTooLargeError);

    expect(writeSpy).not.toHaveBeenCalled();
  });

  it('renames the file into place before attempting the DB insert, so a DB failure leaves no file behind', () => {
    const { fakeFs, noteRepo, notes, docs } = setup();
    const calls: string[] = [];
    const originalRename = fakeFs.renameSync.bind(fakeFs);
    vi.spyOn(fakeFs, 'renameSync').mockImplementation((from, to) => {
      calls.push('rename');
      originalRename(from, to);
    });
    vi.spyOn(notes, 'createFileBacked').mockImplementation(() => {
      calls.push('db-insert');
      throw new Error('db down');
    });

    expect(() => docs.createFileBackedNote({ projectId: 'p1', folder: 'specs', title: 'x', bodyMd: 'v1', author: AUTHOR })).toThrow('db down');

    expect(calls).toEqual(['rename', 'db-insert']);
    expect(fakeFs.files.size).toBe(0);
    expect(noteRepo.list('p1')).toEqual([]);
  });
});

describe('DocsFolderService writeThrough', () => {
  it('updates the file and the DB row together, keeping the hash in sync', () => {
    const { fakeFs, noteRepo, docs } = setup();
    const note = docs.createFileBackedNote({ projectId: 'p1', folder: 'specs', title: 'x', bodyMd: 'v1', author: AUTHOR });

    const updated = docs.writeThrough(note.id, { bodyMd: 'v2', expectedRev: note.rev, author: AUTHOR });

    expect(fakeFs.files.get(note.filePath!)).toBe('v2');
    expect(updated.rev).toBe(2);
    expect(sha256Hex('v2')).toBe(noteRepo.get(note.id)!.sourceHash);
  });

  it('an external edit while the app holds an older rev does not get silently applied over the app write', () => {
    const { fakeFs, docs } = setup();
    const note = docs.createFileBackedNote({ projectId: 'p1', folder: 'specs', title: 'x', bodyMd: 'v1', author: AUTHOR });
    const staleRev = note.rev;

    fakeFs.files.set(note.filePath!, 'edited on disk');
    docs.reconcileOnBoot('p1');

    expect(() => docs.writeThrough(note.id, { bodyMd: 'app version', expectedRev: staleRev, author: AUTHOR })).toThrow(StaleRevisionError);
  });

  it('an unreconciled disk edit is applied as a new "disk" revision and the caller is refused with the new rev', () => {
    const { fakeFs, noteRepo, docs } = setup();
    const note = docs.createFileBackedNote({ projectId: 'p1', folder: 'specs', title: 'x', bodyMd: 'v1', author: AUTHOR });
    fakeFs.files.set(note.filePath!, 'edited on disk');

    const write = () => docs.writeThrough(note.id, { bodyMd: 'app version', expectedRev: note.rev, author: AUTHOR });

    expect(write).toThrow(new StaleRevisionError(2));
    expect(fakeFs.files.get(note.filePath!)).toBe('edited on disk');
    expect(noteRepo.get(note.id)).toMatchObject({ bodyMd: 'edited on disk', rev: 2, sourceHash: sha256Hex('edited on disk') });
    expect(noteRepo.listVersions(note.id).map((version) => version.author)).toEqual([AUTHOR, 'disk']);
  });

  it('on a stale-revision write, removes the temp file and leaves both the target file and the DB row unchanged', () => {
    const { fakeFs, noteRepo, docs } = setup();
    const note = docs.createFileBackedNote({ projectId: 'p1', folder: 'specs', title: 'x', bodyMd: 'v1', author: AUTHOR });

    expect(() => docs.writeThrough(note.id, { bodyMd: 'v2', expectedRev: note.rev + 99, author: AUTHOR })).toThrow(StaleRevisionError);

    expect(fakeFs.files.get(note.filePath!)).toBe('v1');
    expect([...fakeFs.files.keys()].some((path) => path.endsWith('.tmp'))).toBe(false);
    expect(noteRepo.get(note.id)).toMatchObject({ bodyMd: 'v1', rev: 1 });
  });

  it('throws NoteIsNotFileBackedError for a plain note with no file_path', () => {
    const { notes, docs } = setup();
    const plain = notes.create({ projectId: 'p1', title: 'Plain', bodyMd: 'x', author: AUTHOR });

    expect(() => docs.writeThrough(plain.id, { bodyMd: 'y', expectedRev: 1, author: AUTHOR })).toThrow(NoteIsNotFileBackedError);
  });

  it('refuses writeThrough once the note\'s directory has become a symlink escaping the docs folder, writing nothing', () => {
    const { fakeFs, noteRepo, docs } = setup();
    const note = docs.createFileBackedNote({ projectId: 'p1', folder: 'specs', title: 'x', bodyMd: 'v1', author: AUTHOR });
    const filesBefore = new Map(fakeFs.files);
    fakeFs.symlinks.set('/docs/specs', '/outside');

    expect(() => docs.writeThrough(note.id, { bodyMd: 'v2', expectedRev: note.rev, author: AUTHOR })).toThrow(PathEscapesDocsFolderError);

    expect(fakeFs.files).toEqual(filesBefore);
    expect(noteRepo.get(note.id)).toMatchObject({ bodyMd: 'v1', rev: 1 });
  });

  it('refuses to run inside an outer transaction, because an outer rollback could not undo the file rename', () => {
    const { db, fakeFs, noteRepo, docs } = setup();
    const note = docs.createFileBackedNote({ projectId: 'p1', folder: 'specs', title: 'x', bodyMd: 'v1', author: AUTHOR });
    const filesBefore = new Map(fakeFs.files);
    db.exec('BEGIN IMMEDIATE');

    const write = () => docs.writeThrough(note.id, { bodyMd: 'v2', expectedRev: note.rev, author: AUTHOR });

    expect(write).toThrow(/outer transaction/);
    db.exec('ROLLBACK');
    expect(fakeFs.files).toEqual(filesBefore);
    expect(noteRepo.get(note.id)).toMatchObject({ bodyMd: 'v1', rev: 1 });
  });

  it('reports the stuck connection, not an outer transaction, when a failed ROLLBACK left the connection inside a transaction', () => {
    const { db, fakeFs, docs, notes } = setup();
    const note = docs.createFileBackedNote({ projectId: 'p1', folder: 'specs', title: 'x', bodyMd: 'v1', author: AUTHOR });
    const filesBefore = new Map(fakeFs.files);
    const realExec = db.exec.bind(db);
    vi.spyOn(db, 'exec').mockImplementation((sql: string) => {
      if (/^ROLLBACK/.test(sql)) throw new Error('disk I/O error');
      return realExec(sql);
    });
    expect(() => notes.runAtomically(() => { throw new Error('work failed'); })).toThrow('work failed');

    const write = () => docs.writeThrough(note.id, { bodyMd: 'v2', expectedRev: note.rev, author: AUTHOR });

    expect(write).toThrow(/stuck in a transaction/);
    expect(fakeFs.files).toEqual(filesBefore);
  });

  it('heals a stuck connection when the retried ROLLBACK succeeds, so the write goes through', () => {
    const { db, fakeFs, docs, notes } = setup();
    const note = docs.createFileBackedNote({ projectId: 'p1', folder: 'specs', title: 'x', bodyMd: 'v1', author: AUTHOR });
    const realExec = db.exec.bind(db);
    const failRollback = vi.spyOn(db, 'exec').mockImplementation((sql: string) => {
      if (/^ROLLBACK/.test(sql)) throw new Error('disk I/O error');
      return realExec(sql);
    });
    expect(() => notes.runAtomically(() => { throw new Error('work failed'); })).toThrow('work failed');
    failRollback.mockRestore();

    docs.writeThrough(note.id, { bodyMd: 'v2', expectedRev: note.rev, author: AUTHOR });

    expect(fakeFs.files.get(note.filePath!)).toBe('v2');
  });

  it('leaves the file ahead of the database when COMMIT fails after the rename, and reconcileOnBoot then records the file as a "disk" revision', () => {
    const { db, fakeFs, noteRepo, docs } = setup();
    const note = docs.createFileBackedNote({ projectId: 'p1', folder: 'specs', title: 'x', bodyMd: 'v1', author: AUTHOR });
    const realExec = db.exec.bind(db);
    const failCommit = vi.spyOn(db, 'exec').mockImplementation((sql: string) => {
      if (sql === 'COMMIT') throw new Error('disk I/O error');
      return realExec(sql);
    });

    expect(() => docs.writeThrough(note.id, { bodyMd: 'v2', expectedRev: note.rev, author: AUTHOR })).toThrow('disk I/O error');
    failCommit.mockRestore();

    expect(fakeFs.files.get(note.filePath!)).toBe('v2');
    expect(noteRepo.get(note.id)).toMatchObject({ bodyMd: 'v1', rev: 1 });
    const report = docs.reconcileOnBoot('p1');
    expect(report.applied).toEqual([note.id]);
    expect(noteRepo.get(note.id)).toMatchObject({ bodyMd: 'v2', rev: 2, sourceHash: sha256Hex('v2') });
    expect(noteRepo.listVersions(note.id).map((version) => version.author)).toEqual([AUTHOR, 'disk']);
  });

  it('QE: refuses inside a bare SAVEPOINT as well, leaving no stray file and the savepoint intact', () => {
    const { db, fakeFs, noteRepo, docs } = setup();
    const note = docs.createFileBackedNote({ projectId: 'p1', folder: 'specs', title: 'x', bodyMd: 'v1', author: AUTHOR });
    const filesBefore = new Map(fakeFs.files);
    db.exec('SAVEPOINT caller');

    const write = () => docs.writeThrough(note.id, { bodyMd: 'v2', expectedRev: note.rev, author: AUTHOR });

    expect(write).toThrow(/outer transaction/);
    expect(db.isTransaction).toBe(true);
    db.exec('RELEASE caller');
    expect(fakeFs.files).toEqual(filesBefore);
    expect(noteRepo.get(note.id)).toMatchObject({ bodyMd: 'v1', rev: 1 });
  });

  it('QE: after a COMMIT failure past the rename the connection is out of the transaction, no temp file remains, and a second write succeeds once reconciled', () => {
    const { db, fakeFs, noteRepo, docs } = setup();
    const note = docs.createFileBackedNote({ projectId: 'p1', folder: 'specs', title: 'x', bodyMd: 'v1', author: AUTHOR });
    const realExec = db.exec.bind(db);
    const failCommit = vi.spyOn(db, 'exec').mockImplementation((sql: string) => {
      if (sql === 'COMMIT') throw new Error('disk I/O error');
      return realExec(sql);
    });
    expect(() => docs.writeThrough(note.id, { bodyMd: 'v2', expectedRev: note.rev, author: AUTHOR })).toThrow('disk I/O error');
    failCommit.mockRestore();

    expect(db.isTransaction).toBe(false);
    expect([...fakeFs.files.keys()]).toEqual([note.filePath]);
    docs.reconcileOnBoot('p1');
    const reconciled = noteRepo.get(note.id)!;
    const second = docs.writeThrough(note.id, { bodyMd: 'v3', expectedRev: reconciled.rev, author: AUTHOR });
    expect(second).toMatchObject({ bodyMd: 'v3', rev: 3 });
    expect(fakeFs.files.get(note.filePath!)).toBe('v3');
  });

  it('checks the size cap before writing any temp file', () => {
    const { fakeFs, docs } = setup();
    const note = docs.createFileBackedNote({ projectId: 'p1', folder: 'specs', title: 'x', bodyMd: 'v1', author: AUTHOR });
    const writeSpy = vi.spyOn(fakeFs, 'writeFileExclusiveSync');
    const oversized = 'a'.repeat(MAX_BODY_BYTES + 1);

    expect(() => docs.writeThrough(note.id, { bodyMd: oversized, expectedRev: note.rev, author: AUTHOR })).toThrow(NoteTooLargeError);

    expect(writeSpy).not.toHaveBeenCalled();
  });
});

describe('DocsFolderService and the degraded state', () => {
  const codesOf = (degraded: DegradedRegistry) => degraded.list().map((issue) => issue.code);

  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  it('marks docs_folder_unreadable when a note file cannot be read', () => {
    const degraded = createDegradedRegistry();
    const { fakeFs, docs } = setup({ degraded });
    const note = docs.createFileBackedNote({ projectId: 'p1', folder: 'specs', title: 'x', bodyMd: 'v1', author: AUTHOR });
    fakeFs.unreadableFiles.set(note.filePath!, 'EACCES');

    expect(() => docs.writeThrough(note.id, { bodyMd: 'v2', expectedRev: note.rev, author: AUTHOR })).toThrow(NoteFileUnreadableError);

    expect(codesOf(degraded)).toEqual(['docs_folder_unreadable']);
  });

  it('marks it for a note the boot reconcile could not read, without the path in the issue', () => {
    const degraded = createDegradedRegistry();
    const { fakeFs, docs } = setup({ degraded });
    const note = docs.createFileBackedNote({ projectId: 'p1', folder: 'specs', title: 'x', bodyMd: 'v1', author: AUTHOR });
    fakeFs.unreadableFiles.set(note.filePath!, 'EIO');

    docs.reconcileOnBoot('p1');

    expect(degraded.list()).toMatchObject([{ code: 'docs_folder_unreadable' }]);
    expect(JSON.stringify(degraded.list())).not.toContain('/docs');
  });

  it('clears on the next successful read of a note file', () => {
    const degraded = createDegradedRegistry();
    const { fakeFs, docs } = setup({ degraded });
    const note = docs.createFileBackedNote({ projectId: 'p1', folder: 'specs', title: 'x', bodyMd: 'v1', author: AUTHOR });
    fakeFs.unreadableFiles.set(note.filePath!, 'EACCES');
    expect(() => docs.writeThrough(note.id, { bodyMd: 'v2', expectedRev: note.rev, author: AUTHOR })).toThrow(NoteFileUnreadableError);

    fakeFs.unreadableFiles.delete(note.filePath!);
    docs.writeThrough(note.id, { bodyMd: 'v2', expectedRev: note.rev, author: AUTHOR });

    expect(codesOf(degraded)).toEqual([]);
  });

  it('stays marked when a read of another, healthy file succeeds: only the path that failed can clear it', () => {
    const degraded = createDegradedRegistry();
    const { fakeFs, docs } = setup({ degraded });
    const broken = docs.createFileBackedNote({ projectId: 'p1', folder: 'specs', title: 'broken', bodyMd: 'v1', author: AUTHOR });
    docs.createFileBackedNote({ projectId: 'p1', folder: 'specs', title: 'fine', bodyMd: 'v1', author: AUTHOR });
    fakeFs.unreadableFiles.set(broken.filePath!, 'EACCES');

    docs.reconcileOnBoot('p1');

    expect(codesOf(degraded)).toEqual(['docs_folder_unreadable']);
    expect(degraded.list()[0]!.count).toBe(1);
  });

  it('clears once the reconcile reads the path that failed', () => {
    const degraded = createDegradedRegistry();
    const { fakeFs, docs } = setup({ degraded });
    const broken = docs.createFileBackedNote({ projectId: 'p1', folder: 'specs', title: 'broken', bodyMd: 'v1', author: AUTHOR });
    fakeFs.unreadableFiles.set(broken.filePath!, 'EACCES');
    docs.reconcileOnBoot('p1');

    fakeFs.unreadableFiles.delete(broken.filePath!);
    docs.reconcileOnBoot('p1');

    expect(codesOf(degraded)).toEqual([]);
  });

  it('stays healthy when a file is merely missing: that is not an unreadable docs folder', () => {
    const degraded = createDegradedRegistry();
    const { fakeFs, docs } = setup({ degraded });
    const note = docs.createFileBackedNote({ projectId: 'p1', folder: 'specs', title: 'x', bodyMd: 'v1', author: AUTHOR });
    fakeFs.files.delete(note.filePath!);

    docs.reconcileOnBoot('p1');

    expect(codesOf(degraded)).toEqual([]);
  });

  it('forgets an unreadable path whose file was then removed: a missing file no longer holds the issue', () => {
    const degraded = createDegradedRegistry();
    const { fakeFs, docs } = setup({ degraded });
    const note = docs.createFileBackedNote({ projectId: 'p1', folder: 'specs', title: 'x', bodyMd: 'v1', author: AUTHOR });
    fakeFs.unreadableFiles.set(note.filePath!, 'EACCES');
    docs.reconcileOnBoot('p1');

    fakeFs.unreadableFiles.delete(note.filePath!);
    fakeFs.files.delete(note.filePath!);
    docs.reconcileOnBoot('p1');

    expect(codesOf(degraded)).toEqual([]);
  });

  describe('with more unreadable paths than the tracking bound', () => {
    const TRACKED_PATHS_BOUND = 100;
    const unreadableNoteCount = TRACKED_PATHS_BOUND + 1;

    function setupWithEveryNoteUnreadable() {
      const degraded = createDegradedRegistry();
      const { fakeFs, docs } = setup({ degraded });
      const notes = Array.from({ length: unreadableNoteCount }, (_, index) =>
        docs.createFileBackedNote({ projectId: 'p1', folder: 'specs', title: `note ${index}`, bodyMd: 'v1', author: AUTHOR }));
      for (const note of notes) fakeFs.unreadableFiles.set(note.filePath!, 'EACCES');
      docs.reconcileOnBoot('p1');
      const [firstNote, ...laterNotes] = notes;
      return { degraded, fakeFs, docs, firstNote: firstNote!, laterNotes };
    }

    const readAgain = ({ fakeFs, docs }: ReturnType<typeof setupWithEveryNoteUnreadable>, note: Note) => {
      fakeFs.unreadableFiles.delete(note.filePath!);
      docs.writeThrough(note.id, { bodyMd: 'v2', expectedRev: note.rev, author: AUTHOR });
    };

    it('stays marked when only the tracked paths recover and the evicted one is still unreadable', () => {
      const scenario = setupWithEveryNoteUnreadable();

      for (const note of scenario.laterNotes) readAgain(scenario, note);

      expect(codesOf(scenario.degraded)).toEqual(['docs_folder_unreadable']);
    });

    it('clears once a full reconciliation finds every note readable', () => {
      const scenario = setupWithEveryNoteUnreadable();
      for (const note of scenario.laterNotes) readAgain(scenario, note);

      scenario.fakeFs.unreadableFiles.delete(scenario.firstNote.filePath!);
      scenario.docs.reconcileOnBoot('p1');

      expect(codesOf(scenario.degraded)).toEqual([]);
    });
  });
});

describe('DocsFolderService unreadable files', () => {
  it('writeThrough refuses with a typed error when the file exists but cannot be read, overwriting nothing', () => {
    const { fakeFs, noteRepo, docs } = setup();
    const note = docs.createFileBackedNote({ projectId: 'p1', folder: 'specs', title: 'x', bodyMd: 'v1', author: AUTHOR });
    fakeFs.unreadableFiles.set(note.filePath!, 'EACCES');

    const write = () => docs.writeThrough(note.id, { bodyMd: 'v2', expectedRev: note.rev, author: AUTHOR });

    expect(write).toThrow(NoteFileUnreadableError);
    expect(fakeFs.files.get(note.filePath!)).toBe('v1');
    expect(noteRepo.get(note.id)).toMatchObject({ bodyMd: 'v1', rev: 1 });
  });

  it('reconcileOnBoot lists a note whose file cannot be read as unreadable, not missing, and changes nothing', () => {
    const { fakeFs, noteRepo, docs } = setup();
    const note = docs.createFileBackedNote({ projectId: 'p1', folder: 'specs', title: 'x', bodyMd: 'v1', author: AUTHOR });
    fakeFs.unreadableFiles.set(note.filePath!, 'EIO');

    const report = docs.reconcileOnBoot('p1');

    expect(report.unreadable).toEqual([note.id]);
    expect(report.missing).toEqual([]);
    expect(noteRepo.get(note.id)).toMatchObject({ bodyMd: 'v1', rev: 1 });
  });
});

describe('DocsFolderService docsRelativePath', () => {
  it('returns the path relative to the docs folder', () => {
    const { docs } = setup();
    const note = docs.createFileBackedNote({ projectId: 'p1', folder: 'specs', title: 'x', bodyMd: 'v1', author: AUTHOR });

    expect(docs.docsRelativePath(note)).toBe('specs/2026-01-15-x.md');
  });

  it('returns null instead of throwing when the docs folder can no longer be resolved', () => {
    const { fakeFs, docs } = setup();
    const note = docs.createFileBackedNote({ projectId: 'p1', folder: 'specs', title: 'x', bodyMd: 'v1', author: AUTHOR });
    vi.spyOn(fakeFs, 'realpathSync').mockImplementation((path) => { throw errnoError('ENOENT', path); });

    expect(docs.docsRelativePath(note)).toBeNull();
  });

  it('returns null instead of throwing when the project no longer has a docs folder', () => {
    const { db, docs } = setup();
    const note = docs.createFileBackedNote({ projectId: 'p1', folder: 'specs', title: 'x', bodyMd: 'v1', author: AUTHOR });
    db.prepare('UPDATE projects SET docs_folder_path = NULL WHERE id = ?').run('p1');

    expect(docs.docsRelativePath(note)).toBeNull();
  });
});

describe('DocsFolderService attachFolder', () => {
  it('attachFolder is idempotent — running it twice does not duplicate notes', () => {
    const { fakeFs, docs } = setup();
    fakeFs.files.set('/docs/specs/2026-01-01-x.md', '# X');

    const first = docs.attachFolder('p1', '/docs');
    const second = docs.attachFolder('p1', '/docs');

    expect(first).toHaveLength(1);
    expect(second).toHaveLength(0);
  });

  it('classifies each imported note by its subfolder', () => {
    const { fakeFs, docs } = setup();
    fakeFs.files.set('/docs/specs/2026-01-01-a.md', 'a');
    fakeFs.files.set('/docs/plans/2026-01-01-b.md', 'b');

    const imported = docs.attachFolder('p1', '/docs');

    expect(imported.map((note) => note.folder).sort()).toEqual(['plans', 'specs']);
  });

  it('refuses a symlinked file that escapes the docs folder, importing nothing', () => {
    const { fakeFs, noteRepo, docs } = setup();
    fakeFs.files.set('/docs/plans/2026-01-01-ok.md', 'ok');
    fakeFs.symlinks.set('/docs/specs/escape.md', '/outside/secret.md');
    fakeFs.files.set('/outside/secret.md', 'top secret');

    expect(() => docs.attachFolder('p1', '/docs')).toThrow(PathEscapesDocsFolderError);

    expect(noteRepo.list('p1')).toEqual([]);
  });

  it('skips an oversized file — reported by its absence from the returned notes — and imports the rest', () => {
    const { fakeFs, noteRepo, docs } = setup();
    fakeFs.files.set('/docs/specs/2026-01-01-big.md', 'a'.repeat(MAX_BODY_BYTES + 1));
    fakeFs.files.set('/docs/specs/2026-01-01-ok.md', 'fine');

    const imported = docs.attachFolder('p1', '/docs');

    expect(imported.map((note) => note.bodyMd)).toEqual(['fine']);
    expect(noteRepo.getByFilePath('/docs/specs/2026-01-01-big.md')).toBeUndefined();
  });

  it('normalizes a title derived from an NFD-decomposed filename to NFC, leaving the filename on disk untouched', () => {
    const { fakeFs, docs } = setup();
    const nfdFilename = '2026-01-01-café.md'; // "café" spelled with a combining acute accent

    fakeFs.files.set(`/docs/specs/${nfdFilename}`, 'body');

    const imported = docs.attachFolder('p1', '/docs');

    expect(imported).toHaveLength(1);
    expect(imported[0]!.title).toBe('café'); // NFC-composed "café"
    expect(imported[0]!.filePath).toBe(`/docs/specs/${nfdFilename}`);
  });
});

describe('DocsFolderService reconcileOnBoot', () => {
  it('applies a disk edit as a new revision authored "disk"', () => {
    const { fakeFs, noteRepo, docs } = setup();
    const note = docs.createFileBackedNote({ projectId: 'p1', folder: 'specs', title: 'x', bodyMd: 'v1', author: AUTHOR });
    fakeFs.files.set(note.filePath!, 'edited on disk');

    const report = docs.reconcileOnBoot('p1');

    expect(report.applied).toEqual([note.id]);
    const versions = noteRepo.listVersions(note.id);
    expect(versions.at(-1)).toMatchObject({ bodyMd: 'edited on disk', author: 'disk' });
    expect(noteRepo.get(note.id)).toMatchObject({ bodyMd: 'edited on disk', rev: 2 });
  });

  it('does nothing when the file on disk still matches the stored hash', () => {
    const { noteRepo, docs } = setup();
    const note = docs.createFileBackedNote({ projectId: 'p1', folder: 'specs', title: 'x', bodyMd: 'v1', author: AUTHOR });

    const report = docs.reconcileOnBoot('p1');

    expect(report.applied).toEqual([]);
    expect(noteRepo.get(note.id)!.rev).toBe(1);
  });

  it('reports an oversized external edit instead of applying it, leaving the note unchanged', () => {
    const { fakeFs, noteRepo, docs } = setup();
    const note = docs.createFileBackedNote({ projectId: 'p1', folder: 'specs', title: 'x', bodyMd: 'v1', author: AUTHOR });
    fakeFs.files.set(note.filePath!, 'a'.repeat(MAX_BODY_BYTES + 1));

    const report = docs.reconcileOnBoot('p1');

    expect(report.oversized).toEqual([note.id]);
    expect(noteRepo.get(note.id)).toMatchObject({ bodyMd: 'v1', rev: 1 });
  });

  it('reports a missing file-backed note instead of silently skipping it', () => {
    const { fakeFs, noteRepo, docs } = setup();
    const note = docs.createFileBackedNote({ projectId: 'p1', folder: 'specs', title: 'x', bodyMd: 'v1', author: AUTHOR });
    fakeFs.files.delete(note.filePath!);

    const report = docs.reconcileOnBoot('p1');

    expect(report.missing).toEqual([note.id]);
    expect(noteRepo.get(note.id)).toMatchObject({ bodyMd: 'v1', rev: 1 });
  });

  it('reports an escaped note and never reads through a directory swapped for a symlink outside the docs folder', () => {
    const { fakeFs, noteRepo, docs } = setup();
    const note = docs.createFileBackedNote({ projectId: 'p1', folder: 'specs', title: 'x', bodyMd: 'v1', author: AUTHOR });
    fakeFs.symlinks.set('/docs/specs', '/outside');
    fakeFs.symlinks.set(note.filePath!, '/outside/secret.md');
    fakeFs.files.set('/outside/secret.md', 'do not read me');
    const readSpy = vi.spyOn(fakeFs, 'readFileSync');

    const report = docs.reconcileOnBoot('p1');

    expect(report.escaped).toEqual([note.id]);
    expect(readSpy).not.toHaveBeenCalled();
    expect(noteRepo.get(note.id)).toMatchObject({ bodyMd: 'v1', rev: 1 });
  });
});

describe('DocsFolderService watch', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('debounces a burst of change events for the same file into a single reconcile', () => {
    vi.useFakeTimers();
    const { fakeFs, noteRepo, docs } = setup();
    const note = docs.createFileBackedNote({ projectId: 'p1', folder: 'specs', title: 'x', bodyMd: 'v1', author: AUTHOR });
    fakeFs.files.set(note.filePath!, 'edited on disk');

    const unsubscribe = docs.watch('p1');
    fakeFs.emit('/docs', 'specs/2026-01-15-x.md');
    fakeFs.emit('/docs', 'specs/2026-01-15-x.md');
    fakeFs.emit('/docs', 'specs/2026-01-15-x.md');
    vi.runAllTimers();

    expect(noteRepo.listVersions(note.id)).toHaveLength(2); // create + exactly one reconcile
    unsubscribe();
  });

  it('does not treat its own write as an external edit (self-write guard)', () => {
    vi.useFakeTimers();
    const { fakeFs, noteRepo, docs } = setup();
    const note = docs.createFileBackedNote({ projectId: 'p1', folder: 'specs', title: 'x', bodyMd: 'v1', author: AUTHOR });

    const unsubscribe = docs.watch('p1');
    docs.writeThrough(note.id, { bodyMd: 'v2', expectedRev: note.rev, author: AUTHOR });
    fakeFs.emit('/docs', 'specs/2026-01-15-x.md'); // the OS notification for our own rename
    vi.runAllTimers();

    expect(noteRepo.listVersions(note.id)).toHaveLength(2); // create + our own writeThrough, no extra 'disk' version
    unsubscribe();
  });

  it('unsubscribe stops both future events and any already-scheduled reconcile', () => {
    vi.useFakeTimers();
    const { fakeFs, noteRepo, docs } = setup();
    const note = docs.createFileBackedNote({ projectId: 'p1', folder: 'specs', title: 'x', bodyMd: 'v1', author: AUTHOR });
    fakeFs.files.set(note.filePath!, 'edited on disk');

    const unsubscribe = docs.watch('p1');
    fakeFs.emit('/docs', 'specs/2026-01-15-x.md');
    unsubscribe();
    vi.runAllTimers();
    fakeFs.emit('/docs', 'specs/2026-01-15-x.md');
    vi.runAllTimers();

    expect(noteRepo.listVersions(note.id)).toHaveLength(1); // only the create — nothing was ever applied
  });
});
