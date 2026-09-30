import {
  CreateNoteRequestSchema, MAX_NOTE_PAGE_LIMIT, NoteFolderSchema, OpenFleetError, RestoreNoteRequestSchema, UpdateNoteRequestSchema, pageQuerySchema, queryInteger,
  type Note, type NoteSummary, type NoteVersionSummary, type NoteView, type Page,
} from '@openfleet/shared';
import { z } from 'zod';
import type { DocsFolderService } from '../notes/docsFolderService.js';
import { MAX_QUERY_CHARS, MAX_QUERY_TERMS, MAX_SEARCH_RESULTS, buildFtsQuery } from '../notes/ftsQuery.js';
import type { NoteRepository } from '../notes/noteRepository.js';
import { FileBackedNoteError, NoteNotFoundError, VersionNotFoundError, type NoteService } from '../notes/noteService.js';
import { json, queryParams, type Router } from './router.js';

const REST_AUTHOR = 'You';

const ProjectScopeSchema = z.object({ projectId: z.string().min(1) });
const ListNotesQuerySchema = ProjectScopeSchema.extend({ folder: NoteFolderSchema.optional() }).extend(pageQuerySchema(MAX_NOTE_PAGE_LIMIT).shape);
const VersionsQuerySchema = ProjectScopeSchema.extend(pageQuerySchema(MAX_NOTE_PAGE_LIMIT).shape);
const SearchNotesQuerySchema = ProjectScopeSchema.extend({ q: z.string().max(MAX_QUERY_CHARS).default(''),
  limit: queryInteger.pipe(z.number().min(1).max(MAX_SEARCH_RESULTS)).default(MAX_SEARCH_RESULTS),
  offset: queryInteger.default(0),
});

export interface NoteRouteDeps {
  notes: NoteService;
  noteRepo: NoteRepository;
  docs: DocsFolderService;
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

  function assertOwnNote(projectId: string, id: string): void {
    if (noteRepo.getProjectId(id) !== projectId) throw new NoteNotFoundError(id);
  }

  function commitBody(current: Note, bodyMd: string, expectedRev: number): Note {
    const write = { bodyMd, expectedRev, author: REST_AUTHOR };
    return current.filePath ? docs.writeThrough(current.id, write) : notes.update(current.id, write);
  }

  function applyPatch(current: Note, { title, bodyMd, expectedRev }: { title?: string; bodyMd?: string; expectedRev: number }): Note {
    const write = { expectedRev, author: REST_AUTHOR };
    if (title !== undefined && bodyMd !== undefined) return notes.updateBodyAndTitle(current.id, { ...write, title, bodyMd });
    if (title !== undefined) return notes.rename(current.id, { ...write, title });
    return commitBody(current, bodyMd!, expectedRev);
  }

  router.add('GET', '/api/notes',({ req, res }) => {
    const { projectId, folder, limit, offset } = ListNotesQuerySchema.parse(queryParams(req));
    const items = limit === 0 ? [] : noteRepo.listSummaries(projectId, { folder, limit, offset });
    const page: Page<NoteSummary> = { items, total: noteRepo.count(projectId, folder), limit, offset };
    json(res, 200, page);
  });

  router.add('GET', '/api/notes/search', ({ req, res }) => {
    const { projectId, q, limit, offset } = SearchNotesQuerySchema.parse(queryParams(req));
    const ftsQuery = buildFtsQuery(q);
    if (ftsQuery.outcome === 'too_many_terms') throw new OpenFleetError('invalid_body', 'the search query has too many terms.', { detail: `too many terms in query (max ${MAX_QUERY_TERMS})` });
    if (ftsQuery.outcome === 'blank') return json(res, 200, { items: [], total: 0, limit, offset });
    const hits = noteRepo.searchSummaries(ftsQuery.match, { projectId, limit, offset });
    const items = hits.map(({ note, snippet }) => ({ ...note, snippet }));
    json(res, 200, { items, total: noteRepo.countSearchMatches(ftsQuery.match, projectId), limit, offset });
  });

  router.add('GET', '/api/notes/:id', ({ req, res, params }) => {
    const { projectId } = ProjectScopeSchema.parse(queryParams(req));
    json(res, 200, viewOf(requireOwnNote(projectId, params.id!)));
  });

  router.add('POST', '/api/notes', ({ res, body }) => {
    const { projectId, title, bodyMd, folder, shared } = CreateNoteRequestSchema.parse(body);
    json(res, 201, viewOf(notes.create({ projectId, title, bodyMd, folder, shared, author: REST_AUTHOR })));
  });

  router.add('PATCH', '/api/notes/:id', ({ res, params, body }) => {
    const { projectId, expectedRev, title, bodyMd } = UpdateNoteRequestSchema.parse(body);
    const current = requireOwnNote(projectId, params.id!);
    const isRenamingFileBackedNote = title !== undefined && current.filePath !== null;
    if (isRenamingFileBackedNote) throw new FileBackedNoteError(current.id);
    json(res, 200, viewOf(applyPatch(current, { title, bodyMd, expectedRev })));
  });

  router.add('GET', '/api/notes/:id/versions', ({ req, res, params }) => {
    const { projectId, limit, offset } = VersionsQuerySchema.parse(queryParams(req));
    assertOwnNote(projectId, params.id!);
    const items = noteRepo.listVersionSummaries(params.id!, { limit, offset });
    const page: Page<NoteVersionSummary> = { items, total: noteRepo.countVersions(params.id!), limit, offset };
    json(res, 200, page);
  });

  router.add('POST', '/api/notes/:id/restore', ({ res, params, body }) => {
    const { projectId, rev, expectedRev } = RestoreNoteRequestSchema.parse(body);
    const current = requireOwnNote(projectId, params.id!);
    const target = noteRepo.getVersion(current.id, rev);
    if (!target) throw new VersionNotFoundError(rev);
    json(res, 200, viewOf(commitBody(current, target.bodyMd, expectedRev)));
  });
}
