import { Injectable, computed, signal } from '@angular/core';

type BySessionId<Value> = ReadonlyMap<string, Value>;

function withEntry<Value>(entries: BySessionId<Value>, sessionId: string, value: Value): BySessionId<Value> {
  return new Map(entries).set(sessionId, value);
}

function withoutEntry<Value>(entries: BySessionId<Value>, sessionId: string): BySessionId<Value> {
  const remaining = new Map(entries);
  remaining.delete(sessionId);
  return remaining;
}

/** Keeps each session's reply draft, pending send and failed send alive while the composer showing them is destroyed. */
@Injectable({ providedIn: 'root' })
export class ReplyDraftStore {
  private readonly drafts = signal<BySessionId<string>>(new Map());
  private readonly sendingSessionIds = signal<ReadonlySet<string>>(new Set());
  private readonly failedSends = signal<BySessionId<string>>(new Map());

  readonly failedSessionIds = computed(() => [...this.failedSends().keys()]);

  draftOf(sessionId: string): string {
    return this.drafts().get(sessionId) ?? '';
  }

  setDraft(sessionId: string, text: string): void {
    this.drafts.update((drafts) => (text === '' ? withoutEntry(drafts, sessionId) : withEntry(drafts, sessionId, text)));
  }

  /** Removes from the draft the text that was just sent, keeping whatever was typed after it or instead of it. */
  clearSentText(sessionId: string, sentText: string): void {
    const current = this.draftOf(sessionId);
    const remaining = current.startsWith(sentText) ? current.slice(sentText.length).trimStart() : current;
    this.setDraft(sessionId, remaining);
  }

  isSending(sessionId: string): boolean {
    return this.sendingSessionIds().has(sessionId);
  }

  markSending(sessionId: string, isSending: boolean): void {
    this.sendingSessionIds.update((ids) => {
      const next = new Set(ids);
      if (isSending) next.add(sessionId);
      else next.delete(sessionId);
      return next;
    });
  }

  failureOf(sessionId: string): string | undefined {
    return this.failedSends().get(sessionId);
  }

  markFailed(sessionId: string, message: string): void {
    this.failedSends.update((failures) => withEntry(failures, sessionId, message));
  }

  dismissFailure(sessionId: string): void {
    this.failedSends.update((failures) => withoutEntry(failures, sessionId));
  }

  /** Drops the draft of a session that can no longer be answered, unless a send is in flight or a failed send still has to be shown. */
  discardUnlessFailed(sessionId: string): void {
    const hasSendToSettle = this.isSending(sessionId) || this.failedSends().has(sessionId);
    if (hasSendToSettle) return;
    this.setDraft(sessionId, '');
  }
}
