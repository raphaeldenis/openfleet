import { chmodSync, mkdirSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../db/database.js';
import { ProjectRepository } from '../projects/projectRepository.js';
import { createTempDirTracker } from '../tempDirTracker.js';
import { DocsFolderNotWritableError, DocsFolderService, InvalidDocsFolderError, PathEscapesDocsFolderError } from './docsFolderService.js';
import { expandMentions } from './mentionExpander.js';
import { nodeDocsFolderFs } from './nodeDocsFolderFs.js';
import { NoteRepository } from './noteRepository.js';
import { NoteService } from './noteService.js';

const isRoot = process.getuid?.() === 0;
const tempDirs = createTempDirTracker();
afterEach(() => tempDirs.removeAll());

function aDocsFolderService(): DocsFolderService {
  const db = openDatabase(':memory:');
  const noteRepo = new NoteRepository(db);
  const notes = new NoteService({ repo: noteRepo, db, expandMentions, clock: () => '2026-10-04T10:00:00.000Z', newId: () => 'n1' });
  return new DocsFolderService({ notes, noteRepo, projects: new ProjectRepository(db), fs: nodeDocsFolderFs, clock: () => '2026-10-04T10:00:00.000Z' });
}

describe('DocsFolderService attachFolder on a folder with a partial layout', () => {
  it('imports the notes of the docs subfolders that exist and ignores the ones that do not', () => {
    const folder = tempDirs.make('of-attach-partial-');
    mkdirSync(join(folder, 'specs'));
    writeFileSync(join(folder, 'specs', '2026-10-01-design.md'), '# Design');
    const db = openDatabase(':memory:');
    const projects = new ProjectRepository(db);
    projects.insert({ id: 'p1', name: 'Fleet', docsFolderPath: folder, createdAt: 't0' });
    const noteRepo = new NoteRepository(db);
    const notes = new NoteService({ repo: noteRepo, db, expandMentions, clock: () => '2026-10-04T10:00:00.000Z', newId: () => 'n1' });
    const docs = new DocsFolderService({ notes, noteRepo, projects, fs: nodeDocsFolderFs, clock: () => '2026-10-04T10:00:00.000Z' });

    const imported = docs.attachFolder('p1', folder);

    expect(imported.map((note) => note.title)).toEqual(['design']);
    expect(readdirSync(folder)).toEqual(['specs']);
  });
});

describe('DocsFolderService prepareFolder', () => {
  it('creates the four docs subfolders inside the folder and nothing beside it', () => {
    const parent = tempDirs.make('of-prepare-parent-');
    const folder = join(parent, 'docs');
    mkdirSync(folder);

    aDocsFolderService().prepareFolder(folder);

    expect(readdirSync(folder).sort()).toEqual(['handoffs', 'plans', 'reports', 'specs']);
    expect(readdirSync(parent)).toEqual(['docs']);
  });

  it('keeps the files already in the folder', () => {
    const folder = tempDirs.make('of-prepare-existing-');
    mkdirSync(join(folder, 'specs'));
    writeFileSync(join(folder, 'specs', '2026-10-01-design.md'), '# Design');

    aDocsFolderService().prepareFolder(folder);

    expect(readdirSync(join(folder, 'specs'))).toEqual(['2026-10-01-design.md']);
  });

  it.each([['a relative path', 'docs/notes'], ['a dot path', '.'], ['an empty path', '']])('refuses %s', (_label, path) => {
    expect(() => aDocsFolderService().prepareFolder(path)).toThrow(InvalidDocsFolderError);
  });

  it('refuses a folder that does not exist and does not create it', () => {
    const parent = tempDirs.make('of-prepare-missing-');
    const missing = join(parent, 'not-there');

    expect(() => aDocsFolderService().prepareFolder(missing)).toThrow(InvalidDocsFolderError);
    expect(readdirSync(parent)).toEqual([]);
  });

  it('refuses a path that is a file', () => {
    const parent = tempDirs.make('of-prepare-file-');
    const file = join(parent, 'notes.md');
    writeFileSync(file, 'x');

    expect(() => aDocsFolderService().prepareFolder(file)).toThrow(InvalidDocsFolderError);
  });

  it('refuses a path with a NUL character', () => {
    expect(() => aDocsFolderService().prepareFolder('/tmp/of\0docs')).toThrow(InvalidDocsFolderError);
  });

  it('never puts the folder path in the refusal message', () => {
    const parent = tempDirs.make('of-prepare-message-');
    const missing = join(parent, 'secret-client-name');

    expect(() => aDocsFolderService().prepareFolder(missing)).toThrow(expect.objectContaining({ message: expect.not.stringContaining('secret-client-name') }));
  });

  it.skipIf(isRoot)('refuses a read-only folder and creates nothing in it', () => {
    const folder = tempDirs.make('of-prepare-readonly-');
    chmodSync(folder, 0o500);

    expect(() => aDocsFolderService().prepareFolder(folder)).toThrow(DocsFolderNotWritableError);
    chmodSync(folder, 0o700);
    expect(readdirSync(folder)).toEqual([]);
  });

  it('refuses a docs subfolder that is a symlink to a directory outside the folder, and writes nothing outside', () => {
    const folder = tempDirs.make('of-prepare-escape-');
    const outside = tempDirs.make('of-prepare-outside-');
    symlinkSync(outside, join(folder, 'handoffs'));

    expect(() => aDocsFolderService().prepareFolder(folder)).toThrow(PathEscapesDocsFolderError);
    expect(readdirSync(outside)).toEqual([]);
  });

  it('accepts a folder reached through a symlink and lays out the real folder', () => {
    const realFolder = tempDirs.make('of-prepare-real-');
    const linkParent = tempDirs.make('of-prepare-link-');
    const link = join(linkParent, 'docs-link');
    symlinkSync(realFolder, link);

    aDocsFolderService().prepareFolder(link);

    expect(readdirSync(realFolder).sort()).toEqual(['handoffs', 'plans', 'reports', 'specs']);
  });
});
