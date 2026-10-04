import { chmodSync, mkdirSync, mkdtempSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../db/database.js';
import { newId } from '../ids.js';
import { ProjectRepository } from '../projects/projectRepository.js';
import { DocsFolderService } from './docsFolderService.js';
import { expandMentions } from './mentionExpander.js';
import { nodeDocsFolderFs } from './nodeDocsFolderFs.js';
import { NoteRepository } from './noteRepository.js';
import { NoteService } from './noteService.js';

const CLOCK = '2026-10-04T10:00:00.000Z';
const isRoot = process.getuid?.() === 0;

let db: DatabaseSync;
let projects: ProjectRepository;
let docs: DocsFolderService;
let docsFolder: string;
let noteCount: () => number;

beforeEach(() => {
  db = openDatabase(':memory:');
  projects = new ProjectRepository(db);
  const noteRepo = new NoteRepository(db);
  const notes = new NoteService({ repo: noteRepo, db, expandMentions, clock: () => CLOCK, newId });
  docs = new DocsFolderService({ notes, noteRepo, projects, fs: nodeDocsFolderFs, clock: () => CLOCK });
  docsFolder = mkdtempSync(join(tmpdir(), 'of-docs-preview-'));
  noteCount = () => (db.prepare('SELECT COUNT(*) AS n FROM notes').get() as { n: number }).n;
});

const projectWithDocsFolder = (docsFolderPath: string | null) => {
  projects.insert({ id: 'p1', name: 'One', docsFolderPath, createdAt: 't0' });
  return 'p1';
};
const preview = (projectId: string) => docs.previewNewNotePath({ projectId, folder: 'handoffs', title: 'Gimli' });

describe('DocsFolderService.previewNewNotePath', () => {
  it('reports the project as missing for an unknown project id', () => {
    expect(preview('nope')).toEqual({ outcome: 'no_project' });
  });

  it('reports no docs folder for a project without one', () => {
    const projectId = projectWithDocsFolder(null);

    expect(preview(projectId)).toEqual({ outcome: 'no_docs_folder' });
  });

  it('returns the dated relative path the note would get', () => {
    const projectId = projectWithDocsFolder(docsFolder);
    docs.ensureLayout(docsFolder);

    expect(preview(projectId)).toEqual({ outcome: 'ready', relativePath: 'handoffs/2026-10-04-gimli.md' });
  });

  it('skips taken names with the same suffix rule as the creation', () => {
    const projectId = projectWithDocsFolder(docsFolder);
    docs.ensureLayout(docsFolder);
    writeFileSync(join(docsFolder, 'handoffs', '2026-10-04-gimli.md'), 'x');
    writeFileSync(join(docsFolder, 'handoffs', '2026-10-04-gimli-2.md'), 'x');

    expect(preview(projectId)).toEqual({ outcome: 'ready', relativePath: 'handoffs/2026-10-04-gimli-3.md' });
  });

  it('names the note exactly as the creation then does', () => {
    const projectId = projectWithDocsFolder(docsFolder);
    docs.ensureLayout(docsFolder);
    writeFileSync(join(docsFolder, 'handoffs', '2026-10-04-gimli.md'), 'x');
    const predicted = preview(projectId);

    const created = docs.createFileBackedNote({ projectId, folder: 'handoffs', title: 'Gimli', bodyMd: 'b', author: 'a' });

    expect(predicted).toEqual({ outcome: 'ready', relativePath: docs.docsRelativePath(created) });
  });

  it('writes nothing and adds no note row', () => {
    const projectId = projectWithDocsFolder(docsFolder);
    docs.ensureLayout(docsFolder);
    const before = readdirSync(join(docsFolder, 'handoffs'));
    const notesBefore = noteCount();

    preview(projectId);

    expect(readdirSync(join(docsFolder, 'handoffs'))).toEqual(before);
    expect(noteCount()).toBe(notesBefore);
  });

  it('reports the folder unusable when the configured folder does not exist', () => {
    const projectId = projectWithDocsFolder(join(docsFolder, 'gone'));

    expect(preview(projectId)).toEqual({ outcome: 'unusable' });
  });

  it('reports the folder unusable when the handoffs subfolder is missing', () => {
    const projectId = projectWithDocsFolder(docsFolder);

    expect(preview(projectId)).toEqual({ outcome: 'unusable' });
  });

  it('reports the folder unusable when handoffs is a symlink leaving the docs folder', () => {
    const projectId = projectWithDocsFolder(docsFolder);
    const outside = mkdtempSync(join(tmpdir(), 'of-outside-'));
    symlinkSync(outside, join(docsFolder, 'handoffs'));

    expect(preview(projectId)).toEqual({ outcome: 'unusable' });
  });

  it.skipIf(isRoot)('reports the folder unusable when the handoffs folder is read-only', () => {
    const projectId = projectWithDocsFolder(docsFolder);
    mkdirSync(join(docsFolder, 'handoffs'));
    chmodSync(join(docsFolder, 'handoffs'), 0o555);

    try {
      expect(preview(projectId)).toEqual({ outcome: 'unusable' });
    } finally {
      chmodSync(join(docsFolder, 'handoffs'), 0o755);
    }
  });
});
