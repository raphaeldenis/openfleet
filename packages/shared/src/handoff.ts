import * as z from 'zod';
import type { ErrorCode } from './errors.js';

export const HANDOFF_SECTION_KEYS = ['goal', 'state', 'decisions', 'filesTouched', 'nextSteps', 'openQuestions'] as const;
export type HandoffSectionKey = (typeof HANDOFF_SECTION_KEYS)[number];

export const HANDOFF_SECTION_MAX_CHARACTERS = 20_000;

const HandoffSectionTextSchema = z.string().max(HANDOFF_SECTION_MAX_CHARACTERS);

export const HandoffContentSchema = z
  .object({
    goal: HandoffSectionTextSchema,
    state: HandoffSectionTextSchema,
    decisions: HandoffSectionTextSchema,
    filesTouched: HandoffSectionTextSchema,
    nextSteps: HandoffSectionTextSchema,
    openQuestions: HandoffSectionTextSchema,
  })
  .strict();
export type HandoffContent = z.infer<typeof HandoffContentSchema>;

/** Where the text of a section comes from: `none` when nothing could be derived and the human writes it. */
export type HandoffSectionSource = 'working_state' | 'git' | 'session' | 'manager' | 'none';

export interface HandoffPreview {
  sessionId: string;
  kind: 'session' | 'manager';
  sections: HandoffContent;
  sources: Record<HandoffSectionKey, HandoffSectionSource>;
  truncated: HandoffSectionKey[];
  target: HandoffTarget;
  generatedAt: string;
}

export type HandoffTargetUnavailableReason = 'no_project' | 'no_docs_folder' | 'docs_folder_unusable';

export interface HandoffTarget {
  available: boolean;
  reason?: HandoffTargetUnavailableReason;
  /** The path the handoff would get now, relative to the docs folder, e.g. `handoffs/2026-10-04-gimli.md`. A hint: the save result is authoritative. */
  relativePath?: string;
  /** The write-on-close setting, and a usable target. */
  writeOnCloseDefault: boolean;
}

export const CloseSessionRequestSchema = z.object({ writeHandoff: z.boolean().optional() }).strict();
export type CloseSessionRequest = z.infer<typeof CloseSessionRequestSchema>;

export type HandoffSkipReason = 'recent_manual_handoff' | 'target_unavailable';

/** What the close response says about the handoff the request asked for. */
export type CloseHandoffResult =
  | { status: 'written'; relativePath: string }
  | { status: 'skipped'; reason: HandoffSkipReason }
  | { status: 'failed'; error: ErrorCode; message: string };
