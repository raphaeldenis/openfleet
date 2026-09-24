import type { Approval, Session, SessionState } from './session.js';

export type ServerEvent =
  | { type: 'snapshot'; sessions: Session[]; approvals: Approval[] }
  | { type: 'session.created'; session: Session }
  | { type: 'session.state'; sessionId: string; state: SessionState; stateSince: string }
  | { type: 'session.closed'; sessionId: string; exitCode?: number }
  | { type: 'session.output'; sessionId: string; data: string }
  | { type: 'session.replay'; sessionId: string; data: string }
  | { type: 'message.queued'; sessionId: string; messageId: string }
  | { type: 'message.delivered'; sessionId: string; messageId: string }
  | { type: 'approval.created'; approval: Approval }
  | { type: 'approval.resolved'; approval: Approval };
