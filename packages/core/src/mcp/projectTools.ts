import { NOTE_FOLDERS, type NoteFolder, type NoteSummary, type Session } from '@openfleet/shared';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { NoteRepository } from '../notes/noteRepository.js';
import { ProjectNotFoundError } from '../projects/projectErrors.js';
import type { ProjectRecord, ProjectRepository } from '../projects/projectRepository.js';
import { guardedFor } from './toolResults.js';

const MAX_NOTES_PER_FOLDER = 200;

export interface RegisterProjectToolsDeps {
  projects: ProjectRepository;
  noteRepo: NoteRepository;
  caller: Session;
}

const noteEntry = (note: NoteSummary) => ({ id: note.id, title: note.title, fileBacked: note.fileBacked });

export function registerProjectTools(server: McpServer, deps: RegisterProjectToolsDeps): void {
  const { projects, noteRepo, caller } = deps;
  const guarded = guardedFor(caller);

  /** The caller's own project, found by id or by name in any case; anything else reads exactly like a project that does not exist. */
  function findCallerProject(reference: string): ProjectRecord {
    const callerProject = caller.projectId ? projects.get(caller.projectId) : undefined;
    const isReferenceToCallerProject = callerProject !== undefined && (callerProject.id === reference || callerProject.name.toLowerCase() === reference.toLowerCase());
    if (!isReferenceToCallerProject) throw new ProjectNotFoundError(reference);
    return callerProject;
  }

  function folderView(project: ProjectRecord, folder: NoteFolder) {
    const notes = noteRepo.listSummaries(project.id, { folder, limit: MAX_NOTES_PER_FOLDER, offset: 0 });
    const noteCount = noteRepo.count(project.id, folder);
    return { name: folder, noteCount, notes: notes.map(noteEntry), truncated: noteCount > notes.length };
  }

  server.registerTool('list_projects', {
    description: 'Every project: id, name, and whether it has a docs folder (its path is not shown)',
    inputSchema: {},
  }, async () => guarded(() => projects.list().map((project) => ({ id: project.id, name: project.name, hasDocsFolder: project.docsFolderPath !== null }))));

  server.registerTool('list_project_folders', {
    description: `Your project's docs folders (${NOTE_FOLDERS.join(', ')}) with the notes in each (at most ${MAX_NOTES_PER_FOLDER} per folder, truncated says when more exist), plus the notes filed in no folder. `
      + 'project is its name (any case) or its id; only your own project can be listed',
    inputSchema: { project: z.string().min(1) },
  }, async ({ project: reference }) => guarded(() => {
    const project = findCallerProject(reference);
    const unfiledNotes = noteRepo.listUnfiledSummaries(project.id, MAX_NOTES_PER_FOLDER + 1);
    const boundedUnfiledNotes = unfiledNotes.slice(0, MAX_NOTES_PER_FOLDER);
    return {
      project: { id: project.id, name: project.name },
      folders: NOTE_FOLDERS.map((folder) => folderView(project, folder)),
      unfiledNotes: boundedUnfiledNotes.map(noteEntry),
      unfiledTruncated: unfiledNotes.length > boundedUnfiledNotes.length,
    };
  }));
}
