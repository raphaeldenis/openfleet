import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { StaleRevisionError, VersionNotFoundError } from '../notes/noteService.js';
import { replaceSection } from '../notes/noteSections.js';
import { createNoteToolSupport, type NoteToolDeps } from './noteToolSupport.js';
import { guardedFor, refuse } from './toolResults.js';

export type RegisterNoteVersionToolsDeps = NoteToolDeps;

export function registerNoteVersionTools(server: McpServer, deps: RegisterNoteVersionToolsDeps): void {
  const { notes, noteRepo } = deps;
  const guarded = guardedFor(deps.caller);
  const { author, requireProject, requireOwnNote, writeBody, noteSummary } = createNoteToolSupport(deps);

  function requireVersion(noteId: string, rev: number) {
    const version = noteRepo.getVersion(noteId, rev);
    if (!version) throw new VersionNotFoundError(rev);
    return version;
  }

  server.registerTool('append_to_note', {
    description: 'Append content to the end of a note\'s body; additive and rev-free, always succeeds unless the note is file-backed; returns the new rev (id, title, folder, rev, shared, fileBacked), not the body',
    inputSchema: { note: z.string().min(1), content: z.string() },
  }, async ({ note, content }) => {
    const scope = requireProject();
    if (!scope) return refuse('project_not_found', 'this session has no project');
    return guarded(() => {
      requireOwnNote(scope.projectId, note);
      return noteSummary(notes.append(note, { content, author: author() }));
    });
  });

  server.registerTool('update_note_section', {
    description: 'Replace the content of a `##` section (send content without the heading line); rejected with the current rev if expected_rev is stale; returns the new rev (id, title, folder, rev, shared, fileBacked), not the body',
    inputSchema: { note: z.string().min(1), heading: z.string().min(1), content: z.string(), expected_rev: z.number().int() },
  }, async ({ note, heading, content, expected_rev }) => {
    const scope = requireProject();
    if (!scope) return refuse('project_not_found', 'this session has no project');
    return guarded(() => {
      const current = requireOwnNote(scope.projectId, note);
      if (current.rev !== expected_rev) throw new StaleRevisionError(current.rev);
      return noteSummary(writeBody(current, replaceSection(current.bodyMd, heading, content), expected_rev));
    });
  });

  server.registerTool('get_note_version', {
    description: 'The full body of one past revision of a note',
    inputSchema: { note: z.string().min(1), rev: z.number().int() },
  }, async ({ note, rev }) => {
    const scope = requireProject();
    if (!scope) return refuse('project_not_found', 'this session has no project');
    return guarded(() => {
      requireOwnNote(scope.projectId, note);
      return requireVersion(note, rev);
    });
  });

  server.registerTool('list_note_versions', {
    description: 'A note\'s revision history (id, rev, author, createdAt) — no bodies, use get_note_version for one',
    inputSchema: { note: z.string().min(1) },
  }, async ({ note }) => {
    const scope = requireProject();
    if (!scope) return refuse('project_not_found', 'this session has no project');
    return guarded(() => {
      requireOwnNote(scope.projectId, note);
      return { versions: noteRepo.listVersionSummaries(note) };
    });
  });

  server.registerTool('restore_note_version', {
    description: 'Restore a note to a past revision\'s body — a new, forward revision, never a rewrite of history; rejected with the current rev if expected_rev is given and stale; returns the new rev (id, title, folder, rev, shared, fileBacked), not the body',
    inputSchema: { note: z.string().min(1), rev: z.number().int(), expected_rev: z.number().int().optional() },
  }, async ({ note, rev, expected_rev }) => {
    const scope = requireProject();
    if (!scope) return refuse('project_not_found', 'this session has no project');
    return guarded(() => {
      const current = requireOwnNote(scope.projectId, note);
      const target = requireVersion(note, rev);
      return noteSummary(writeBody(current, target.bodyMd, expected_rev ?? current.rev));
    });
  });
}
