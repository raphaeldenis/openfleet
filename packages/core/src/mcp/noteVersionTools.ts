import type { Session } from '@openfleet/shared';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { DocsFolderService } from '../notes/docsFolderService.js';
import { FileBackedNoteError, NoteNotFoundError, StaleRevisionError, type NoteService } from '../notes/noteService.js';
import type { NoteRepository } from '../notes/noteRepository.js';
import { replaceSection } from '../notes/noteSections.js';

const ok = (payload: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(payload) }] });
const fail = (message: string) => ({ content: [{ type: 'text' as const, text: message }], isError: true });

export interface RegisterNoteVersionToolsDeps {
  notes: NoteService;
  noteRepo: NoteRepository;
  docs: DocsFolderService;
  caller: Session;
}

/** Same error mapping as noteTools.ts's `guarded` — kept local per this file's own concern (A16: one file, one job). */
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

const versionSummary = (version: { id: string; rev: number; author: string; createdAt: string }) => ({
  id: version.id, rev: version.rev, author: version.author, createdAt: version.createdAt,
});

export function registerNoteVersionTools(server: McpServer, deps: RegisterNoteVersionToolsDeps): void {
  const { notes, noteRepo, docs, caller } = deps;

  function requireProject(): { projectId: string } | undefined {
    return caller.projectId ? { projectId: caller.projectId } : undefined;
  }

  const author = () => `${caller.emoji} ${caller.name}`;

  function requireOwnNote(projectId: string, id: string) {
    const note = noteRepo.get(id);
    if (!note || note.projectId !== projectId) throw new NoteNotFoundError(id);
    return note;
  }

  function requireVersion(noteId: string, rev: number) {
    const version = noteRepo.listVersions(noteId).find((candidate) => candidate.rev === rev);
    if (!version) throw new Error(`version not found: rev ${rev}`);
    return version;
  }

  /** The one CAS write both update_note_section and restore_note_version commit through: file-backed or not, same body. */
  function writeBody(projectId: string, id: string, bodyMd: string, expectedRev: number) {
    const current = requireOwnNote(projectId, id);
    if (current.filePath) return docs.writeThrough(id, { bodyMd, expectedRev, author: author() });
    return notes.update(id, { bodyMd, expectedRev, author: author() });
  }

  server.registerTool('append_to_note', {
    description: 'Append content to the end of a note\'s body; additive and rev-free, always succeeds unless the note is file-backed',
    inputSchema: { note: z.string().min(1), content: z.string() },
  }, async ({ note, content }) => {
    const scope = requireProject();
    if (!scope) return fail('this session has no project');
    return guarded(() => {
      const current = requireOwnNote(scope.projectId, note);
      if (current.filePath) throw new Error('note is file-backed; append_to_note is not supported for file-backed notes (use update_note with expected_rev)');
      return notes.append(note, { content, author: author() });
    });
  });

  server.registerTool('update_note_section', {
    description: 'Replace the content of a `##` section (send content without the heading line); rejected with the current rev if expected_rev is stale',
    inputSchema: { note: z.string().min(1), heading: z.string().min(1), content: z.string(), expected_rev: z.number().int() },
  }, async ({ note, heading, content, expected_rev }) => {
    const scope = requireProject();
    if (!scope) return fail('this session has no project');
    return guarded(() => {
      const current = requireOwnNote(scope.projectId, note);
      if (!current.filePath) return notes.updateSection(note, { heading, content, expectedRev: expected_rev, author: author() });
      const newBodyMd = replaceSection(current.bodyMd, heading, content);
      return docs.writeThrough(note, { bodyMd: newBodyMd, expectedRev: expected_rev, author: author() });
    });
  });

  server.registerTool('get_note_version', {
    description: 'The full body of one past revision of a note',
    inputSchema: { note: z.string().min(1), rev: z.number().int() },
  }, async ({ note, rev }) => {
    const scope = requireProject();
    if (!scope) return fail('this session has no project');
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
    if (!scope) return fail('this session has no project');
    return guarded(() => {
      requireOwnNote(scope.projectId, note);
      return { versions: noteRepo.listVersions(note).map(versionSummary) };
    });
  });

  server.registerTool('restore_note_version', {
    description: 'Restore a note to a past revision\'s body — a new, forward revision, never a rewrite of history',
    inputSchema: { note: z.string().min(1), rev: z.number().int() },
  }, async ({ note, rev }) => {
    const scope = requireProject();
    if (!scope) return fail('this session has no project');
    return guarded(() => {
      const current = requireOwnNote(scope.projectId, note);
      const target = requireVersion(note, rev);
      return writeBody(scope.projectId, note, target.bodyMd, current.rev);
    });
  });
}
