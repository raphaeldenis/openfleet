import { DestroyRef, Injectable, computed, effect, inject, signal, untracked } from '@angular/core';
import { FleetEventsService } from '../core/fleet-events.service';
import { linesAskedOf, type AnsweredReply } from './attention-items';

const STORAGE_KEY = 'openfleet.answeredReplies';

const REPLY_TEXT_MAX_CHARS = 500;

type BySessionId = ReadonlyMap<string, AnsweredReply>;

/** A reply the human sent, with the lines it answered as the human saw them when sending. */
interface SentReply {
  readonly sessionId: string;
  readonly replyText: string;
  readonly answeredLines: readonly string[];
  readonly isDelivered: boolean;
}

export interface SentReplyTracking {
  readonly sessionId: string;
  readonly replyText: string;
  readonly answeredLines: readonly string[];
  readonly isDeliveredImmediately: boolean;
}

function cappedReplyTextOf(replyText: string): string {
  const trimmed = replyText.trim();
  const isWithinCap = trimmed.length <= REPLY_TEXT_MAX_CHARS;
  return isWithinCap ? trimmed : `${trimmed.slice(0, REPLY_TEXT_MAX_CHARS)}…`;
}

function isAnsweredReply(value: unknown): value is AnsweredReply {
  const candidate = value as Partial<AnsweredReply> | null;
  return typeof candidate?.deliveredAt === 'string' && Array.isArray(candidate.answeredLines);
}

/** The replies kept in storage, or undefined when storage cannot be read. */
function readStoredReplies(): BySessionId | undefined {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}');
    const entries = Object.entries(stored as Record<string, unknown>).filter((entry): entry is [string, AnsweredReply] => isAnsweredReply(entry[1]));
    return new Map(entries);
  } catch {
    return undefined;
  }
}

function writeStoredReplies(replies: BySessionId): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(Object.fromEntries(replies)));
  } catch {
    // Storage is unavailable: answered cards simply return after a reload.
  }
}

const deliveryKeyOf = (sessionId: string, reply: AnsweredReply) => `${sessionId}|${reply.deliveredAt}`;

/**
 * Tracks the replies the human sends until they reach the agent, whatever page is open, and remembers per session
 * which lines each delivered reply answered, across reloads and browser tabs.
 * An entry is dropped once the agent shows no question or blocker, so asking the same words again is a new ask.
 */
@Injectable({ providedIn: 'root' })
export class AnsweredRepliesStore {
  private readonly events = inject(FleetEventsService);
  private readonly replies = signal<BySessionId>(readStoredReplies() ?? new Map());
  private readonly sentReplyByMessageId = signal<ReadonlyMap<string, SentReply>>(new Map());
  private readonly watchedDeliveryKeys = new Set<string>();

  readonly answeredReplyBySessionId = computed<BySessionId>(
    () => new Map([...this.replies()].map(([sessionId, reply]) => [sessionId, { ...reply, isWatchedSinceDelivery: this.watchedDeliveryKeys.has(deliveryKeyOf(sessionId, reply)) }])),
  );

  constructor() {
    effect(() => {
      const states = this.events.workingStates();
      const sessionIdsWhereAgentMovedOn = [...untracked(this.replies).keys()].filter((sessionId) => {
        const state = states.get(sessionId);
        return state !== undefined && linesAskedOf(state).length === 0;
      });
      sessionIdsWhereAgentMovedOn.forEach((sessionId) => this.forget(sessionId));
    });

    effect(() => {
      const deliveredMessageIds = this.events.deliveredMessageIds();
      const sentReplies = this.sentReplyByMessageId();
      const newlyDeliveredMessageIds = [...sentReplies].filter(([messageId, reply]) => !reply.isDelivered && deliveredMessageIds.has(messageId)).map(([messageId]) => messageId);
      untracked(() => newlyDeliveredMessageIds.forEach((messageId) => this.acknowledgeDelivery(messageId)));
    });

    this.followOtherTabs();
  }

  /** The questions and blockers the agent shows right now: what a reply sent at this moment answers. */
  linesAskedNow(sessionId: string): readonly string[] {
    const state = this.events.workingStates().get(sessionId);
    return state ? linesAskedOf(state) : [];
  }

  /** Follows a sent reply until the agent receives it, even after the page that sent it is gone. */
  trackSentReply(messageId: string, tracking: SentReplyTracking): void {
    const { isDeliveredImmediately, ...reply } = tracking;
    this.sentReplyByMessageId.update((all) => new Map(all).set(messageId, { ...reply, isDelivered: false }));
    if (isDeliveredImmediately) this.acknowledgeDelivery(messageId);
  }

  isReplyDelivered(messageId: string): boolean {
    return this.sentReplyByMessageId().get(messageId)?.isDelivered ?? false;
  }

  private acknowledgeDelivery(messageId: string): void {
    const sentReply = this.sentReplyByMessageId().get(messageId);
    if (!sentReply || sentReply.isDelivered) return;
    this.sentReplyByMessageId.update((all) => new Map(all).set(messageId, { ...sentReply, isDelivered: true }));
    const hadNothingToAnswer = sentReply.answeredLines.length === 0;
    if (hadNothingToAnswer) return;
    const answered: AnsweredReply = { deliveredAt: new Date().toISOString(), answeredLines: sentReply.answeredLines, replyText: cappedReplyTextOf(sentReply.replyText) };
    this.watchedDeliveryKeys.add(deliveryKeyOf(sentReply.sessionId, answered));
    this.change((replies) => replies.set(sentReply.sessionId, answered));
  }

  private forget(sessionId: string): void {
    this.change((replies) => replies.delete(sessionId));
  }

  /** Applies one change on top of what storage holds now, so another tab's entries survive. */
  private change(update: (replies: Map<string, AnsweredReply>) => void): void {
    const changed = new Map(readStoredReplies() ?? this.replies());
    update(changed);
    this.replies.set(changed);
    writeStoredReplies(changed);
  }

  private followOtherTabs(): void {
    const reloadWhenAnotherTabWrites = (event: StorageEvent) => {
      const isAnsweredRepliesChange = event.key === STORAGE_KEY || event.key === null;
      if (isAnsweredRepliesChange) this.replies.set(readStoredReplies() ?? this.replies());
    };
    window.addEventListener('storage', reloadWhenAnotherTabWrites);
    inject(DestroyRef).onDestroy(() => window.removeEventListener('storage', reloadWhenAnotherTabWrites));
  }
}
