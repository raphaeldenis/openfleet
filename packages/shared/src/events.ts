import type { DeniedCommand } from './commandPolicy.js';
import type { DaemonIssue } from './daemonIssues.js';
import type { ErrorEnvelope } from './errors.js';
import type { GovernanceProposalView, LawView } from './governance.js';
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

/** Where a note write came from: an agent's tool, the REST API, the note's file on disk, or a restore of an older version (over either API). */
export type NoteChangeSource = 'mcp' | 'rest' | 'file' | 'restore';

/** A note changed. Identifiers and the new revision only: never a title or a body, a client reads the note itself to learn more. */
export type NoteChangeEvent =
  | { type: 'note.created'; noteId: string; projectId: string; rev: number }
  | { type: 'note.updated'; noteId: string; projectId: string; rev: number; source: NoteChangeSource }
  | { type: 'note.deleted'; noteId: string; projectId: string };

export type NeedsInputKind = 'permission' | 'input';

/**
 * What happened to a session that deserves the human's attention. Carries identifiers, a tool name and a question count only:
 * never tool input or response, transcript, prompt or question text.
 * A client ignores a category it does not know.
 */
export type NotificationTrigger =
  | { category: 'agentFinished'; sessionId: string }
  | { category: 'needsInput'; sessionId: string; kind: NeedsInputKind; promptKey: string; toolName?: string }
  | { category: 'toolCompletion'; sessionId: string; toolUseId: string; toolName: string }
  | { category: 'chatMessage'; sessionId: string; questionKey: string; questionCount: number };

export type ServerEvent =
  | { type: 'snapshot'; sessions: Session[]; approvals: Approval[]; proposals?: GovernanceProposalView[]; managers: ManagerView[]; workingStates?: WorkingState[]; workingStateMaxAgeMinutes?: number; workingStateMaxBytes?: number; todoSummaries?: TodoSummary[]; daemonIssues?: DaemonIssue[]; silentBlocks?: SilentBlock[] }
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
  | { type: 'governance.proposed'; proposal: GovernanceProposalView }
  | { type: 'governance.resolved'; proposal: GovernanceProposalView }
  | { type: 'law.created'; law: LawView }
  | { type: 'law.updated'; law: LawView }
  | { type: 'law.withdrawn'; law: LawView }
  | { type: 'session.working_state'; state: WorkingState }
  | { type: 'session.todos'; todos: SessionTodos }
  | { type: 'manager.created'; manager: ManagerView }
  | { type: 'manager.pulsed'; manager: ManagerView }
  | { type: 'manager.updated'; manager: ManagerView }
  | { type: 'error'; sessionId?: string; scope?: ErrorEventScope; error: ErrorEnvelope }
  | { type: 'daemon.issues'; issues: DaemonIssue[] }
  | { type: 'permission.silent_blocks'; blocks: SilentBlock[] }
  | { type: 'command.denied'; denial: DeniedCommand }
  | ({ type: 'notification.trigger' } & NotificationTrigger)
  | NoteChangeEvent;
