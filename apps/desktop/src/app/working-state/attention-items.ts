import type { Session, WorkingState } from '@openfleet/shared';

export interface AttentionItem {
  readonly session: Session;
  readonly questions: readonly string[];
  readonly blockers: readonly string[];
  readonly updatedAt: string;
}

const MAX_SHOWN_COUNT = 99;

/** The open sessions whose state asks the human something or reports a blocker, in session order. */
export function attentionItemsOf(sessions: readonly Session[], states: ReadonlyMap<string, WorkingState>): AttentionItem[] {
  return sessions.flatMap((session) => {
    const state = states.get(session.id);
    const isClosed = session.state === 'closed';
    const needsHuman = state !== undefined && (state.questionsForHuman.length > 0 || state.blockers.length > 0);
    if (isClosed || !state || !needsHuman) return [];
    return [{ session, questions: state.questionsForHuman, blockers: state.blockers, updatedAt: state.updatedAt }];
  });
}

export function inboxCountLabelOf(count: number): { text: string; ariaLabel: string } {
  const text = count > MAX_SHOWN_COUNT ? `${MAX_SHOWN_COUNT}+` : String(count);
  return { text, ariaLabel: count === 1 ? '1 item needs you' : `${count} items need you` };
}
