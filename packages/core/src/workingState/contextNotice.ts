import type { Session } from '@openfleet/shared';
import { log } from '../logger.js';
import type { ManagerRepository } from '../managers/managerRepository.js';
import type { SessionService } from '../sessions/sessionService.js';
import type { ContextNoticeRole, ContextNoticeSettings, ContextNoticeThresholds } from './workingStateSettings.js';

/** Runs `run` once after `delayMs` and returns the function that cancels it. */
export type ScheduleOnce = (run: () => void, delayMs: number) => () => void;

/** The CLI flushes a turn's lines to the transcript shortly after it fires Stop: the measure repeats once after this delay. */
export const CONTEXT_REMEASURE_DELAY_MS = 1_000;

const scheduleWithUnrefTimer: ScheduleOnce = (run, delayMs) => {
  const timer = setTimeout(run, delayMs);
  timer.unref();
  return () => clearTimeout(timer);
};

export interface ContextNoticeDeps { sessions: SessionService; managers: ManagerRepository; settings: ContextNoticeSettings; schedule?: ScheduleOnce }

/**
 * Raises a data-only notice on a watched session whose context passes a threshold: the column holds the highest
 * threshold crossed. It never touches the session itself: no message, no relaunch, no refusal.
 */
export class ContextNotice {
  private readonly cancelRemeasureBySessionId = new Map<string, () => void>();

  constructor(private readonly deps: ContextNoticeDeps) {}

  /** Measures now, then once more after the CLI has flushed the turn; a new Stop re-arms the second measure. */
  measureAtStop(sessionId: string): void {
    const session = this.deps.sessions.get(sessionId);
    if (!session || !this.isWatched(session)) return;
    this.armRemeasure(sessionId);
    this.measure(session);
  }

  measureAtPrompt(sessionId: string): void {
    const session = this.deps.sessions.get(sessionId);
    if (!session || !this.isWatched(session)) return;
    this.measure(session);
  }

  /** Cancels every pending delayed measure so none fires once the daemon closes its database. */
  stop(): void {
    for (const cancel of this.cancelRemeasureBySessionId.values()) cancel();
    this.cancelRemeasureBySessionId.clear();
  }

  private armRemeasure(sessionId: string): void {
    this.cancelRemeasureOf(sessionId);
    const schedule = this.deps.schedule ?? scheduleWithUnrefTimer;
    const cancel = schedule(() => this.remeasure(sessionId), CONTEXT_REMEASURE_DELAY_MS);
    this.cancelRemeasureBySessionId.set(sessionId, cancel);
  }

  private cancelRemeasureOf(sessionId: string): void {
    this.cancelRemeasureBySessionId.get(sessionId)?.();
    this.cancelRemeasureBySessionId.delete(sessionId);
  }

  private remeasure(sessionId: string): void {
    this.cancelRemeasureBySessionId.delete(sessionId);
    try {
      const session = this.deps.sessions.get(sessionId);
      const isClosed = session?.state === 'closed';
      if (!session || isClosed || !this.isWatched(session)) return;
      this.measure(session);
    } catch (error) {
      log('warn', `context notice remeasure failed, changing nothing: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private measure(session: Session): void {
    const sessionId = session.id;
    const contextTokens = this.deps.sessions.contextTokensOfLatestTurn(sessionId);
    if (contextTokens === undefined) return;

    const { firstAt, every } = this.thresholdsOf(session);
    const isUnderFirstThreshold = contextTokens < firstAt;
    if (isUnderFirstThreshold) return this.clearIfRaised(session);

    const stepsPastFirstThreshold = Math.floor((contextTokens - firstAt) / every);
    const crossedThreshold = firstAt + stepsPastFirstThreshold * every;
    const isNewHighestThreshold = crossedThreshold > (session.contextNoticeTokens ?? 0);
    if (isNewHighestThreshold) this.deps.sessions.setContextNoticeTokens(sessionId, crossedThreshold);
  }

  clearForNewConversation(sessionId: string): void {
    this.cancelRemeasureOf(sessionId);
    const session = this.deps.sessions.get(sessionId);
    if (session) this.clearIfRaised(session);
  }

  private clearIfRaised(session: Session): void {
    const hasRaisedNotice = session.contextNoticeTokens !== undefined;
    if (hasRaisedNotice) this.deps.sessions.setContextNoticeTokens(session.id, null);
  }

  private isWatched(session: Session): boolean {
    return this.deps.settings.roles[this.roleOf(session)] === true;
  }

  private roleOf(session: Session): ContextNoticeRole {
    if (this.deps.managers.get(session.id)) return 'manager';
    return session.parentId === undefined ? 'plain' : 'child';
  }

  private thresholdsOf(session: Session): ContextNoticeThresholds {
    const { firstAt, every, models } = this.deps.settings;
    const modelOverride = session.model === undefined ? undefined : models[session.model];
    return { firstAt: modelOverride?.firstAt ?? firstAt, every: modelOverride?.every ?? every };
  }
}
