import type { Session, WorkingState } from '@openfleet/shared';

export interface AttentionItem {
  readonly session: Session;
  readonly questions: readonly string[];
  readonly blockers: readonly string[];
  readonly updatedAt: string;
  /** True while every line the agent shows is one the human's delivered reply already answered. */
  readonly isAnswered: boolean;
  /** When the reply that answered the lines reached the agent; undefined while unanswered. */
  readonly answeredAt: string | undefined;
  /** The reply that answered the lines, when it is known; undefined while unanswered. */
  readonly replyText: string | undefined;
}

/** What the human replied to: the lines the agent showed when the reply was delivered. */
export interface AnsweredReply {
  readonly deliveredAt: string;
  readonly answeredLines: readonly string[];
  /** The reply that was sent, trimmed and capped; absent on entries stored before replies were kept. */
  readonly replyText?: string;
}

const MAX_SHOWN_COUNT = 99;

/** The questions and blockers the agent shows the human, trimmed so a rewrite with the same words compares equal. */
export function linesAskedOf(state: WorkingState): string[] {
  return [...state.questionsForHuman, ...state.blockers].map((line) => line.trim());
}

/** The open sessions whose state asks the human something or reports a blocker, in session order. */
export function attentionItemsOf(
  sessions: readonly Session[],
  states: ReadonlyMap<string, WorkingState>,
  answeredReplyBySessionId: ReadonlyMap<string, AnsweredReply> = new Map(),
): AttentionItem[] {
  return sessions.flatMap((session) => {
    const state = states.get(session.id);
    const isClosed = session.state === 'closed';
    if (isClosed || !state) return [];
    const linesAsked = linesAskedOf(state);
    const needsHuman = linesAsked.length > 0;
    if (!needsHuman) return [];
    const answeredReply = answeredReplyBySessionId.get(session.id);
    const isAnswered = answeredReply !== undefined && linesAsked.every((line) => answeredReply.answeredLines.includes(line));
    const answeredAt = isAnswered ? answeredReply.deliveredAt : undefined;
    const replyText = isAnswered ? answeredReply.replyText : undefined;
    return [{ session, questions: state.questionsForHuman, blockers: state.blockers, updatedAt: state.updatedAt, isAnswered, answeredAt, replyText }];
  });
}

export function itemsNeedingYouOf(items: readonly AttentionItem[]): AttentionItem[] {
  return items.filter((item) => !item.isAnswered);
}

export function answeredItemsOf(items: readonly AttentionItem[]): AttentionItem[] {
  return items.filter((item) => item.isAnswered);
}

export function inboxCountLabelOf(count: number): { text: string; ariaLabel: string } {
  const text = count > MAX_SHOWN_COUNT ? `${MAX_SHOWN_COUNT}+` : String(count);
  return { text, ariaLabel: count === 1 ? '1 item needs you' : `${count} items need you` };
}
