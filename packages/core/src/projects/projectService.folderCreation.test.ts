import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../db/database.js';
import { newId } from '../ids.js';
import { DocsFolderService, DocsFolderNotWritableError, InvalidDocsFolderError } from '../notes/docsFolderService.js';
import { DocsRootSettings } from '../notes/docsRootSettings.js';
import { expandMentions } from '../notes/mentionExpander.js';
import { nodeDocsFolderFs } from '../notes/nodeDocsFolderFs.js';
import { NoteRepository } from '../notes/noteRepository.js';
import { NoteService } from '../notes/noteService.js';
import { createTempDirTracker } from '../tempDirTracker.js';
import { ProjectRepository } from './projectRepository.js';
import { ProjectService } from './projectService.js';

const CLOCK = '2026-10-29T10:00:00.000Z';
const isRoot = process.getuid?.() === 0;
const tempDirs = createTempDirTracker();

let db: DatabaseSync;
let homeDir: string;
let docsRoot: DocsRootSettings;
let projectService: ProjectService;
let rootFolder: string;

const projectRowCount = () => (db.prepare('SELECT COUNT(*) AS n FROM projects').get() as { n: number }).n;

beforeEach(() => {
  db = openDatabase(':memory:');
  homeDir = realpathSync(tempDirs.make('of-folder-home-'));
  docsRoot = new DocsRootSettings({ configPath: join(homeDir, 'config.json'), homeDir, openfleetHome: join(homeDir, '.openfleet') });
  rootFolder = docsRoot.view().root;
  const projects = new ProjectRepository(db);
  const noteRepo = new NoteRepository(db);
  const notes = new NoteService({ repo: noteRepo, db, expandMentions, clock: () => CLOCK, newId });
  const docs = new DocsFolderService({ notes, noteRepo, projects, fs: nodeDocsFolderFs, clock: () => CLOCK });
  projectService = new ProjectService({ projects, docs, noteRepo, docsRoot, clock: () => CLOCK, newId });
});

afterEach(() => {
  if (existsSync(rootFolder)) chmodSync(rootFolder, 0o755);
});

describe('ProjectService.create docs folder creation', () => {
  it('creates the proposed folder when it does not exist yet', () => {
    const proposedFolder = join(rootFolder, 'Fleet');

    projectService.create({ name: 'Fleet', docsFolderPath: proposedFolder });

    expect(existsSync(proposedFolder)).toBe(true);
    expect(projectRowCount()).toBe(1);
  });

  it('accepts an existing empty folder', () => {
    const emptyFolder = join(rootFolder, 'Fleet');
    mkdirSync(emptyFolder, { recursive: true });

    projectService.create({ name: 'Fleet', docsFolderPath: emptyFolder });

    expect(projectRowCount()).toBe(1);
  });

  it('accepts an existing non-empty folder and leaves its files untouched', () => {
    const filledFolder = join(rootFolder, 'Fleet');
    mkdirSync(filledFolder, { recursive: true });
    const keptFile = join(filledFolder, 'keep.txt');
    writeFileSync(keptFile, 'original content');

    projectService.create({ name: 'Fleet', docsFolderPath: filledFolder });

    expect(readFileSync(keptFile, 'utf8')).toBe('original content');
    expect(readdirSync(filledFolder)).toContain('keep.txt');
    expect(projectRowCount()).toBe(1);
  });

  it('creates a missing folder under the docs root typed with a trailing slash', () => {
    const typedFolder = `${join(rootFolder, 'Fleet2')}/`;

    projectService.create({ name: 'Fleet', docsFolderPath: typedFolder });

    expect(existsSync(join(rootFolder, 'Fleet2'))).toBe(true);
    expect(projectRowCount()).toBe(1);
  });

  it('accepts an existing folder outside the docs root typed with a trailing slash', () => {
    const existingFolder = join(homeDir, 'repo');
    mkdirSync(existingFolder);

    projectService.create({ name: 'Fleet', docsFolderPath: `${existingFolder}/` });

    expect(projectRowCount()).toBe(1);
  });

  it('accepts a non-empty folder under the docs root typed with a trailing slash and leaves its files untouched', () => {
    const filledFolder = join(rootFolder, 'Fleet');
    mkdirSync(filledFolder, { recursive: true });
    const keptFile = join(filledFolder, 'keep.txt');
    writeFileSync(keptFile, 'original content');

    projectService.create({ name: 'Fleet', docsFolderPath: `${filledFolder}/` });

    expect(readFileSync(keptFile, 'utf8')).toBe('original content');
    expect(projectRowCount()).toBe(1);
  });

  it('creates a missing folder under the docs root typed with doubled slashes', () => {
    const typedFolder = `${rootFolder}//Fleet3`;

    projectService.create({ name: 'Fleet', docsFolderPath: typedFolder });

    expect(existsSync(join(rootFolder, 'Fleet3'))).toBe(true);
    expect(projectRowCount()).toBe(1);
  });

  it('stores the docs folder of an update without its trailing slash', () => {
    const existingFolder = join(homeDir, 'repo');
    mkdirSync(existingFolder);
    const project = projectService.create({ name: 'Fleet' });

    const updated = projectService.update(project.id, { docsFolderPath: `${existingFolder}/` });

    expect(updated.docsFolderPath).toBe(existingFolder);
  });

  it('stores the docs folder of an update without its doubled slashes', () => {
    const existingFolder = join(homeDir, 'repo');
    mkdirSync(existingFolder);
    const project = projectService.create({ name: 'Fleet' });

    const updated = projectService.update(project.id, { docsFolderPath: `${homeDir}//repo` });

    expect(updated.docsFolderPath).toBe(existingFolder);
  });

  it('refuses a path that goes through a symbolic link leaving the docs root, and creates nothing', () => {
    const outsideFolder = join(homeDir, 'outside');
    mkdirSync(outsideFolder);
    mkdirSync(rootFolder, { recursive: true });
    symlinkSync(outsideFolder, join(rootFolder, 'link'));

    const attempt = () => projectService.create({ name: 'Fleet', docsFolderPath: join(rootFolder, 'link', 'Fleet') });

    expect(attempt).toThrow();
    expect(existsSync(join(outsideFolder, 'Fleet'))).toBe(false);
    expect(projectRowCount()).toBe(0);
  });

  it.each([
    ['a parent traversal', '../x'],
    ['a slash', 'a/b'],
    ['a NUL character', 'x\u0000y'],
    ['300 characters', 'a'.repeat(300)],
  ])('proposes a folder directly under the docs root for a name with %s, and creates it', (_label, hostileName) => {
    const { proposedPath } = docsRoot.view({ projectName: hostileName });

    projectService.create({ name: 'Fleet', docsFolderPath: proposedPath! });

    expect(dirname(proposedPath!)).toBe(rootFolder);
    expect(existsSync(proposedPath!)).toBe(true);
    expect(projectRowCount()).toBe(1);
  });

  it('does not create a folder whose path climbs out of the docs root, and keeps no project', () => {
    const escapingFolder = join(rootFolder, '..', 'escaped');

    const attempt = () => projectService.create({ name: 'Fleet', docsFolderPath: escapingFolder });

    expect(attempt).toThrow(InvalidDocsFolderError);
    expect(existsSync(join(rootFolder, '..', 'escaped'))).toBe(false);
    expect(projectRowCount()).toBe(0);
  });

  it('refuses with a typed error a typed folder segment of 300 characters', () => {
    mkdirSync(rootFolder, { recursive: true });

    const attempt = () => docsRoot.ensureProjectFolder(join(rootFolder, 'a'.repeat(300)));

    expect(attempt).toThrow(InvalidDocsFolderError);
  });

  it('refuses with a typed error a folder below a file', () => {
    mkdirSync(rootFolder, { recursive: true });
    writeFileSync(join(rootFolder, 'f.txt'), 'a file');

    const attempt = () => docsRoot.ensureProjectFolder(join(rootFolder, 'f.txt', 'Fleet'));

    expect(attempt).toThrow(InvalidDocsFolderError);
  });

  it('refuses a path with a parent traversal after a symbolic link leaving the docs root, and creates nothing', () => {
    const outsideFolder = join(homeDir, 'outside');
    mkdirSync(outsideFolder);
    mkdirSync(rootFolder, { recursive: true });
    symlinkSync(outsideFolder, join(rootFolder, 'link'));
    const traversingPath = `${rootFolder}/link/../x`;

    const attempt = () => docsRoot.ensureProjectFolder(traversingPath);

    expect(attempt).toThrow(InvalidDocsFolderError);
    expect(existsSync(join(homeDir, 'x'))).toBe(false);
    expect(existsSync(join(rootFolder, 'x'))).toBe(false);
  });

  it('does not create a folder under a reserved home folder', () => {
    const reservedFolder = join(homeDir, '.claude', 'Fleet');

    const attempt = () => projectService.create({ name: 'Fleet', docsFolderPath: reservedFolder });

    expect(attempt).toThrow(InvalidDocsFolderError);
    expect(existsSync(reservedFolder)).toBe(false);
    expect(projectRowCount()).toBe(0);
  });

  it.skipIf(isRoot)('keeps no project row when the folder cannot be created', () => {
    mkdirSync(rootFolder, { recursive: true });
    chmodSync(rootFolder, 0o555);

    const attempt = () => projectService.create({ name: 'Fleet', docsFolderPath: join(rootFolder, 'Fleet') });

    expect(attempt).toThrow(DocsFolderNotWritableError);
    expect(projectRowCount()).toBe(0);
  });
});
