import { MANAGER_ROLE } from '@openfleet/shared';
import type { EventBus } from '../events/eventBus.js';
import { log } from '../logger.js';
import { SCHEDULED_EVENT_PREFIX } from '../sessions/daemonLines.js';
import type { AgentMessageSent, SessionService } from '../sessions/sessionService.js';
import { localDateTimeOf } from './localDateTime.js';
import { modeOf, type ManagerRepository } from './managerRepository.js';

export const SILENCE_CHECK_TITLE = 'silence_check';
export const DEFAULT_SILENCE_CHECK_DELAY_MS = 10 * 60_000;
const MINUTE_MS = 60_000;
const NOT_A_SCHEDULED_EVENT_NOTICE = 'This reminder is not listed by list_argus_events and cancel_argus_event does not cancel it.';

export interface ChildSilenceWatchDeps {
  sessions: Pick<SessionService, 'get' | 'sendMessage' | 'onAgentMessageSent'>;
  managers: Pick<ManagerRepository, 'getWithinBounds'>;
  bus: EventBus;
  delayMs: number;
  clock: () => number;
  /** Runs the callback after the delay and returns the function that cancels it. */
  schedule: (callback: () => void, delayMs: number) => () => void;
}

interface SilenceCheck {
  managerId: string;
  childId: string;
  messageSentAt: number;
  cancel: () => void;
}

const minutesBetween = (earlier: number, later: number): number => Math.max(0, Math.round((later - earlier) / MINUTE_MS));

/**
 * One deadline per child: ten minutes after a manager messages a live child, the manager is woken unless the child
 * answered, closed or changed state meanwhile. The deadlines live in memory only and are neither scheduled events nor
 * counted in their cap. Several children that fall silent together wake the manager once each.
 */
export class ChildSilenceWatch {
  private readonly checksByChildId = new Map<string, SilenceCheck>();

  constructor(private readonly deps: ChildSilenceWatchDeps) {
    deps.sessions.onAgentMessageSent((message) => this.observe(message));
    deps.bus.subscribe((event) => {
      if (event.type === 'session.closed') this.forgetChecksOf(event.sessionId);
    });
  }

  stop(): void {
    for (const check of this.checksByChildId.values()) check.cancel();
    this.checksByChildId.clear();
  }

  private observe({ fromSessionId, toSessionId }: AgentMessageSent): void {
    const sender = this.deps.sessions.get(fromSessionId);
    const recipient = this.deps.sessions.get(toSessionId);
    if (!sender || !recipient) return;
    const isManagerMessagingItsChild = sender.role === MANAGER_ROLE && recipient.parentId === sender.id;
    if (isManagerMessagingItsChild) return this.arm({ managerId: sender.id, childId: recipient.id });
    const isChildAnsweringItsManager = sender.parentId === recipient.id;
    const isCheckOfThisManager = this.checksByChildId.get(sender.id)?.managerId === recipient.id;
    if (isChildAnsweringItsManager && isCheckOfThisManager) this.cancelCheckOf(sender.id);
  }

  private arm({ managerId, childId }: { managerId: string; childId: string }): void {
    this.cancelCheckOf(childId);
    const check: SilenceCheck = { managerId, childId, messageSentAt: this.deps.clock(), cancel: () => {} };
    check.cancel = this.deps.schedule(() => this.wakeManager(check), this.deps.delayMs);
    this.checksByChildId.set(childId, check);
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

  private wakeManager(check: SilenceCheck): void {
    const isCurrentCheck = this.checksByChildId.get(check.childId) === check;
    if (!isCurrentCheck) return;
    this.checksByChildId.delete(check.childId);
    const child = this.deps.sessions.get(check.childId);
    const isChildStillOpen = child !== undefined && child.state !== 'closed';
    if (!isChildStillOpen) return;
    const managerRecord = this.deps.managers.getWithinBounds(check.managerId);
    const isManagerDisabled = managerRecord !== undefined && modeOf(managerRecord) === 'disabled';
    if (isManagerDisabled) return;
    const now = this.deps.clock();
    const lastSignOfLifeAt = Date.parse(child.stateSince);
    const hasChangedStateRecently = now - lastSignOfLifeAt < this.deps.delayMs;
    if (hasChangedStateRecently) return;
    const silentMinutes = minutesBetween(check.messageSentAt, now);
    const lastSignOfLifeMinutes = minutesBetween(lastSignOfLifeAt, now);
    const body = `${SCHEDULED_EVENT_PREFIX} "${SILENCE_CHECK_TITLE}", due ${localDateTimeOf(new Date(now))}] ${child.name} (${child.id}) has not answered your message of ${silentMinutes} min ago; its last sign of life is ${lastSignOfLifeMinutes} min old (state ${child.state}). Look at it with get_session_card, or message it again. ${NOT_A_SCHEDULED_EVENT_NOTICE}`;
    try {
      this.deps.sessions.sendMessage({ sessionId: check.managerId, body });
    } catch (error) {
      log('warn', `silence check: manager ${check.managerId} could not be told about child ${check.childId}`, error);
    }
  }
}
