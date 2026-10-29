import * as z from 'zod';
import { ManagerSpecSchema } from './managers.js';
import { ModelIdSchema } from './models.js';
import { HandoffFileSchema } from './handoff.js';
import { effortRefusalOf } from './effort.js';

export const SESSION_STATES = ['starting', 'generating', 'waiting_permission', 'waiting_input', 'idle', 'closed'] as const;
export type SessionState = (typeof SESSION_STATES)[number];

export interface RuntimeAttention {
  launchId: string;
  reason: 'post_wake_process_exited' | 'post_wake_no_progress' | 'post_wake_health_unknown';
  detectedAt: string;
  wakeSource: 'resume_suspected';
}

export const SESSION_CLOSE_REASONS = ['launch_failed', 'resume_timeout', 'conversation_not_found', 'harness_exit', 'closed_by_user', 'daemon_shutdown'] as const;
export type SessionCloseReason = (typeof SESSION_CLOSE_REASONS)[number];

const SessionCloseReasonSchema = z.enum(SESSION_CLOSE_REASONS);

/** Returns the reason when it is one this version knows, and undefined for anything else (a reason a newer daemon introduced, a malformed value). */
export const parseSessionCloseReason = (value: unknown): SessionCloseReason | undefined => {
  const parsed = SessionCloseReasonSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
};

/** Whether a launch produced a sign of life: pending until the first PTY byte or transcript progress, failed when none came in time. */
export const SESSION_READINESS = ['pending', 'ready', 'failed'] as const;
export type SessionReadiness = (typeof SESSION_READINESS)[number];

export const READINESS_FAILURE_REASONS = ['no_output_at_launch'] as const;
export type ReadinessFailureReason = (typeof READINESS_FAILURE_REASONS)[number];

export const parseSessionReadiness = (value: unknown): SessionReadiness | undefined =>
  SESSION_READINESS.find((readiness) => readiness === value);

export const parseReadinessFailureReason = (value: unknown): ReadinessFailureReason | undefined =>
  READINESS_FAILURE_REASONS.find((reason) => reason === value);

export const HARNESSES =['claude-cli', 'fake'] as const;
export type HarnessId = (typeof HARNESSES)[number];

/** How a harness applies the command policy: through its hooks, through its own CLI, through shims, or not at all. */
export const POLICY_ENFORCEMENTS = ['hook', 'native', 'shim', 'none'] as const;
export type PolicyEnforcement = (typeof POLICY_ENFORCEMENTS)[number];

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
  effort: z.string().optional(),
  manager: ManagerSpecSchema.optional(),
}).refine((spec) => spec.handoffFile === undefined || spec.projectId !== undefined, {
  message: 'a handoff requires a project', path: ['handoffFile'],
}).superRefine((spec, context) => {
  if (spec.effort === undefined) return;
  const refusal = effortRefusalOf(spec.harness, spec.effort);
  if (refusal) context.addIssue({ code: 'custom', message: refusal, path: ['effort'] });
});
export type SessionSpec = z.infer<typeof SessionSpecSchema> & {
  /** A validated absolute config directory; set only by callers that resolved it, never parsed from a request body. */
  configDir?: string;
};

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
  /** The effort level the session launches with; absent when none was chosen. */
  effort?: string;
  /** The name (last path segment) of the config directory the session runs under; the path itself is never exposed. */
  configProfile?: string;
  harness: HarnessId;
  /** How the command policy reaches this session's harness. Absent from a daemon that predates the policy. */
  policyEnforcement?: PolicyEnforcement;
  state: SessionState;
  stateSince: string;
  runtimeAttention?: RuntimeAttention;
  /** Absent for a session launched before readiness was tracked. A launch that produced no sign of life is failed, whatever its state says. */
  readiness?: SessionReadiness;
  readinessReason?: ReadinessFailureReason;
  /** True while the daemon waits to restart this closed child after a crash; absent otherwise. */
  restartPending?: boolean;
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

/** A queued message the daemon does not type because the human has an unsent draft in the terminal prompt. */
export interface HeldMessage {
  messageId: string;
  fromSessionId?: string;
  body: string;
  createdAt: string;
  heldFor: 'human_draft';
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
