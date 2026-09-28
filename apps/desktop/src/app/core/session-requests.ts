import type { WritableSignal } from '@angular/core';
import { runGuarded } from './run-guarded';

interface ShownRequestState {
  shownSessionId: () => string;
  busy: WritableSignal<boolean>;
  error: WritableSignal<string | null>;
}

/**
 * One kind of request (close, reopen, apply…) of a component that stays mounted while the route switches
 * session. Each session keeps its own request in flight: it still reads as busy after A → B → A, a second run
 * for that session is skipped meanwhile, and a request settling while another session is shown leaves that
 * session's busy flag and error alone.
 */
export class SessionRequests {
  private readonly sessionsInFlight = new Set<string>();

  constructor(private readonly shown: ShownRequestState) {}

  /** Points busy and error at `sessionId`: busy while its own request is in flight, no error. */
  show(sessionId: string): void {
    this.shown.busy.set(this.sessionsInFlight.has(sessionId));
    this.shown.error.set(null);
  }

  /** `action` learns whether its session is no longer the shown one through `isStale`. */
  async run(
    sessionId: string,
    message: string | ((error: unknown) => string),
    action: (isStale: () => boolean) => Promise<unknown>,
  ): Promise<void> {
    if (this.sessionsInFlight.has(sessionId)) return;
    this.sessionsInFlight.add(sessionId);
    const isStale = () => this.shown.shownSessionId() !== sessionId;
    try {
      await runGuarded(this.shown.busy, this.shown.error, message, () => action(isStale), { isStale });
    } finally {
      this.sessionsInFlight.delete(sessionId);
    }
  }
}
