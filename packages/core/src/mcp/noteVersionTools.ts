import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { OpenFleetError } from '@openfleet/shared';
import { z } from 'zod';
import { log } from '../logger.js';
import { StaleRevisionError, VersionNotFoundError } from '../notes/noteService.js';
import { planStaleSectionWrite, replaceSection } from '../notes/noteSections.js';
import { createNoteToolSupport, type NoteToolDeps } from './noteToolSupport.js';
import { guardedFor, refuse } from './toolResults.js';

export type RegisterNoteVersionToolsDeps = NoteToolDeps;

/** The single switch for the grace period: `true` refuses a restore without expected_rev as invalid_body. */
export const REQUIRE_EXPECTED_REV_ON_RESTORE = false;

const MISSING_EXPECTED_REV_HINT = 'Call get_note, then pass its rev as expected_rev.';
const MISSING_EXPECTED_REV_WARNING = 'expected_rev will be required in the next release: call get_note and pass its rev.';
// One first try plus three retries after losing the CAS to a concurrent writer, as for append.
const MAX_MERGE_ATTEMPTS = 4;

export function registerNoteVersionTools(server: McpServer, deps: RegisterNoteVersionToolsDeps): void {
  const { notes, noteRepo } = deps;
  const guarded = guardedFor(deps.caller);
  const { author, requireProject, requireOwnNote, writeBody, noteSummary } = createNoteToolSupport(deps);

  function requireVersion(noteId: string, rev: number) {
    const version = noteRepo.getVersion(noteId, rev);
    if (!version) throw new VersionNotFoundError(rev);
    return version;
  }

  interface SectionWrite { note: string; heading: string; content: string; expectedRev: number }

  /** Writes on the expected revision; when the note moved on, merges into the current revision if the target section is untouched, else refuses naming the conflicting sections. */
  function writeSectionAgainstExpectedRev(projectId: string, { note, heading, content, expectedRev }: SectionWrite) {
    let lastRefusal: StaleRevisionError | undefined;
    for (let attempt = 0; attempt < MAX_MERGE_ATTEMPTS; attempt++) {
      const current = requireOwnNote(projectId, note);
      const isOnExpectedRev = current.rev === expectedRev;
      if (isOnExpectedRev) return noteSummary(writeBody(current, { bodyMd: replaceSection(current.bodyMd, heading, content), expectedRev }));

      const base = noteRepo.getVersion(note, expectedRev);
      if (!base) throw new StaleRevisionError(current.rev);
      const plan = planStaleSectionWrite({ baseBodyMd: base.bodyMd, currentBodyMd: current.bodyMd, heading, content });
      if (plan.outcome === 'conflict') throw new StaleRevisionError(current.rev, plan.conflictingSections);
      try {
        return { ...noteSummary(writeBody(current, { bodyMd: plan.bodyMd, expectedRev: current.rev })), merged: true };
      } catch (error) {
        if (!(error instanceof StaleRevisionError)) throw error;
        lastRefusal = error;
      }
    }
    throw lastRefusal!;
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
    description: 'Replace the content of a `##` section (send content without the heading line); if expected_rev is stale but this section is unchanged since that rev, the write is merged onto the current revision (reply has merged: true); otherwise rejected with stale_revision, the current rev and the conflicting section titles; returns the new rev (id, title, folder, rev, shared, fileBacked), not the body',
    inputSchema: { note: z.string().min(1), heading: z.string().min(1), content: z.string(), expected_rev: z.number().int() },
  }, async ({ note, heading, content, expected_rev }) => {
    const scope = requireProject();
    if (!scope) return refuse('project_not_found', 'this session has no project');
    return guarded(() => writeSectionAgainstExpectedRev(scope.projectId, { note, heading, content, expectedRev: expected_rev }));
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
    description: 'Restore a note to a past revision\'s body — a new, forward revision, never a rewrite of history; rejected with stale_revision and the current rev if expected_rev is stale (pass the rev from get_note); omitting expected_rev still works for now but the reply carries a warning and it becomes required in the next release; returns the new rev (id, title, folder, rev, shared, fileBacked), not the body',
    inputSchema: { note: z.string().min(1), rev: z.number().int(), expected_rev: z.number().int().optional() },
  }, async ({ note, rev, expected_rev }) => {
    const scope = requireProject();
    if (!scope) return refuse('project_not_found', 'this session has no project');
    return guarded(() => {
      const current = requireOwnNote(scope.projectId, note);
      const target = requireVersion(note, rev);
      const isMissingExpectedRev = expected_rev === undefined;
      if (isMissingExpectedRev && REQUIRE_EXPECTED_REV_ON_RESTORE) throw new OpenFleetError('invalid_body', 'expected_rev is required to restore a note version.', { hint: MISSING_EXPECTED_REV_HINT });
      if (isMissingExpectedRev) log('warn', 'restore without expected_rev', undefined, { noteId: current.id, sessionId: deps.caller.id });
      const restored = noteSummary(writeBody(current, { bodyMd: target.bodyMd, expectedRev: expected_rev ?? current.rev, source: 'restore' }));
      return isMissingExpectedRev ? { ...restored, warning: MISSING_EXPECTED_REV_WARNING } : restored;
    });
  });
}
