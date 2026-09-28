import { effect, inject, Injectable, signal } from '@angular/core';
import type { Session } from '@openfleet/shared';
import { filter, Subscription } from 'rxjs';
import { FleetEventsService } from './fleet-events.service';

/** A normal interrupt leaves the 'generating' state within about half a second, so a session still generating this long after the Escape was cancelled silently. */
export const EARLY_ESCAPE_HINT_DELAY_MS = 4000;

/** A live turn writes at least every ~0.5 s (longest gaps measured: 339 ms streaming, 458 ms thinking), so output arriving this closely is one run. */
const LIVE_OUTPUT_MAX_GAP_MS = 500;
/** A redraw after a resize is a burst of a few dozen milliseconds; a live turn keeps going for at least this long. */
const SUSTAINED_OUTPUT_MS = 1000;

interface ArmedWatch {
  stateSince: string;
  stop: () => void;
}

function createSustainedOutputDetector(): () => boolean {
  let runStartedAt = 0;
  let lastOutputAt = -Infinity;
  return () => {
    const now = Date.now();
    const startsNewRun = now - lastOutputAt > LIVE_OUTPUT_MAX_GAP_MS;
    if (startsNewRun) runStartedAt = now;
    lastOutputAt = now;
    return now - runStartedAt >= SUSTAINED_OUTPUT_MS;
  };
}

/**
 * Claude CLI cancels a turn silently when Escape lands before its first reply: it puts the prompt back in its composer and
 * goes idle without a Stop hook, an interrupt line or an idle notification, so the session stays 'generating'.
 * This service tells that case from a normal interrupt: the session is still in the state it had when the Escape was
 * sent (a normal interrupt changes it within a moment) and its terminal has not run live since.
 *
 * The hint is an inference, so it is shown at most once per Escape: the watch is disarmed for good as soon as the terminal
 * outputs sustainedly (a live turn), the user types, or the turn the Escape belonged to is over. Only the next Escape arms it again.
 * A single redraw of the CLI (after a resize, a focus change or a remount) is not sustained output.
 */
@Injectable({ providedIn: 'root' })
export class EarlyEscapeHintService {
  private readonly events = inject(FleetEventsService);
  private readonly hintedStateSinceBySession = signal<ReadonlyMap<string, string>>(new Map());
  private readonly armedWatchesBySession = new Map<string, ArmedWatch>();

  constructor() {
    effect(() => this.disarmWatchesOfEndedTurns(this.events.sessions()));
  }

  isHinting(session: Session): boolean {
    const hintedStateSince = this.hintedStateSinceBySession().get(session.id);
    return session.state === 'generating' && hintedStateSince === session.stateSince;
  }

  escapeSent(sessionId: string): void {
    const session = this.currentSession(sessionId);
    if (session?.state !== 'generating') return;
    this.disarm(sessionId);

    const { stateSince } = session;
    const isThisSession = (id: string) => id === sessionId;
    const isOutputSustained = createSustainedOutputDetector();
    const hintTimer = setTimeout(() => this.showHint(sessionId, stateSince), EARLY_ESCAPE_HINT_DELAY_MS);

    const subscriptions = new Subscription();
    subscriptions.add(
      this.events.liveOutputSessionIds.pipe(filter(isThisSession)).subscribe(() => {
        if (isOutputSustained()) this.disarm(sessionId);
      }),
    );
    subscriptions.add(this.events.typedInSessionIds.pipe(filter(isThisSession)).subscribe(() => this.disarm(sessionId)));
    this.armedWatchesBySession.set(sessionId, {
      stateSince,
      stop: () => {
        clearTimeout(hintTimer);
        subscriptions.unsubscribe();
      },
    });
  }

  private showHint(sessionId: string, stateSince: string): void {
    this.hintedStateSinceBySession.update((hinted) => new Map(hinted).set(sessionId, stateSince));
  }

  private disarm(sessionId: string): void {
    this.armedWatchesBySession.get(sessionId)?.stop();
    this.armedWatchesBySession.delete(sessionId);
    this.hintedStateSinceBySession.update((hinted) => {
      const remaining = new Map(hinted);
      remaining.delete(sessionId);
      return remaining;
    });
  }

  private disarmWatchesOfEndedTurns(sessions: Session[]): void {
    for (const [sessionId, { stateSince }] of this.armedWatchesBySession) {
      const session = sessions.find((s) => s.id === sessionId);
      const isStillInTheTurnOfTheEscape = session?.state === 'generating' && session.stateSince === stateSince;
      if (!isStillInTheTurnOfTheEscape) this.disarm(sessionId);
    }
  }

  private currentSession(sessionId: string): Session | undefined {
    return this.events.sessions().find((s) => s.id === sessionId);
  }
}
