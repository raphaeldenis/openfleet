import { Injectable, effect, inject, signal, untracked } from '@angular/core';
import { FleetEventsService } from '../core/fleet-events.service';
import { linesAskedOf, type AnsweredReply } from './attention-items';

const STORAGE_KEY = 'openfleet.answeredReplies';

const REPLY_TEXT_MAX_CHARS = 500;

type BySessionId = ReadonlyMap<string, AnsweredReply>;

function cappedReplyTextOf(replyText: string): string {
  const trimmed = replyText.trim();
  const isWithinCap = trimmed.length <= REPLY_TEXT_MAX_CHARS;
  return isWithinCap ? trimmed : `${trimmed.slice(0, REPLY_TEXT_MAX_CHARS)}…`;
}

function isAnsweredReply(value: unknown): value is AnsweredReply {
  const candidate = value as Partial<AnsweredReply> | null;
  return typeof candidate?.deliveredAt === 'string' && Array.isArray(candidate.answeredLines);
}

function readStoredReplies(): BySessionId {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}');
    const entries = Object.entries(stored as Record<string, unknown>).filter((entry): entry is [string, AnsweredReply] => isAnsweredReply(entry[1]));
    return new Map(entries);
  } catch {
    return new Map();
  }
}

function writeStoredReplies(replies: BySessionId): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(Object.fromEntries(replies)));
  } catch {
    // Storage is unavailable: answered cards simply return after a reload.
  }
}

/**
 * Remembers, per session, which lines the human's delivered reply answered, and keeps that across reloads.
 * An entry is dropped once the agent shows no question or blocker, so asking the same words again is a new ask.
 */
@Injectable({ providedIn: 'root' })
export class AnsweredRepliesStore {
  private readonly events = inject(FleetEventsService);
  private readonly replies = signal<BySessionId>(readStoredReplies());

  readonly answeredReplyBySessionId = this.replies.asReadonly();

  constructor() {
    effect(() => {
      const states = this.events.workingStates();
      const sessionIdsWhereAgentMovedOn = [...untracked(this.replies).keys()].filter((sessionId) => {
        const state = states.get(sessionId);
        return state !== undefined && linesAskedOf(state).length === 0;
      });
      sessionIdsWhereAgentMovedOn.forEach((sessionId) => this.forget(sessionId));
    });
  }

  /** Records that the reply to the lines the agent shows right now reached the agent. */
  markReplyDelivered(sessionId: string, delivery: { readonly at: string; readonly replyText: string }): void {
    const state = this.events.workingStates().get(sessionId);
    const answeredLines = state ? linesAskedOf(state) : [];
    const hadNothingToAnswer = answeredLines.length === 0;
    if (hadNothingToAnswer) return;
    const replyText = cappedReplyTextOf(delivery.replyText);
    this.save(new Map(this.replies()).set(sessionId, { deliveredAt: delivery.at, answeredLines, replyText }));
  }

  private forget(sessionId: string): void {
    const remaining = new Map(this.replies());
    remaining.delete(sessionId);
    this.save(remaining);
  }

  private save(replies: BySessionId): void {
    this.replies.set(replies);
    writeStoredReplies(replies);
  }
}
