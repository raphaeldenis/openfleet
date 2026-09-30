import type { ManagerView } from './managers.js';
import type { Approval, PermissionMode, Session, SessionState } from './session.js';
import type { WorkingState } from './workingState.js';

export type ServerEvent =
  | { type: 'snapshot'; sessions: Session[]; approvals: Approval[]; managers: ManagerView[]; workingStates?: WorkingState[]; workingStateMaxAgeMinutes?: number; workingStateMaxBytes?: number }
  | { type: 'session.created'; session: Session }
  | { type: 'session.state'; sessionId: string; state: SessionState; stateSince: string }
  | { type: 'session.closed'; sessionId: string; exitCode?: number }
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
  | { type: 'manager.created'; manager: ManagerView }
  | { type: 'manager.pulsed'; manager: ManagerView };
