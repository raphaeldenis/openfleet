import { effect, inject, Injectable, signal } from '@angular/core';
import type { Session } from '@openfleet/shared';
import { filter, Subscription } from 'rxjs';
import { FleetEventsService } from './fleet-events.service';

/** A live turn redraws its spinner about every 100 ms, so a terminal quiet for this long after an Escape is an idle CLI. */
export const EARLY_ESCAPE_QUIET_MS = 4000;

interface EscapeWatch {
  stateSince: string;
  isTerminalQuiet: boolean;
}

interface ArmedWatch {
  stateSince: string;
  stop: () => void;
}

/**
 * Claude CLI cancels a turn silently when Escape lands before its first reply: it puts the prompt back in its composer and
 * goes idle without a Stop hook, an interrupt line or an idle notification, so the session stays 'generating'.
 * This service tells that case from a normal interrupt: the session is still in the state it had when the Escape was
 * sent (a normal interrupt changes it within a moment) and its terminal has gone quiet since.
 *
 * The hint is an inference, so it is shown at most once per Escape: the watch is disarmed for good as soon as the terminal
 * answers after the hint, the user types, or the turn the Escape belonged to is over. Only the next Escape arms it again.
 */
@Injectable({ providedIn: 'root' })
export class EarlyEscapeHintService {
  private readonly events = inject(FleetEventsService);
  private readonly watchesBySession = signal<ReadonlyMap<string, EscapeWatch>>(new Map());
  private readonly armedWatchesBySession = new Map<string, ArmedWatch>();

  constructor() {
    effect(() => this.disarmWatchesOfEndedTurns(this.events.sessions()));
  }

  isHinting(session: Session): boolean {
    const watch = this.watchesBySession().get(session.id);
    const isStillInTheStateOfTheEscape = session.state === 'generating' && watch?.stateSince === session.stateSince;
    return isStillInTheStateOfTheEscape && watch?.isTerminalQuiet === true;
  }

  escapeSent(sessionId: string): void {
    const session = this.currentSession(sessionId);
    if (session?.state !== 'generating') return;
    this.disarm(sessionId);

    const { stateSince } = session;
    let quietTimer: ReturnType<typeof setTimeout> | undefined;
    const waitForTerminalToGoQuiet = () => {
      clearTimeout(quietTimer);
      quietTimer = setTimeout(() => this.setTerminalQuiet({ sessionId, stateSince, isTerminalQuiet: true }), EARLY_ESCAPE_QUIET_MS);
    };
    const isHintShowing = () => this.watchesBySession().get(sessionId)?.isTerminalQuiet === true;
    const isThisSession = (id: string) => id === sessionId;

    const subscriptions = new Subscription();
    subscriptions.add(
      this.events.liveOutputSessionIds.pipe(filter(isThisSession)).subscribe(() => {
        if (isHintShowing()) return this.disarm(sessionId);
        waitForTerminalToGoQuiet();
      }),
    );
    subscriptions.add(this.events.typedInSessionIds.pipe(filter(isThisSession)).subscribe(() => this.disarm(sessionId)));
    this.armedWatchesBySession.set(sessionId, {
      stateSince,
      stop: () => {
        clearTimeout(quietTimer);
        subscriptions.unsubscribe();
      },
    });
    this.setTerminalQuiet({ sessionId, stateSince, isTerminalQuiet: false });
    waitForTerminalToGoQuiet();
  }

  private disarm(sessionId: string): void {
    this.armedWatchesBySession.get(sessionId)?.stop();
    this.armedWatchesBySession.delete(sessionId);
    this.watchesBySession.update((watches) => {
      const remaining = new Map(watches);
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

  private setTerminalQuiet({ sessionId, stateSince, isTerminalQuiet }: { sessionId: string; stateSince: string; isTerminalQuiet: boolean }): void {
    const current = this.watchesBySession().get(sessionId);
    const isAlreadySet = current?.stateSince === stateSince && current.isTerminalQuiet === isTerminalQuiet;
    if (isAlreadySet) return;
    this.watchesBySession.update((watches) => new Map(watches).set(sessionId, { stateSince, isTerminalQuiet }));
  }
}
