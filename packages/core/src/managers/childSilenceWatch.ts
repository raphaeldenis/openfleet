import { MANAGER_ROLE } from '@openfleet/shared';
import type { EventBus } from '../events/eventBus.js';
import { log } from '../logger.js';
import { SCHEDULED_EVENT_PREFIX } from '../sessions/daemonLines.js';
import type { SessionService } from '../sessions/sessionService.js';
import { localDateTimeOf } from './localDateTime.js';

export const SILENCE_CHECK_TITLE = 'silence_check';
export const DEFAULT_SILENCE_CHECK_DELAY_MS = 10 * 60_000;
const MINUTE_MS = 60_000;

export interface ChildSilenceWatchDeps {
  sessions: Pick<SessionService, 'get' | 'sendMessage'>;
  bus: EventBus;
  delayMs: number;
  clock: () => number;
  /** Runs the callback after the delay and returns the function that cancels it. */
  schedule: (callback: () => void, delayMs: number) => () => void;
}

interface SilenceCheck {
  managerId: string;
  childId: string;
  cancel: () => void;
}

const minutesBetween = (earlier: number, later: number): number => Math.max(0, Math.round((later - earlier) / MINUTE_MS));

/**
 * One deadline per child: ten minutes after a manager messages a live child, the manager is woken unless the child
 * answered or closed. The deadlines live in memory only and are neither scheduled events nor counted in their cap.
 */
export class ChildSilenceWatch {
  private readonly checksByChildId = new Map<string, SilenceCheck>();

  constructor(private readonly deps: ChildSilenceWatchDeps) {
    deps.bus.subscribe((event) => {
      if (event.type === 'session.closed') this.forgetChecksOf(event.sessionId);
    });
  }

  /** Reads one agent-to-agent message that was just sent: a manager to its child arms the check, a child to its manager cancels it. */
  observeAgentMessage({ fromSessionId, toSessionId }: { fromSessionId: string; toSessionId: string }): void {
    const sender = this.deps.sessions.get(fromSessionId);
    const recipient = this.deps.sessions.get(toSessionId);
    if (!sender || !recipient) return;
    const isManagerMessagingItsChild = sender.role === MANAGER_ROLE && recipient.parentId === sender.id;
    const isChildAnsweringItsManager = sender.parentId === recipient.id;
    if (isManagerMessagingItsChild) return this.arm({ managerId: sender.id, childId: recipient.id });
    if (isChildAnsweringItsManager) this.cancelCheckOf(sender.id);
  }

  stop(): void {
    for (const check of this.checksByChildId.values()) check.cancel();
    this.checksByChildId.clear();
  }

  private arm({ managerId, childId }: { managerId: string; childId: string }): void {
    this.cancelCheckOf(childId);
    const messageSentAt = this.deps.clock();
    const cancel = this.deps.schedule(() => this.wakeManager({ managerId, childId, messageSentAt }), this.deps.delayMs);
    this.checksByChildId.set(childId, { managerId, childId, cancel });
  }

  private cancelCheckOf(childId: string): void {
    this.checksByChildId.get(childId)?.cancel();
    this.checksByChildId.delete(childId);
  }

  private forgetChecksOf(closedSessionId: string): void {
    const checks = [...this.checksByChildId.values()];
    for (const check of checks) {
      const isClosedSessionInvolved = check.childId === closedSessionId || check.managerId === closedSessionId;
      if (isClosedSessionInvolved) this.cancelCheckOf(check.childId);
    }
  }

  private wakeManager({ managerId, childId, messageSentAt }: { managerId: string; childId: string; messageSentAt: number }): void {
    this.checksByChildId.delete(childId);
    const child = this.deps.sessions.get(childId);
    const isChildStillAlive = child !== undefined && child.state !== 'closed';
    if (!isChildStillAlive) return;
    const now = this.deps.clock();
    const silentMinutes = minutesBetween(messageSentAt, now);
    const stateMinutes = minutesBetween(Date.parse(child.stateSince), now);
    const body = `${SCHEDULED_EVENT_PREFIX} "${SILENCE_CHECK_TITLE}", due ${localDateTimeOf(new Date(now))}] ${child.name} (${child.id}) has not answered your message of ${silentMinutes} min ago; its last sign of life is ${stateMinutes} min old (state ${child.state}). Look at it with get_session_card, or message it again.`;
    try {
      this.deps.sessions.sendMessage({ sessionId: managerId, body });
    } catch (error) {
      log('warn', `silence check: manager ${managerId} could not be told about child ${childId}`, error);
    }
  }
}
