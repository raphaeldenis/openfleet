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
  /** Undefined while the daemon connection is down: the wait is paused, not just delayed, until it reconnects. */
  hintTimer: ReturnType<typeof setTimeout> | undefined;
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
 *
 * The wait also ignores time spent with the daemon connection down: a client that cannot hear the CLI's own reply has
 * no basis to infer anything, so the 4 s wait pauses while disconnected and restarts fresh once the connection is back.
 */
@Injectable({ providedIn: 'root' })
export class EarlyEscapeHintService {
  private readonly events = inject(FleetEventsService);
  private readonly hintedStateSinceBySession = signal<ReadonlyMap<string, string>>(new Map());
  private readonly armedWatchesBySession = new Map<string, ArmedWatch>();

  constructor() {
    effect(() => this.disarmWatchesOfEndedTurns(this.events.sessions()));
    effect(() => this.onConnectivityChange(this.events.connected()));
  }

  isHinting(session: Session): boolean {
    const hintedStateSince = this.hintedStateSinceBySession().get(session.id);
    return session.state === 'generating' && hintedStateSince === session.stateSince;
  }

  /**
   * `stateSince` is the turn the caller captured right before sending the Escape: sendInput is async, so the
   * turn it was sent against can already be over by the time this runs. Only arm the watch when it still is.
   */
  escapeSent(sessionId: string, stateSince: string): void {
    const session = this.currentSession(sessionId);
    const isStillTheTurnTheEscapeWasSentAgainst = session?.state === 'generating' && session.stateSince === stateSince;
    if (!isStillTheTurnTheEscapeWasSentAgainst) return;
    this.disarm(sessionId);

    const isThisSession = (id: string) => id === sessionId;
    const isOutputSustained = createSustainedOutputDetector();
    const subscriptions = new Subscription();
    subscriptions.add(
      this.events.liveOutputSessionIds.pipe(filter(isThisSession)).subscribe(() => {
        if (isOutputSustained()) this.disarm(sessionId);
      }),
    );
    subscriptions.add(this.events.typedInSessionIds.pipe(filter(isThisSession)).subscribe(() => this.disarm(sessionId)));

    const watch: ArmedWatch = {
      stateSince,
      hintTimer: undefined,
      stop: () => {
        clearTimeout(watch.hintTimer);
        subscriptions.unsubscribe();
      },
    };
    this.armedWatchesBySession.set(sessionId, watch);
    this.startHintTimerIfConnected(sessionId, watch);
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

  /**
   * A disconnect pauses every armed wait (the timer is cleared, not just left running blind); a reconnect restarts
   * each one fresh, provided the session it was armed for is still in the very turn the Escape was sent against.
   */
  private onConnectivityChange(connected: boolean): void {
    for (const [sessionId, watch] of this.armedWatchesBySession) {
      if (connected) this.startHintTimerIfConnected(sessionId, watch);
      else this.pauseHintTimer(watch);
    }
  }

  private startHintTimerIfConnected(sessionId: string, watch: ArmedWatch): void {
    if (!this.events.connected()) return;
    const session = this.currentSession(sessionId);
    const isStillTheTurnTheEscapeWasSentAgainst = session?.state === 'generating' && session.stateSince === watch.stateSince;
    if (!isStillTheTurnTheEscapeWasSentAgainst) {
      this.disarm(sessionId);
      return;
    }
    watch.hintTimer = setTimeout(() => this.showHint(sessionId, watch.stateSince), EARLY_ESCAPE_HINT_DELAY_MS);
  }

  private pauseHintTimer(watch: ArmedWatch): void {
    clearTimeout(watch.hintTimer);
    watch.hintTimer = undefined;
  }

  private currentSession(sessionId: string): Session | undefined {
    return this.events.sessions().find((s) => s.id === sessionId);
  }
}
