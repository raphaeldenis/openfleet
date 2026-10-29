import { existsSync, mkdirSync, realpathSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { OpenFleetError } from '@openfleet/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../db/database.js';
import { newId } from '../ids.js';
import { DocsFolderService } from '../notes/docsFolderService.js';
import { DocsRootSettings } from '../notes/docsRootSettings.js';
import { expandMentions } from '../notes/mentionExpander.js';
import { nodeDocsFolderFs } from '../notes/nodeDocsFolderFs.js';
import { NoteRepository } from '../notes/noteRepository.js';
import { NoteService } from '../notes/noteService.js';
import { createTempDirTracker } from '../tempDirTracker.js';
import { ProjectRepository } from './projectRepository.js';
import { ProjectService } from './projectService.js';

const CLOCK = '2026-10-29T10:00:00.000Z';
const tempDirs = createTempDirTracker();

let db: DatabaseSync;
let projects: ProjectRepository;
let projectService: ProjectService;
let rootFolder: string;

const projectRowCount = () => (db.prepare('SELECT COUNT(*) AS n FROM projects').get() as { n: number }).n;

const refusalOf = (run: () => unknown): OpenFleetError => {
  try {
    run();
  } catch (error) {
    return error as OpenFleetError;
  }
  throw new Error('expected a refusal');
};

beforeEach(() => {
  db = openDatabase(':memory:');
  const homeDir = realpathSync(tempDirs.make('of-shared-folder-home-'));
  const docsRoot = new DocsRootSettings({ configPath: join(homeDir, 'config.json'), homeDir, openfleetHome: join(homeDir, '.openfleet') });
  rootFolder = docsRoot.view().root;
  projects = new ProjectRepository(db);
  const noteRepo = new NoteRepository(db);
  const notes = new NoteService({ repo: noteRepo, db, expandMentions, clock: () => CLOCK, newId });
  const docs = new DocsFolderService({ notes, noteRepo, projects, fs: nodeDocsFolderFs, clock: () => CLOCK });
  projectService = new ProjectService({ projects, docs, noteRepo, docsRoot, clock: () => CLOCK, newId });
});

afterEach(() => tempDirs.removeAll());

describe('ProjectService docs folder shared with another project', () => {
  it('refuses a creation whose folder is already the folder of a project, and names that project', () => {
    const sharedFolder = join(rootFolder, 'Fleet');
    projectService.create({ name: 'Fleet', docsFolderPath: sharedFolder });

    const refusal = refusalOf(() => projectService.create({ name: 'Fleet bis', docsFolderPath: sharedFolder }));

    expect(refusal).toMatchObject({ code: 'docs_folder_already_used' });
    expect(refusal.message).toContain('Fleet');
    expect(projectRowCount()).toBe(1);
  });

  it('refuses a folder reached through a symbolic link', () => {
    const realFolder = join(rootFolder, 'Fleet');
    projectService.create({ name: 'Fleet', docsFolderPath: realFolder });
    const linkToFolder = join(rootFolder, 'Link');
    symlinkSync(realFolder, linkToFolder);

    const refusal = refusalOf(() => projectService.create({ name: 'Via link', docsFolderPath: linkToFolder }));

    expect(refusal).toMatchObject({ code: 'docs_folder_already_used' });
  });

  it('refuses a folder that differs only by letter case when the filesystem ignores case', () => {
    const upperCaseFolder = join(rootFolder, 'Fleet');
    projectService.create({ name: 'Fleet', docsFolderPath: upperCaseFolder });
    const lowerCaseFolder = join(rootFolder, 'fleet');
    const isFilesystemCaseInsensitive = existsSync(lowerCaseFolder);
    if (!isFilesystemCaseInsensitive) return;

    const refusal = refusalOf(() => projectService.create({ name: 'Lower', docsFolderPath: lowerCaseFolder }));

    expect(refusal).toMatchObject({ code: 'docs_folder_already_used' });
  });

  it('accepts a folder that is not used by any project', () => {
    projectService.create({ name: 'Fleet', docsFolderPath: join(rootFolder, 'Fleet') });

    projectService.create({ name: 'Other', docsFolderPath: join(rootFolder, 'Other') });

    expect(projectRowCount()).toBe(2);
  });

  it('refuses an update that moves a project onto the folder of another project and leaves it unchanged', () => {
    const sharedFolder = join(rootFolder, 'Fleet');
    projectService.create({ name: 'Fleet', docsFolderPath: sharedFolder });
    const otherFolder = join(rootFolder, 'Other');
    const other = projectService.create({ name: 'Other', docsFolderPath: otherFolder });

    const refusal = refusalOf(() => projectService.update(other.id, { docsFolderPath: sharedFolder }));

    expect(refusal).toMatchObject({ code: 'docs_folder_already_used' });
    expect(projects.get(other.id)?.docsFolderPath).toBe(otherFolder);
  });

  describe('projects that already share a folder', () => {
    let sharedFolder: string;
    let second: { id: string };

    beforeEach(() => {
      sharedFolder = join(rootFolder, 'Fleet');
      mkdirSync(sharedFolder, { recursive: true });
      projects.insert({ id: 'p1', name: 'Fleet', docsFolderPath: sharedFolder, createdAt: CLOCK });
      projects.insert({ id: 'p2', name: 'Fleet copy', docsFolderPath: sharedFolder, createdAt: CLOCK });
      second = { id: 'p2' };
    });

    it('accepts an update that renames the project', () => {
      const updated = projectService.update(second.id, { name: 'Renamed' });

      expect(updated.name).toBe('Renamed');
    });

    it('accepts an update that sends the folder it already has', () => {
      const updated = projectService.update(second.id, { docsFolderPath: sharedFolder });

      expect(updated.docsFolderPath).toBe(sharedFolder);
    });
  });
});
