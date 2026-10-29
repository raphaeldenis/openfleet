import type { EventBus } from '../events/eventBus.js';
import { log } from '../logger.js';
import { SLEEP_PREFIX } from '../sessions/daemonLines.js';
import type { SessionService } from '../sessions/sessionService.js';
import { modeOf, sleepHandoffMessageId, type ManagerRepository } from './managerRepository.js';

export const SLEEP_HANDOFF_TEXT = `${SLEEP_PREFIX} Note where things stand in your journal, schedule an event for everything that needs follow-up, then stop.`;

const HANDOFF_ID_PREFIX = 'handoff:';

export interface SleepHandoffDeps {
  bus: EventBus;
  sessions: Pick<SessionService, 'get' | 'sendMessage'>;
  managers: Pick<ManagerRepository, 'get' | 'markSleepHandoffDelivered' | 'sessionIdsOwingSleepHandoff'>;
  clock: () => string;
}

/**
 * Delivers the one [sleep] message a manager owes after it switched to sleeping, through its message queue, and records its delivery.
 * The message id names the switch, so enqueuing it again is the same message: an update, a reopen or a daemon restart never sends a second one.
 */
export class SleepHandoff {
  constructor(private readonly deps: SleepHandoffDeps) {
    deps.bus.subscribe((event) => {
      if (event.type === 'manager.updated') this.deliverIfOwed(event.manager.sessionId);
      if (event.type === 'session.reopened') this.deliverIfOwed(event.sessionId);
      if (event.type === 'message.delivered' && event.messageId.startsWith(HANDOFF_ID_PREFIX)) this.confirmIfHandoff(event);
    });
  }

  /** Finishes the switches a previous daemon run left half done. */
  start(): void {
    for (const managerId of this.deps.managers.sessionIdsOwingSleepHandoff()) this.deliverIfOwed(managerId);
  }

  private deliverIfOwed(managerId: string): void {
    const record = this.deps.managers.get(managerId);
    const messageId = record?.modeChangedAt ? sleepHandoffMessageId({ sessionId: managerId, modeChangedAt: record.modeChangedAt }) : undefined;
    const isOwed = record !== undefined && record.sleepHandoffPending === true && modeOf(record) === 'sleeping' && messageId !== undefined;
    if (!isOwed) return;
    const state = this.deps.sessions.get(managerId)?.state;
    const isManagerOpen = state !== undefined && state !== 'closed';
    if (!isManagerOpen) return;
    try {
      const { status } = this.deps.sessions.sendMessage({ sessionId: managerId, messageId, body: SLEEP_HANDOFF_TEXT });
      if (status === 'delivered') this.deps.managers.markSleepHandoffDelivered(managerId, this.deps.clock());
    } catch (error) {
      log('warn', `sleep handoff: manager ${managerId} could not be told`, error);
    }
  }

  private confirmIfHandoff({ sessionId, messageId }: { sessionId: string; messageId: string }): void {
    const record = this.deps.managers.get(sessionId);
    const isCurrentHandoff = record?.modeChangedAt !== undefined && messageId === sleepHandoffMessageId({ sessionId, modeChangedAt: record.modeChangedAt });
    if (isCurrentHandoff) this.deps.managers.markSleepHandoffDelivered(sessionId, this.deps.clock());
  }
}
