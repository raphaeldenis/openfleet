import type { DaemonIssue } from './daemonIssues.js';
import type { ErrorEnvelope } from './errors.js';
import type { ManagerView } from './managers.js';
import type { Approval, PermissionMode, RuntimeAttention, Session, SessionCloseReason, SessionState } from './session.js';
import type { SessionTodos, TodoSummary } from './todos.js';
import type { WorkingState } from './workingState.js';

/** `reply` answers a client message that failed, on that socket only; `broadcast` announces a failure nobody asked for, to every client. A daemon that predates the field sends neither. */
export type ErrorEventScope = 'reply' | 'broadcast';

// Legacy only: daemons before ERR-09 encoded resume_timeout as exit code -1 and launch_failed as -2, and daemons before the persisted
// `closeReason` (migration 019) sent neither on a snapshot. A desktop talking to one of them recovers the reason here; current daemons never send these codes.
const REASON_BY_CONVENTIONAL_EXIT_CODE: Record<number, SessionCloseReason> = { [-1]: 'resume_timeout', [-2]: 'launch_failed' };

export const closeReasonOfExitCode = (exitCode: number | undefined): SessionCloseReason | undefined =>
  exitCode === undefined ? undefined : REASON_BY_CONVENTIONAL_EXIT_CODE[exitCode];

/** A session that has sat on one permission prompt past the silent-block threshold; `waitingSince` is when that prompt appeared and names it. */
export interface SilentBlock {
  sessionId: string;
  waitingSince: string;
}

export type ServerEvent =
  | { type: 'snapshot'; sessions: Session[]; approvals: Approval[]; managers: ManagerView[]; workingStates?: WorkingState[]; workingStateMaxAgeMinutes?: number; workingStateMaxBytes?: number; todoSummaries?: TodoSummary[]; daemonIssues?: DaemonIssue[]; silentBlocks?: SilentBlock[] }
  | { type: 'session.created'; session: Session }
  | { type: 'session.state'; sessionId: string; state: SessionState; stateSince: string }
  | { type: 'session.attention'; sessionId: string; runtimeAttention: RuntimeAttention | null }
  | { type: 'session.closed'; sessionId: string; exitCode?: number; reason?: SessionCloseReason }
  | { type: 'session.output'; sessionId: string; data: string }
  | { type: 'session.replay'; sessionId: string; data: string }
  | { type: 'session.model_changed'; sessionId: string; model: string }
  | { type: 'session.permission_mode_changed'; sessionId: string; mode: PermissionMode }
  | { type: 'session.updated'; session: Session }
  | { type: 'session.reopened'; sessionId: string }
  | { type: 'session.relaunching'; sessionId: string }
  | { type: 'message.queued'; sessionId: string; messageId: string }
  | { type: 'message.held'; sessionId: string; messageId: string; ageMs: number; heldFor: 'human_draft' }
  | { type: 'message.delivered'; sessionId: string; messageId: string }
  | { type: 'approval.created'; approval: Approval }
  | { type: 'approval.resolved'; approval: Approval }
  | { type: 'session.working_state'; state: WorkingState }
  | { type: 'session.todos'; todos: SessionTodos }
  | { type: 'manager.created'; manager: ManagerView }
  | { type: 'manager.pulsed'; manager: ManagerView }
  | { type: 'manager.updated'; manager: ManagerView }
  | { type: 'error'; sessionId?: string; scope?: ErrorEventScope; error: ErrorEnvelope }
  | { type: 'daemon.issues'; issues: DaemonIssue[] }
  | { type: 'permission.silent_blocks'; blocks: SilentBlock[] };
