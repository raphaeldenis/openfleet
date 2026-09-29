import type { ServerResponse } from 'node:http';
import {
  CreateNoteRequestSchema, MAX_NOTE_PAGE_LIMIT, NoteFolderSchema, RestoreNoteRequestSchema, UpdateNoteRequestSchema, pageQuerySchema,
  type Note, type NoteSummary, type NoteView, type Page,
} from '@openfleet/shared';
import { z } from 'zod';
import type { DocsFolderService } from '../notes/docsFolderService.js';
import { NoteFileUnreadableError } from '../notes/docsFolderService.js';
import type { NoteRepository } from '../notes/noteRepository.js';
import { FileBackedNoteError, NoteNotFoundError, NoteTooLargeError, StaleRevisionError, VersionNotFoundError, type NoteService } from '../notes/noteService.js';
import { json, queryParams, type Router } from './router.js';

const REST_AUTHOR = 'You';
const MAX_SEARCH_RESULTS = 50;
const MAX_QUERY_CHARS = 512;
const MAX_QUERY_TERMS = 16;

const ProjectScopeSchema = z.object({ projectId: z.string().min(1) });
const ListNotesQuerySchema = ProjectScopeSchema.extend({ folder: NoteFolderSchema.optional() }).extend(pageQuerySchema(MAX_NOTE_PAGE_LIMIT).shape);
const SearchNotesQuerySchema = ProjectScopeSchema.extend({ q: z.string().max(MAX_QUERY_CHARS).default('') });

export interface NoteRouteDeps {
  notes: NoteService;
  noteRepo: NoteRepository;
  docs: DocsFolderService;
}

const escapeFtsTerms = (terms: string[]) => terms.map((term) => `"${term.replace(/"/g, '""')}"*`).join(' ');

const isForeignKeyError = (error: unknown) =>
  error instanceof Error && (error as NodeJS.ErrnoException).code === 'ERR_SQLITE_ERROR' && /FOREIGN KEY/i.test(error.message);

/** Maps the note domain errors to their HTTP answer; anything else is not a domain error and propagates. */
function respondToNoteErrors(res: ServerResponse, run: () => void): void {
  try {
    run();
  } catch (error) {
    if (error instanceof NoteNotFoundError || error instanceof VersionNotFoundError) return json(res, 404, { error: 'not_found' });
    if (error instanceof StaleRevisionError) return json(res, 409, { error: 'stale_revision', currentRev: error.currentRev });
    if (error instanceof FileBackedNoteError) return json(res, 409, { error: 'file_backed' });
    if (error instanceof NoteFileUnreadableError) return json(res, 409, { error: 'file_unreadable' });
    // ponytail: the 1 MiB JSON body cap fires first, so this is a backstop; drop it if the note cap is ever raised past the body cap
    if (error instanceof NoteTooLargeError) return json(res, 413, { error: 'note_too_large' });
    if (isForeignKeyError(error)) return json(res, 404, { error: 'project_not_found' });
    throw error;
  }
}

export function registerNoteRoutes(router: Router, { notes, noteRepo, docs }: NoteRouteDeps): void {
  const summaryOf = (note: Note): NoteSummary => ({
    id: note.id, title: note.title, folder: note.folder, rev: note.rev, shared: note.shared, fileBacked: note.filePath !== null, updatedAt: note.updatedAt,
  });
  const viewOf = (note: Note): NoteView => ({
    ...summaryOf(note), projectId: note.projectId, bodyMd: note.bodyMd, createdAt: note.createdAt, docsRelativePath: docs.docsRelativePath(note),
  });

  /** An id from another project reads exactly like a missing one. */
  function requireOwnNote(projectId: string, id: string): Note {
    const note = noteRepo.get(id);
    if (!note || note.projectId !== projectId) throw new NoteNotFoundError(id);
    return note;
  }

  function commitBody(current: Note, bodyMd: string, expectedRev: number): Note {
    const write = { bodyMd, expectedRev, author: REST_AUTHOR };
    return current.filePath ? docs.writeThrough(current.id, write) : notes.update(current.id, write);
  }

  router.add('GET', '/api/notes', ({ req, res }) => {
    const { projectId, folder, limit, offset } = ListNotesQuerySchema.parse(queryParams(req));
    const inFolder = noteRepo.list(projectId).filter((note) => folder === undefined || note.folder === folder);
    const page: Page<NoteSummary> = { items: inFolder.slice(offset, offset + limit).map(summaryOf), total: inFolder.length, limit, offset };
    json(res, 200, page);
  });

  router.add('GET', '/api/notes/search', ({ req, res }) => {
    const { projectId, q } = SearchNotesQuerySchema.parse(queryParams(req));
    const terms = q.trim().split(/\s+/).filter((term) => term !== '');
    if (terms.length > MAX_QUERY_TERMS) return json(res, 400, { error: 'invalid_body', detail: `too many terms in query (max ${MAX_QUERY_TERMS})` });
    if (terms.length === 0) return json(res, 200, { items: [], total: 0 });
    const hits = noteRepo.search(escapeFtsTerms(terms), { projectId, limit: MAX_SEARCH_RESULTS });
    const items = hits.map(({ note, snippet }) => ({ ...summaryOf(note), snippet }));
    json(res, 200, { items, total: items.length });
  });

  router.add('GET', '/api/notes/:id', ({ req, res, params }) => {
    const { projectId } = ProjectScopeSchema.parse(queryParams(req));
    respondToNoteErrors(res, () => json(res, 200, viewOf(requireOwnNote(projectId, params.id!))));
  });

  router.add('POST', '/api/notes', ({ res, body }) => {
    const { projectId, title, bodyMd, folder, shared } = CreateNoteRequestSchema.parse(body);
    respondToNoteErrors(res, () => json(res, 201, viewOf(notes.create({ projectId, title, bodyMd, folder, shared, author: REST_AUTHOR }))));
  });

  router.add('PATCH', '/api/notes/:id', ({ res, params, body }) => {
    const { projectId, expectedRev, title, bodyMd } = UpdateNoteRequestSchema.parse(body);
    respondToNoteErrors(res, () => {
      const current = requireOwnNote(projectId, params.id!);
      const isRenamingFileBackedNote = title !== undefined && current.filePath !== null;
      if (isRenamingFileBackedNote) throw new FileBackedNoteError(current.id);
      const afterBody = bodyMd === undefined ? current : commitBody(current, bodyMd, expectedRev);
      const revAfterBody = bodyMd === undefined ? expectedRev : afterBody.rev;
      const afterTitle = title === undefined ? afterBody : notes.rename(current.id, { title, expectedRev: revAfterBody, author: REST_AUTHOR });
      json(res, 200, viewOf(afterTitle));
    });
  });

  router.add('GET', '/api/notes/:id/versions', ({ req, res, params }) => {
    const { projectId } = ProjectScopeSchema.parse(queryParams(req));
    respondToNoteErrors(res, () => {
      requireOwnNote(projectId, params.id!);
      json(res, 200, { items: noteRepo.listVersionSummaries(params.id!) });
    });
  });

  router.add('POST', '/api/notes/:id/restore', ({ res, params, body }) => {
    const { projectId, rev, expectedRev } = RestoreNoteRequestSchema.parse(body);
    respondToNoteErrors(res, () => {
      const current = requireOwnNote(projectId, params.id!);
      const target = noteRepo.getVersion(current.id, rev);
      if (!target) throw new VersionNotFoundError(rev);
      json(res, 200, viewOf(commitBody(current, target.bodyMd, expectedRev ?? current.rev)));
    });
  });
}
