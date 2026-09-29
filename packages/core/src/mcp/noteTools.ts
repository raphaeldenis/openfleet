import { NoteFolderSchema, type Session } from '@openfleet/shared';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { DocsFolderService } from '../notes/docsFolderService.js';
import { FileBackedNoteError, NoteNotFoundError, StaleRevisionError, type NoteService } from '../notes/noteService.js';
import type { NoteRepository } from '../notes/noteRepository.js';

const ok = (payload: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(payload) }] });
const fail = (message: string) => ({ content: [{ type: 'text' as const, text: message }], isError: true });

const MAX_LIST_RESULTS = 200;
const MAX_SEARCH_RESULTS = 50;

export interface RegisterNoteToolsDeps {
  notes: NoteService;
  noteRepo: NoteRepository;
  docs: DocsFolderService;
  caller: Session;
}

/**
 * Runs a note-tool body, mapping any typed service/repository error (never SQL or an internal id) to a
 * non-throwing `fail()`. A note outside the caller's project reads identically to one that never
 * existed (Review Focus / binding rule 1) — its error carries no id.
 */
function guarded<T>(work: () => T) {
  try {
    return ok(work());
  } catch (error) {
    if (error instanceof NoteNotFoundError) return fail('note not found');
    if (error instanceof StaleRevisionError) return fail(`409 stale_revision, current rev: ${error.currentRev}`);
    if (error instanceof FileBackedNoteError) return fail('note is file-backed; write through the note tool for this note instead');
    if (error instanceof Error) return fail(error.message);
    throw error;
  }
}

/** Wraps each whitespace-separated term as an escaped, prefix-matched phrase (Task 13 amendment); '' for a blank query. */
function escapeFtsQuery(query: string): string {
  const terms = query.trim().split(/\s+/).filter((term) => term !== '');
  return terms.map((term) => `"${term.replace(/"/g, '""')}"*`).join(' ');
}

const noteSummary = (note: ReturnType<NoteRepository['get']>) => note && {
  id: note.id, title: note.title, folder: note.folder, rev: note.rev, shared: note.shared, filePath: note.filePath, updatedAt: note.updatedAt,
};

export function registerNoteTools(server: McpServer, deps: RegisterNoteToolsDeps): void {
  const { notes, noteRepo, docs, caller } = deps;

  function requireProject(): { projectId: string } | undefined {
    return caller.projectId ? { projectId: caller.projectId } : undefined;
  }

  const author = () => `${caller.emoji} ${caller.name}`;

  /** The one lookup every note tool starts from: an id from another project reads exactly like a missing one. */
  function requireOwnNote(projectId: string, id: string) {
    const note = noteRepo.get(id);
    if (!note || note.projectId !== projectId) throw new NoteNotFoundError(id);
    return note;
  }

  /** update_note's and restore_note_version's shared write path: same body, same CAS, file-backed or not. */
  function writeBody(projectId: string, id: string, bodyMd: string, expectedRev: number) {
    const current = requireOwnNote(projectId, id);
    if (current.filePath) return docs.writeThrough(id, { bodyMd, expectedRev, author: author() });
    return notes.update(id, { bodyMd, expectedRev, author: author() });
  }

  server.registerTool('create_note', {
    description: 'Create a note in your project',
    inputSchema: { title: z.string().min(1), body_md: z.string(), folder: NoteFolderSchema.optional(), shared: z.boolean().optional() },
  }, async ({ title, body_md, folder, shared }) => {
    const scope = requireProject();
    if (!scope) return fail('this session has no project');
    return guarded(() => notes.create({ ...scope, title, bodyMd: body_md, folder, shared, author: author() }));
  });

  server.registerTool('get_note', {
    description: 'A note\'s full body plus its @-mentions expanded after it (depth 2, 64 KiB budget)',
    inputSchema: { note: z.string().min(1) },
  }, async ({ note }) => {
    const scope = requireProject();
    if (!scope) return fail('this session has no project');
    return guarded(() => {
      requireOwnNote(scope.projectId, note);
      const { note: expandedNote, expandedBody } = notes.getExpanded(note, { viewerProjectId: scope.projectId });
      return { ...expandedNote, expandedBody };
    });
  });

  server.registerTool('update_note', {
    description: 'Replace a note\'s whole body; rejected with the current rev if expected_rev is stale',
    inputSchema: { note: z.string().min(1), body_md: z.string(), expected_rev: z.number().int() },
  }, async ({ note, body_md, expected_rev }) => {
    const scope = requireProject();
    if (!scope) return fail('this session has no project');
    return guarded(() => writeBody(scope.projectId, note, body_md, expected_rev));
  });

  server.registerTool('delete_note', {
    description: 'Permanently delete a note (its versions and search entry go with it); refused for file-backed notes',
    inputSchema: { note: z.string().min(1) },
  }, async ({ note }) => {
    const scope = requireProject();
    if (!scope) return fail('this session has no project');
    return guarded(() => {
      const current = requireOwnNote(scope.projectId, note);
      if (current.filePath) throw new Error('note is file-backed; delete_note is not supported for file-backed notes');
      noteRepo.delete(note);
      return { deleted: note };
    });
  });

  server.registerTool('move_note', {
    description: 'Move a note to a different folder, or to no folder (null); refused for file-backed notes, whose folder is fixed by their file path',
    inputSchema: { note: z.string().min(1), folder: NoteFolderSchema.nullable() },
  }, async ({ note, folder }) => {
    const scope = requireProject();
    if (!scope) return fail('this session has no project');
    return guarded(() => {
      const current = requireOwnNote(scope.projectId, note);
      if (current.filePath) throw new Error('note is file-backed; move_note is not supported for file-backed notes');
      return notes.move(note, folder);
    });
  });

  server.registerTool('list_notes', {
    description: `Notes in your project, optionally filtered by folder (summaries only, no body; capped at ${MAX_LIST_RESULTS})`,
    inputSchema: { folder: NoteFolderSchema.optional() },
  }, async ({ folder }) => {
    const scope = requireProject();
    if (!scope) return fail('this session has no project');
    return guarded(() => {
      const all = noteRepo.list(scope.projectId).filter((n) => folder === undefined || n.folder === folder);
      return { notes: all.slice(0, MAX_LIST_RESULTS).map(noteSummary), count: Math.min(all.length, MAX_LIST_RESULTS), truncated: all.length > MAX_LIST_RESULTS };
    });
  });

  server.registerTool('search_notes', {
    description: `Full-text search over your project's notes (title + body); returns short snippets, never full bodies, capped at ${MAX_SEARCH_RESULTS} results`,
    inputSchema: { query: z.string() },
  }, async ({ query }) => {
    const scope = requireProject();
    if (!scope) return fail('this session has no project');
    return guarded(() => {
      const escaped = escapeFtsQuery(query);
      if (escaped === '') return { results: [], count: 0 };
      const hits = noteRepo.search(escaped, { projectId: scope.projectId, limit: MAX_SEARCH_RESULTS });
      const results = hits.map(({ note, snippet }) => ({ ...noteSummary(note), snippet }));
      return { results, count: results.length };
    });
  });
}
