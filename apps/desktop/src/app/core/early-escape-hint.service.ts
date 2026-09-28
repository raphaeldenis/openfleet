import { inject, Injectable, signal } from '@angular/core';
import type { Session } from '@openfleet/shared';
import { FleetEventsService } from './fleet-events.service';

/** A live turn redraws its spinner about every 100 ms, so a terminal quiet for this long after an Escape is an idle CLI. */
export const EARLY_ESCAPE_QUIET_MS = 4000;

interface EscapeWatch {
  stateSince: string;
  isTerminalQuiet: boolean;
}

/**
 * Claude CLI cancels a turn silently when Escape lands before its first reply: it puts the prompt back in its composer and
 * goes idle without a Stop hook, an interrupt line or an idle notification, so the session stays 'generating'.
 * This service tells that case from a normal interrupt: the session is still in the state it had when the Escape was
 * sent (a normal interrupt changes it within a moment) and its terminal has gone quiet since.
 */
@Injectable({ providedIn: 'root' })
export class EarlyEscapeHintService {
  private readonly events = inject(FleetEventsService);
  private readonly watchesBySession = signal<ReadonlyMap<string, EscapeWatch>>(new Map());
  private readonly stopWatchingBySession = new Map<string, () => void>();

  isHinting(session: Session): boolean {
    const watch = this.watchesBySession().get(session.id);
    const isStillInTheStateOfTheEscape = session.state === 'generating' && watch?.stateSince === session.stateSince;
    return isStillInTheStateOfTheEscape && watch?.isTerminalQuiet === true;
  }

  escapeSent(sessionId: string): void {
    const session = this.currentSession(sessionId);
    if (session?.state !== 'generating') return;
    this.stopWatchingBySession.get(sessionId)?.();

    const { stateSince } = session;
    let quietTimer: ReturnType<typeof setTimeout> | undefined;
    const watchTerminal = () => {
      clearTimeout(quietTimer);
      this.setTerminalQuiet({ sessionId, stateSince, isTerminalQuiet: false });
      quietTimer = setTimeout(() => this.setTerminalQuiet({ sessionId, stateSince, isTerminalQuiet: true }), EARLY_ESCAPE_QUIET_MS);
    };
    const outputSubscription = this.events.output(sessionId).subscribe(() => {
      const hasStateMoved = this.currentSession(sessionId)?.stateSince !== stateSince;
      if (hasStateMoved) return this.stopWatchingBySession.get(sessionId)?.();
      watchTerminal();
    });
    this.stopWatchingBySession.set(sessionId, () => {
      clearTimeout(quietTimer);
      outputSubscription.unsubscribe();
    });
    watchTerminal();
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
