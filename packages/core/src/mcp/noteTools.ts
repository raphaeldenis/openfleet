import { NoteFolderSchema } from '@openfleet/shared';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { FileBackedNoteError } from '../notes/noteService.js';
import { createNoteToolSupport, type NoteToolDeps } from './noteToolSupport.js';
import { fail, guarded } from './toolResults.js';

const MAX_LIST_RESULTS = 200;
const MAX_SEARCH_RESULTS = 50;
const MAX_QUERY_CHARS = 512;
const MAX_QUERY_TERMS = 16;

export type RegisterNoteToolsDeps = NoteToolDeps;

const tokenize = (query: string) => query.trim().split(/\s+/).filter((term) => term !== '');

/** Wraps each term as an escaped, prefix-matched phrase; '' for a blank query. */
const escapeFtsTerms = (terms: string[]) => terms.map((term) => `"${term.replace(/"/g, '""')}"*`).join(' ');

export function registerNoteTools(server: McpServer, deps: RegisterNoteToolsDeps): void {
  const { notes, noteRepo } = deps;
  const { author, requireProject, requireOwnNote, writeBody, noteSummary, noteView } = createNoteToolSupport(deps);

  server.registerTool('create_note', {
    description: 'Create a note in your project',
    inputSchema: { title: z.string().min(1), body_md: z.string(), folder: NoteFolderSchema.optional(), shared: z.boolean().optional() },
  }, async ({ title, body_md, folder, shared }) => {
    const scope = requireProject();
    if (!scope) return fail('this session has no project');
    return guarded(() => noteView(notes.create({ ...scope, title, bodyMd: body_md, folder, shared, author: author() })));
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
      return { ...noteView(expandedNote), expandedBody };
    });
  });

  server.registerTool('update_note', {
    description: 'Replace a note\'s whole body; rejected with the current rev if expected_rev is stale',
    inputSchema: { note: z.string().min(1), body_md: z.string(), expected_rev: z.number().int() },
  }, async ({ note, body_md, expected_rev }) => {
    const scope = requireProject();
    if (!scope) return fail('this session has no project');
    return guarded(() => noteView(writeBody(requireOwnNote(scope.projectId, note), body_md, expected_rev)));
  });

  server.registerTool('delete_note', {
    description: 'Permanently delete a note (its versions and search entry go with it); refused for file-backed notes',
    inputSchema: { note: z.string().min(1) },
  }, async ({ note }) => {
    const scope = requireProject();
    if (!scope) return fail('this session has no project');
    return guarded(() => {
      const current = requireOwnNote(scope.projectId, note);
      if (current.filePath) throw new FileBackedNoteError(note);
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
      requireOwnNote(scope.projectId, note);
      return noteView(notes.move(note, folder));
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
      const shown = all.slice(0, MAX_LIST_RESULTS).map(noteSummary);
      return { notes: shown, count: shown.length, truncated: all.length > MAX_LIST_RESULTS };
    });
  });

  server.registerTool('search_notes', {
    description: `Full-text search over your project's notes (title + body); at most ${MAX_QUERY_CHARS} characters and ${MAX_QUERY_TERMS} terms; returns short snippets, never full bodies, capped at ${MAX_SEARCH_RESULTS} results`,
    inputSchema: { query: z.string() },
  }, async ({ query }) => {
    const scope = requireProject();
    if (!scope) return fail('this session has no project');
    if (query.length > MAX_QUERY_CHARS) return fail(`query too long (max ${MAX_QUERY_CHARS} characters)`);
    const terms = tokenize(query);
    if (terms.length > MAX_QUERY_TERMS) return fail(`too many terms in query (max ${MAX_QUERY_TERMS})`);
    return guarded(() => {
      if (terms.length === 0) return { results: [], count: 0 };
      const hits = noteRepo.search(escapeFtsTerms(terms), { projectId: scope.projectId, limit: MAX_SEARCH_RESULTS });
      const results = hits.map(({ note, snippet }) => ({ ...noteSummary(note), snippet }));
      return { results, count: results.length };
    });
  });
}
