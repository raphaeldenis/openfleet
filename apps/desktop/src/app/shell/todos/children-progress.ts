import { MANAGER_ROLE, type Session, type TodoSummary } from '@openfleet/shared';
import type { ChildProgress } from './session-todos-source';

const CLOSED_STATE = 'closed';

function createdAtMillis(session: Session): number {
  const millis = Date.parse(session.createdAt);
  return Number.isNaN(millis) ? 0 : millis;
}

function progressOf(child: Session, summaries: ReadonlyMap<string, TodoSummary>): ChildProgress {
  const counts = summaries.get(child.id)?.counts;
  const hasList = counts !== undefined && counts.total > 0;
  return { id: child.id, name: child.name, emoji: child.emoji, state: child.state, isManager: child.role === MANAGER_ROLE, counts: hasList ? counts : null };
}

/** Lists the direct children of a manager, open ones first then closed ones, each group in creation order. */
export function childrenProgressOf(managerId: string, sessions: readonly Session[], summaries: ReadonlyMap<string, TodoSummary>): ChildProgress[] {
  const isClosed = (session: Session) => session.state === CLOSED_STATE;
  return sessions
    .filter((session) => session.parentId === managerId)
    .sort((a, b) => Number(isClosed(a)) - Number(isClosed(b)) || createdAtMillis(a) - createdAtMillis(b))
    .map((child) => progressOf(child, summaries));
}
