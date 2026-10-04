import * as z from 'zod';
import { ManagerSpecSchema } from './managers.js';
import { ModelIdSchema } from './models.js';
import { HandoffFileSchema } from './handoff.js';

export const SESSION_STATES = ['starting', 'generating', 'waiting_permission', 'waiting_input', 'idle', 'closed'] as const;
export type SessionState = (typeof SESSION_STATES)[number];

export const SESSION_CLOSE_REASONS = ['launch_failed', 'resume_timeout', 'conversation_not_found', 'harness_exit', 'closed_by_user', 'daemon_shutdown'] as const;
export type SessionCloseReason = (typeof SESSION_CLOSE_REASONS)[number];

const SessionCloseReasonSchema = z.enum(SESSION_CLOSE_REASONS);

/** Returns the reason when it is one this version knows, and undefined for anything else (a reason a newer daemon introduced, a malformed value). */
export const parseSessionCloseReason = (value: unknown): SessionCloseReason | undefined => {
  const parsed = SessionCloseReasonSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
};

export const HARNESSES =['claude-cli', 'fake'] as const;
export type HarnessId = (typeof HARNESSES)[number];

export const PERMISSION_MODES = ['manual', 'acceptEdits', 'plan', 'auto', 'bypassPermissions', 'dontAsk'] as const;
export type PermissionMode = (typeof PERMISSION_MODES)[number];

export const SessionSpecSchema = z.object({
  directory: z.string().min(1),
  name: z.string().min(1),
  emoji: z.string().default('🤖'),
  model: ModelIdSchema.optional(),
  seededPrompt: z.string().optional(),
  parentId: z.string().optional(),
  projectId: z.uuid().optional(),
  handoffFile: HandoffFileSchema.optional(),
  role: z.string().optional(),
  harness: z.enum(HARNESSES).default('claude-cli'),
  permissionMode: z.enum(PERMISSION_MODES).optional(),
  manager: ManagerSpecSchema.optional(),
}).refine((spec) => spec.handoffFile === undefined || spec.projectId !== undefined, {
  message: 'a handoff requires a project', path: ['handoffFile'],
});
export type SessionSpec = z.infer<typeof SessionSpecSchema>;

export interface Session {
  id: string;
  name: string;
  emoji: string;
  directory: string;
  worktree?: string;
  branch?: string;
  model?: string;
  resolvedModel?: string;
  cliVersion?: string;
  modelDriftedFrom?: string;
  /** The highest context-size threshold, in tokens, the session has crossed. Absent when no notice is raised. */
  contextNoticeTokens?: number;
  parentId?: string;
  projectId?: string;
  role?: string;
  permissionMode?: PermissionMode;
  harness: HarnessId;
  state: SessionState;
  stateSince: string;
  exitCode?: number;
  /** Why the session is closed; absent while it is live, for a close recorded before the reason was stored, and for a reason this version does not know. */
  closeReason?: SessionCloseReason;
  createdAt: string;
  closedAt?: string;
}

export interface QueuedMessage {
  id: string;
  sessionId: string;
  fromSessionId?: string;
  body: string;
  status: 'queued' | 'delivered';
  createdAt: string;
  deliveredAt?: string;
}

export interface Approval {
  id: string;
  sessionId: string;
  toolName: string;
  toolInput: unknown;
  status: 'pending' | 'allowed' | 'denied' | 'expired';
  reason?: string;
  createdAt: string;
  resolvedAt?: string;
}
