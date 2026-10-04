import type { DaemonIssue } from './daemonIssues.js';
import type { ErrorEnvelope } from './errors.js';
import type { ManagerView } from './managers.js';
import type { Approval, PermissionMode, Session, SessionState } from './session.js';
import type { SessionTodos, TodoSummary } from './todos.js';
import type { WorkingState } from './workingState.js';

/** `reply` answers a client message that failed, on that socket only; `broadcast` announces a failure nobody asked for, to every client. A daemon that predates the field sends neither. */
export type ErrorEventScope = 'reply' | 'broadcast';

export type SessionCloseReason = 'launch_failed' | 'resume_timeout' | 'conversation_not_found' | 'harness_exit' | 'closed_by_user' | 'daemon_shutdown';

// The exit code convention that predates `reason`: a snapshot carries exit codes but no reason, so this recomputes the two it encodes.
const REASON_BY_CONVENTIONAL_EXIT_CODE: Record<number, SessionCloseReason> = { [-1]: 'resume_timeout', [-2]: 'launch_failed' };

export const closeReasonOfExitCode = (exitCode: number | undefined): SessionCloseReason | undefined =>
  exitCode === undefined ? undefined : REASON_BY_CONVENTIONAL_EXIT_CODE[exitCode];

export type ServerEvent =
  | { type: 'snapshot'; sessions: Session[]; approvals: Approval[]; managers: ManagerView[]; workingStates?: WorkingState[]; workingStateMaxAgeMinutes?: number; workingStateMaxBytes?: number; todoSummaries?: TodoSummary[]; daemonIssues?: DaemonIssue[] }
  | { type: 'session.created'; session: Session }
  | { type: 'session.state'; sessionId: string; state: SessionState; stateSince: string }
  | { type: 'session.closed'; sessionId: string; exitCode?: number; reason?: SessionCloseReason }
  | { type: 'session.output'; sessionId: string; data: string }
  | { type: 'session.replay'; sessionId: string; data: string }
  | { type: 'session.model_changed'; sessionId: string; model: string }
  | { type: 'session.permission_mode_changed'; sessionId: string; mode: PermissionMode }
  | { type: 'session.updated'; session: Session }
  | { type: 'session.reopened'; sessionId: string }
  | { type: 'session.relaunching'; sessionId: string }
  | { type: 'message.queued'; sessionId: string; messageId: string }
  | { type: 'message.delivered'; sessionId: string; messageId: string }
  | { type: 'approval.created'; approval: Approval }
  | { type: 'approval.resolved'; approval: Approval }
  | { type: 'session.working_state'; state: WorkingState }
  | { type: 'session.todos'; todos: SessionTodos }
  | { type: 'manager.created'; manager: ManagerView }
  | { type: 'manager.pulsed'; manager: ManagerView }
  | { type: 'error'; sessionId?: string; scope?: ErrorEventScope; error: ErrorEnvelope }
  | { type: 'daemon.issues'; issues: DaemonIssue[] };
