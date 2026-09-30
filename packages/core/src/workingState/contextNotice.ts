import type { Session } from '@openfleet/shared';
import type { ManagerRepository } from '../managers/managerRepository.js';
import type { SessionService } from '../sessions/sessionService.js';
import type { ContextNoticeRole, ContextNoticeSettings, ContextNoticeThresholds } from './workingStateSettings.js';

export interface ContextNoticeDeps { sessions: SessionService; managers: ManagerRepository; settings: ContextNoticeSettings }

/**
 * Raises a data-only notice on a watched session whose context passes a threshold: the column holds the highest
 * threshold crossed. It never touches the session itself: no message, no relaunch, no refusal.
 */
export class ContextNotice {
  constructor(private readonly deps: ContextNoticeDeps) {}

  measureAtStop(sessionId: string): void {
    const session = this.deps.sessions.get(sessionId);
    if (!session || !this.isWatched(session)) return;
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
