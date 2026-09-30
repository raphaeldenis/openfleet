import type { EventBus } from '../events/eventBus.js';
import { log } from '../logger.js';
import type { SessionService } from '../sessions/sessionService.js';
import type { ManagerRecord, ManagerRepository } from './managerRepository.js';
import { toManagerView } from './managerView.js';
import { nextPulseAt } from './pulseTiming.js';

export const PULSE_MESSAGE = '[pulse] Re-read your mission and continue: check your children, unblock them, record what you did.';

const MAX_CHILD_NAME_LENGTH = 80;

const toSingleLineName = (name: string) => {
  const collapsed = name.replace(/[\s\p{Cc}]+/gu, ' ').trim();
  const isTooLong = collapsed.length > MAX_CHILD_NAME_LENGTH;
  return isTooLong ? `${collapsed.slice(0, MAX_CHILD_NAME_LENGTH)}…` : collapsed;
};

const MAX_LISTED_CLOSED_CHILDREN = 10;
// setTimeout clamps any longer delay to 1 ms.
const MAX_TIMER_DELAY_MS = 2 ** 31 - 1;

interface ClosedChild { name: string; exitCode: number | undefined }
// The wake line still waiting in a manager's queue: the children it names and how many closed in all.
interface QueuedWake { messageId: string; listed: ClosedChild[]; total: number }

const exitCodeText = (exitCode: number | undefined) => exitCode ?? 'unknown';

const wakeLineOf = ({ listed, total }: Pick<QueuedWake, 'listed' | 'total'>) => {
  const [onlyChild] = listed;
  if (total === 1 && onlyChild) return `[pulse] Child "${onlyChild.name}" closed (exit code ${exitCodeText(onlyChild.exitCode)}).`;
  const listedText = listed.map((child) => `"${child.name}" (exit ${exitCodeText(child.exitCode)})`).join(', ');
  const unlistedCount = total - listed.length;
  const unlistedText = unlistedCount > 0 ? `, and ${unlistedCount} more` : '';
  return `[pulse] ${total} children closed: ${listedText}${unlistedText}`;
};

export interface PulseSchedulerDeps {
  managers: ManagerRepository;
  sessions: SessionService;
  bus: EventBus;
}

export class PulseScheduler {
  private readonly deps: PulseSchedulerDeps;
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly queuedWakes = new Map<string, QueuedWake>();
  private isStopped = false;

  constructor(deps: PulseSchedulerDeps) {
    this.deps = deps;
    // A daemon restart re-arms every manager through start(); a reopened session has no equivalent
    // boot hook of its own, so it re-arms here off the same event SessionService.reopen() emits.
    this.deps.bus.subscribe((event) => {
      if (event.type === 'session.reopened') this.onSessionReopened(event.sessionId);
      if (event.type === 'session.state') this.restartHeartbeatOfManager(event.sessionId);
      if (event.type === 'session.closed') this.wakeManagerOfClosedChild(event.sessionId, event.exitCode);
    });
  }

  start(): void {
    this.isStopped = false;
    for (const record of this.deps.managers.list()) {
      if (this.isManagerAlive(record.sessionId)) this.arm(record);
    }
  }

  onManagerCreated(record: ManagerRecord): void {
    this.arm(record);
  }

  private onSessionReopened(sessionId: string): void {
    if (this.isStopped) return;
    const record = this.deps.managers.getWithinBounds(sessionId);
    if (!record) return; // not a manager: nothing to re-arm
    this.arm(record);
  }

  pulseNow(sessionId: string): { coalesced: boolean } | undefined {
    const record = this.deps.managers.getWithinBounds(sessionId);
    if (!record) return undefined;
    if (!this.isManagerAlive(sessionId)) return undefined; // a closed manager is never pulsed
    this.clearTimer(sessionId);
    return this.fire(record);
  }

  // The interval is a heartbeat: any change of a manager's state is a turn starting or ending, whoever
  // started it, and a pulse is only for a manager that stayed silent for one full interval.
  private restartHeartbeatOfManager(sessionId: string): void {
    if (this.isStopped) return;
    const record = this.deps.managers.getWithinBounds(sessionId);
    if (!record) return;
    if (!this.isManagerAlive(sessionId)) return;
    this.armAfter(sessionId, record.pulseSeconds * 1000);
  }

  // The daemon stops the scheduler before it closes every session at shutdown: no child dying then
  // may leave a wake-up line queued for a manager that is going down too.
  private wakeManagerOfClosedChild(childId: string, exitCode: number | undefined): void {
    if (this.isStopped) return;
    const child = this.deps.sessions.get(childId);
    const managerId = child?.parentId;
    if (!child || !managerId) return;
    if (!this.deps.managers.get(managerId)) return;
    if (!this.isManagerAlive(managerId)) return;
    // A close the manager asked for is not news to it: the wake line is for a child that ended unannounced.
    if (this.deps.sessions.isClosingByParent(childId)) return;
    try {
      this.queueWakeLine(managerId, { name: toSingleLineName(child.name), exitCode });
    } catch (error) {
      log('error', `pulse: could not wake manager ${managerId} after child ${childId} closed`, error);
    }
  }

  // One queued wake line per manager: a burst of closes grows that line instead of queueing a turn each,
  // so a human message queued behind it waits for one wake turn at most.
  private queueWakeLine(managerId: string, closedChild: ClosedChild): void {
    const queued = this.queuedWakes.get(managerId);
    if (queued) {
      const grown = { messageId: queued.messageId, listed: [...queued.listed, closedChild].slice(0, MAX_LISTED_CLOSED_CHILDREN), total: queued.total + 1 };
      const body = wakeLineOf(grown);
      const isMergedIntoQueuedLine = this.deps.sessions.replaceQueuedMessageBody({ sessionId: managerId, messageId: grown.messageId, body });
      if (isMergedIntoQueuedLine) { this.queuedWakes.set(managerId, grown); return; }
    }
    const fresh = { listed: [closedChild], total: 1 };
    const { messageId } = this.deps.sessions.sendMessage({ sessionId: managerId, body: wakeLineOf(fresh) });
    this.queuedWakes.set(managerId, { messageId, ...fresh });
  }

  stop(): void {
    this.isStopped = true;
    this.queuedWakes.clear();
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }

  private arm(record: ManagerRecord): void {
    const delayMs = Math.max(0, new Date(nextPulseAt(record)).getTime() - Date.now());
    this.armAfter(record.sessionId, delayMs);
  }

  private armAfter(sessionId: string, delayMs: number): void {
    this.clearTimer(sessionId);
    const isOutOfBounds = !this.deps.managers.getWithinBounds(sessionId);
    if (isOutOfBounds) return; // a legacy row is never armed
    this.timers.set(sessionId, setTimeout(() => this.tick(sessionId), Math.min(delayMs, MAX_TIMER_DELAY_MS)));
  }

  private tick(sessionId: string): void {
    const record = this.deps.managers.getWithinBounds(sessionId);
    if (!record) return; // manager record removed
    if (!this.isManagerAlive(sessionId)) { this.clearTimer(sessionId); return; } // a closed manager never reschedules itself
    if (!this.isManagerIdle(sessionId)) { this.armAfter(sessionId, record.pulseSeconds * 1000); return; } // a busy manager had its turn: no pulse
    // A timer callback has no caller to catch a throw (e.g. a refused SQLite write): left unguarded, it
    // would escape as an uncaught exception and, worse, never re-arm — this manager's cadence would be
    // dead until the next daemon restart. Logged and re-armed instead, so one bad tick doesn't end it.
    try {
      this.fire(record);
    } catch (error) {
      log('error', `pulse: manager ${sessionId} tick failed; re-arming instead of losing its cadence`, error);
      // Re-arms a full cadence from now, never via nextPulseAt(record): fire() threw before persisting
      // lastPulseAt, so record's base is stale — computing off it would land in the past (delayMs 0) and
      // hot-loop the retry every tick instead of waiting out the cadence.
      this.armAfter(sessionId, record.pulseSeconds * 1000);
    }
  }

  private isManagerAlive(sessionId: string): boolean {
    const session = this.deps.sessions.get(sessionId);
    return session !== undefined && session.state !== 'closed';
  }

  private isManagerIdle(sessionId: string): boolean {
    return this.deps.sessions.get(sessionId)?.state === 'idle';
  }

  // A pulse cycle happens every pulseSeconds: lastPulseAt always advances to now and manager.pulsed always
  // fires, whether or not the [pulse] message itself gets enqueued — a manager stuck gated for many cycles
  // must not pile up queued pulses, but its cadence (and the next armed deadline) still moves forward.
  private fire(record: ManagerRecord): { coalesced: boolean } {
    // Goes through the ordinary message queue, exactly like a message from a parent or sibling: if the
    // manager is mid-turn or waiting on a human, the pulse queues and is flushed on its next idle turn —
    // it never interrupts a running tool or answers a permission prompt.
    const coalesced = this.deps.sessions.hasQueuedMessage(record.sessionId, PULSE_MESSAGE);
    if (!coalesced) this.deps.sessions.sendMessage({ sessionId: record.sessionId, body: PULSE_MESSAGE });
    const pulsedAt = new Date().toISOString();
    this.deps.managers.setLastPulseAt(record.sessionId, pulsedAt);
    const updated: ManagerRecord = { ...record, lastPulseAt: pulsedAt };
    const childrenCount = this.deps.sessions.list().filter((s) => s.parentId === record.sessionId && s.state !== 'closed').length;
    this.deps.bus.emit({ type: 'manager.pulsed', manager: toManagerView(updated, childrenCount) });
    this.arm(updated);
    return { coalesced };
  }

  private clearTimer(sessionId: string): void {
    const timer = this.timers.get(sessionId);
    if (timer) clearTimeout(timer);
    this.timers.delete(sessionId);
  }
}
