import type { EventBus } from '../events/eventBus.js';
import { log } from '../logger.js';
import type { DescribeError, SessionService } from '../sessions/sessionService.js';
import { profileRecallOf } from './managerProfileRecall.js';
import { isPulseEnabled, type ManagerRecord, type ManagerRepository } from './managerRepository.js';
import { toManagerView, type DeniedCommandCounts, type ManagerBaseIdentity } from './managerView.js';
import { nextPulseAt } from './pulseTiming.js';
import { OpenFleetError, PULSE_WAKE_REASONS, type PulseWakeReason, type RuntimeAttention } from '@openfleet/shared';

export const PULSE_MESSAGE = '[pulse] Re-read your mission and continue: check your children, unblock them, record what you did.';

const unseenRefusalsLineOf = (unseenRefusalCount: number): string => {
  const noun = unseenRefusalCount === 1 ? 'command refusal' : 'command refusals';
  return `${unseenRefusalCount} ${noun} since your last look — call list_denied_commands.`;
};

const BASE_SHA_PREFIX_LENGTH = 8;

const baseLineOf = ({ version, sha }: ManagerBaseIdentity): string => `Base v${version} (${sha.slice(0, BASE_SHA_PREFIX_LENGTH)}).`;

/** The pulse text of a manager: the plain pulse, where to re-read the mission when it lives in a note, the expertise and pulse actions it wrote, the manager base it follows, and how many command refusals it has not looked at. */
export const pulseMessageOf = (
  record: Pick<ManagerRecord, 'missionNoteId' | 'expertise' | 'pulseActions'>,
  { unseenRefusalCount = 0, managerBase }: { unseenRefusalCount?: number; managerBase?: ManagerBaseIdentity } = {},
): string => {
  const hasMissionNote = record.missionNoteId !== undefined;
  const hasUnseenRefusals = unseenRefusalCount > 0;
  const profileRecall = profileRecallOf(record);
  const missionLine = hasMissionNote ? ` Your mission note id is ${record.missionNoteId}; read it every time you wake with get_note.` : '';
  const profileLine = profileRecall === '' ? '' : ` ${profileRecall}`;
  const baseLine = managerBase ? ` ${baseLineOf(managerBase)}` : '';
  const refusalsLine = hasUnseenRefusals ? ` ${unseenRefusalsLineOf(unseenRefusalCount)}` : '';
  return `${PULSE_MESSAGE}${missionLine}${profileLine}${baseLine}${refusalsLine}`;
};

/** The pulse as the manager reads it: the pulse text, then why it wakes, strongest reason first. */
export const pulseBodyOf = ({ pulseText, wakeReasons }: { pulseText: string; wakeReasons: readonly PulseWakeReason[] }): string =>
  `${pulseText} Wake reason: ${wakeReasons.join(', ')}.`;

const withWakeReason = (wakeReasons: readonly PulseWakeReason[], addedReason: PulseWakeReason): PulseWakeReason[] =>
  PULSE_WAKE_REASONS.filter((reason) => reason === addedReason || wakeReasons.includes(reason));

const MAX_CHILD_NAME_LENGTH = 80;

const toSingleLineName = (name: string) => {
  const collapsed = name.replace(/[\s\p{Cc}]+/gu, ' ').trim();
  const isTooLong = collapsed.length > MAX_CHILD_NAME_LENGTH;
  return isTooLong ? `${collapsed.slice(0, MAX_CHILD_NAME_LENGTH)}…` : collapsed;
};

const MAX_LISTED_CHILD_WAKES = 10;
// setTimeout clamps any longer delay to 1 ms.
const MAX_TIMER_DELAY_MS = 2 ** 31 - 1;

interface ChildWakeNotice { label: string; exitCode: number | undefined; runtimeAttention?: RuntimeAttention }
interface QueuedWake { messageId: string; listed: ChildWakeNotice[]; total: number }
interface QueuedPulse { messageId: string; pulseText: string; wakeReasons: PulseWakeReason[] }

const exitCodeText = (exitCode: number | undefined) => exitCode ?? 'unknown';

const runtimeAttentionWakeLineOf = ({ listed, total }: Pick<QueuedWake, 'listed' | 'total'>) => {
  const notices = listed.map((child) => child.runtimeAttention
    ? `${child.label}: ${child.runtimeAttention.reason}`
    : `"${child.label}" closed (exit ${exitCodeText(child.exitCode)})`);
  const hiddenCount = total - listed.length;
  const remainder = hiddenCount > 0 ? `, and ${hiddenCount} more` : '';
  return `[pulse] Child runtime attention after a possible system resume: ${notices.join(', ')}${remainder}. Check current session status.`;
};

const wakeLineOf = ({ listed, total }: Pick<QueuedWake, 'listed' | 'total'>) => {
  const hasRuntimeAttention = listed.some((child) => child.runtimeAttention !== undefined);
  if (hasRuntimeAttention) return runtimeAttentionWakeLineOf({ listed, total });
  const [onlyChild] = listed;
  if (total === 1 && onlyChild) return `[pulse] Child "${onlyChild.label}" closed (exit code ${exitCodeText(onlyChild.exitCode)}).`;
  const listedText = listed.map((child) => `"${child.label}" (exit ${exitCodeText(child.exitCode)})`).join(', ');
  const unlistedCount = total - listed.length;
  const unlistedText = unlistedCount > 0 ? `, and ${unlistedCount} more` : '';
  return `[pulse] ${total} children closed: ${listedText}${unlistedText}`;
};

export interface PulseSchedulerDeps {
  managers: ManagerRepository;
  sessions: SessionService;
  bus: EventBus;
  /** Absent, a failing tick is only logged: no error event reaches the clients. */
  describeError?: DescribeError;
  /** Absent, no manager has any refused command. */
  deniedCommandCountsOf?: (managerId: string) => DeniedCommandCounts;
  /** The manager base this daemon ships. Absent, the pulse names no base. */
  managerBase?: ManagerBaseIdentity;
}

export class PulseScheduler {
  private readonly deps: PulseSchedulerDeps;
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly queuedWakes = new Map<string, QueuedWake>();
  private readonly queuedPulses = new Map<string, QueuedPulse>();
  private readonly managerIdsInFailureStreak = new Set<string>();
  private readonly forcedTickFailuresLeftByManager = new Map<string, number>();
  private readonly notifiedRuntimeLaunches = new Map<string, RuntimeAttention>();
  private isStopped = false;

  constructor(deps: PulseSchedulerDeps) {
    this.deps = deps;
    // A daemon restart re-arms every manager through start(); a reopened session has no equivalent
    // boot hook of its own, so it re-arms here off the same event SessionService.reopen() emits.
    this.deps.bus.subscribe((event) => {
      if (event.type === 'session.reopened') this.onSessionReopened(event.sessionId);
      if (event.type === 'session.state') this.restartHeartbeatOfManager(event.sessionId);
      if (event.type === 'session.closed') this.wakeManagerOfClosedChild(event.sessionId, event.exitCode);
      if (event.type === 'session.attention') this.wakeManagerOfRuntimeAttention(event.sessionId, event.runtimeAttention);
      if (event.type === 'manager.updated') this.refreshQueuedPulse(event.manager.sessionId);
    });
  }

  start(): void {
    this.isStopped = false;
    for (const record of this.deps.managers.list()) {
      const isRunning = isPulseEnabled(record) && this.isManagerAlive(record.sessionId);
      if (isRunning) this.arm(record);
    }
  }

  onManagerCreated(record: ManagerRecord): void {
    this.arm(record);
  }

  /** A new cadence takes effect at once: a live manager waits one full new interval from now. */
  onManagerUpdated(record: ManagerRecord): void {
    if (this.isStopped) return;
    if (!this.isManagerAlive(record.sessionId)) return;
    this.armAfter(record.sessionId, record.pulseSeconds * 1000);
  }

  private onSessionReopened(sessionId: string): void {
    if (this.isStopped) return;
    const record = this.deps.managers.getWithinBounds(sessionId);
    if (!record) return; // not a manager: nothing to re-arm
    this.arm(record);
  }

  /** Test-only: the next `count` ticks of this manager throw before pulsing. */
  failNextTicks(sessionId: string, count: number): void {
    this.forcedTickFailuresLeftByManager.set(sessionId, count);
  }

  /** A paused manager and a closed one are never pulsed: the first throws manager_paused, the second answers undefined. */
  pulseNow(sessionId: string): { coalesced: boolean } | undefined {
    const record = this.deps.managers.getWithinBounds(sessionId);
    if (!record) return undefined;
    if (!this.isManagerAlive(sessionId)) return undefined;
    if (!isPulseEnabled(record)) throw new OpenFleetError('manager_paused', 'the manager is paused.', { hint: 'resume its pulses first.' });
    this.clearTimer(sessionId);
    return this.fire(record, 'manual');
  }

  /** A paused manager drops its queued pulses and stops its timer; a resumed one gets one pulse at once. */
  onPulseEnabledChanged(record: ManagerRecord): void {
    if (this.isStopped) return;
    if (isPulseEnabled(record)) this.pulseResumedManager(record);
    else this.silencePausedManager(record.sessionId);
  }

  // A pulse already typing, typed, submitted or reviewing cannot be discarded: it is delivered even after the pause.
  private silencePausedManager(sessionId: string): void {
    this.clearTimer(sessionId);
    const queuedPulse = this.queuedPulses.get(sessionId);
    const queuedWake = this.queuedWakes.get(sessionId);
    if (queuedPulse) this.deps.sessions.discardQueuedMessage({ sessionId, messageId: queuedPulse.messageId });
    if (queuedWake) this.deps.sessions.discardQueuedMessage({ sessionId, messageId: queuedWake.messageId });
    this.queuedPulses.delete(sessionId);
    this.queuedWakes.delete(sessionId);
  }

  private pulseResumedManager(record: ManagerRecord): void {
    // A closed manager stays silent on resume: its reopening re-arms it from its last pulse.
    if (!this.isManagerAlive(record.sessionId)) return;
    try {
      this.clearTimer(record.sessionId);
      this.fire(record, 'resume');
    } catch (error) {
      this.reportTickFailure(record.sessionId, error);
      this.armAfter(record.sessionId, record.pulseSeconds * 1000);
    }
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
    const alreadyReportsPostResumeExit = child?.runtimeAttention?.reason === 'post_wake_process_exited';
    if (alreadyReportsPostResumeExit) return;
    const managerId = child?.parentId;
    if (!child || !managerId) return;
    const manager = this.deps.managers.get(managerId);
    if (!manager || !isPulseEnabled(manager)) return;
    if (!this.isManagerAlive(managerId)) return;
    // A close the manager asked for is not news to it: the wake line is for a child that ended unannounced.
    if (this.deps.sessions.isClosingByParent(childId)) return;
    try {
      this.queueWakeLine(managerId, { label: toSingleLineName(child.name), exitCode });
    } catch (error) {
      log('error', `pulse: could not wake manager ${managerId} after child ${childId} closed`, error);
    }
  }

  private wakeManagerOfRuntimeAttention(childId: string, attention: RuntimeAttention | null): void {
    if (this.isStopped) return;
    if (!attention) {
      this.notifiedRuntimeLaunches.delete(childId);
      return;
    }
    const child = this.deps.sessions.get(childId);
    const parentId = child?.parentId;
    const isCurrentAttention = child?.runtimeAttention?.launchId === attention.launchId;
    if (!isCurrentAttention || !parentId) return;
    const manager = this.deps.managers.get(parentId);
    if (!manager || !isPulseEnabled(manager) || !this.isManagerAlive(parentId)) return;
    const previousAttention = this.notifiedRuntimeLaunches.get(childId);
    const alreadyNotifiesCondition = previousAttention?.launchId === attention.launchId && previousAttention.reason === attention.reason;
    if (alreadyNotifiesCondition) return;
    try {
      this.queueWakeLine(parentId, { label: childId, exitCode: undefined, runtimeAttention: attention });
      this.notifiedRuntimeLaunches.set(childId, attention);
    } catch {
      log('warn', `runtime attention: could not wake manager ${parentId} for child ${childId}`, undefined, { code: 'runtime_attention_notification_failed', sessionId: childId });
    }
  }

  // One queued wake line per manager: a burst of closes grows that line instead of queueing a turn each,
  // so a human message queued behind it waits for one wake turn at most.
  private queueWakeLine(managerId: string, childWakeNotice: ChildWakeNotice): void {
    const queued = this.queuedWakes.get(managerId);
    if (queued) {
      const replacementIndex = queued.listed.findIndex((notice) => notice.label === childWakeNotice.label
        && notice.runtimeAttention?.launchId === childWakeNotice.runtimeAttention?.launchId
        && childWakeNotice.runtimeAttention !== undefined);
      const replacesExistingNotice = replacementIndex >= 0;
      const listed = replacesExistingNotice
        ? queued.listed.map((notice, index) => index === replacementIndex ? childWakeNotice : notice)
        : [...queued.listed, childWakeNotice].slice(0, MAX_LISTED_CHILD_WAKES);
      const total = replacesExistingNotice ? queued.total : queued.total + 1;
      const grown = { messageId: queued.messageId, listed, total };
      const body = wakeLineOf(grown);
      const isMergedIntoQueuedLine = this.deps.sessions.replaceQueuedMessageBody({ sessionId: managerId, messageId: grown.messageId, body });
      if (isMergedIntoQueuedLine) { this.queuedWakes.set(managerId, grown); return; }
    }
    const fresh = { listed: [childWakeNotice], total: 1 };
    const { messageId } = this.deps.sessions.sendMessage({ sessionId: managerId, body: wakeLineOf(fresh) });
    this.queuedWakes.set(managerId, { messageId, ...fresh });
  }

  stop(): void {
    this.isStopped = true;
    this.queuedWakes.clear();
    this.queuedPulses.clear();
    this.managerIdsInFailureStreak.clear();
    this.forcedTickFailuresLeftByManager.clear();
    this.notifiedRuntimeLaunches.clear();
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }

  private arm(record: ManagerRecord): void {
    const delayMs = Math.max(0, new Date(nextPulseAt(record)).getTime() - Date.now());
    this.armAfter(record.sessionId, delayMs);
  }

  private armAfter(sessionId: string, delayMs: number): void {
    this.clearTimer(sessionId);
    const record = this.deps.managers.getWithinBounds(sessionId);
    if (!record) return; // a legacy row is never armed
    if (!isPulseEnabled(record)) return; // a paused manager is never armed
    this.timers.set(sessionId, setTimeout(() => this.tick(sessionId), Math.min(delayMs, MAX_TIMER_DELAY_MS)));
  }

  private tick(sessionId: string): void {
    const record = this.deps.managers.getWithinBounds(sessionId);
    if (!record) return; // manager record removed
    if (!isPulseEnabled(record)) return; // paused since the timer was armed
    if (!this.isManagerAlive(sessionId)) { this.clearTimer(sessionId); return; } // a closed manager never reschedules itself
    if (!this.isManagerIdle(sessionId)) { this.armAfter(sessionId, record.pulseSeconds * 1000); return; } // a busy manager had its turn: no pulse
    // A timer callback has no caller to catch a throw (e.g. a refused SQLite write): left unguarded, it
    // would escape as an uncaught exception and, worse, never re-arm — this manager's cadence would be
    // dead until the next daemon restart. Logged and re-armed instead, so one bad tick doesn't end it.
    try {
      this.throwWhenTickFailureIsForced(sessionId);
      this.fire(record, 'interval');
    } catch (error) {
      this.reportTickFailure(sessionId, error);
      // Re-arms a full cadence from now, never via nextPulseAt(record): fire() threw before persisting
      // lastPulseAt, so record's base is stale — computing off it would land in the past (delayMs 0) and
      // hot-loop the retry every tick instead of waiting out the cadence.
      this.armAfter(sessionId, record.pulseSeconds * 1000);
    }
  }

  private throwWhenTickFailureIsForced(sessionId: string): void {
    const failuresLeft = this.forcedTickFailuresLeftByManager.get(sessionId) ?? 0;
    if (failuresLeft === 0) return;
    this.forcedTickFailuresLeftByManager.set(sessionId, failuresLeft - 1);
    throw new Error('forced pulse tick failure');
  }

  // The first failure of a streak is broadcast (the mapper logs it under the ref the clients receive); the next ones of the
  // same streak only log, so a persistent failure never floods the Inbox. A pulse that goes through ends the streak.
  private reportTickFailure(sessionId: string, error: unknown): void {
    const isNewFailureStreak = !this.managerIdsInFailureStreak.has(sessionId);
    this.managerIdsInFailureStreak.add(sessionId);
    const isAnnounced = isNewFailureStreak && this.announceTickFailure(sessionId, error);
    if (!isAnnounced) log('error', `pulse: manager ${sessionId} tick failed; re-arming instead of losing its cadence`, error);
  }

  private announceTickFailure(sessionId: string, error: unknown): boolean {
    const describe = this.deps.describeError;
    if (!describe) return false;
    try {
      const envelope = describe(error, { sessionId, where: `pulse: manager ${sessionId} tick failed; re-arming instead of losing its cadence` });
      this.deps.bus.emit({ type: 'error', sessionId, scope: 'broadcast', error: envelope });
      return true;
    } catch (announceFailure) {
      log('warn', 'pulse: the error event could not be broadcast', { code: (announceFailure as { code?: string }).code });
      return false;
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
  private fire(record: ManagerRecord, wakeReason: PulseWakeReason): { coalesced: boolean } {
    const coalesced = this.queuePulse(record, wakeReason);
    const pulsedAt = new Date().toISOString();
    this.deps.managers.setLastPulseAt(record.sessionId, pulsedAt);
    const updated: ManagerRecord = { ...record, lastPulseAt: pulsedAt };
    const childrenCount = this.deps.sessions.list().filter((s) => s.parentId === record.sessionId && s.state !== 'closed').length;
    this.deps.bus.emit({ type: 'manager.pulsed', manager: toManagerView(updated, childrenCount, this.deps.deniedCommandCountsOf?.(record.sessionId), this.deps.managerBase) });
    this.arm(updated);
    this.managerIdsInFailureStreak.delete(record.sessionId);
    return { coalesced };
  }

  // Goes through the ordinary message queue, exactly like a message from a parent or sibling: if the manager
  // is mid-turn or waiting on a human, the pulse queues and is flushed on its next idle turn — it never
  // interrupts a running tool or answers a permission prompt. A manager has at most one pulse queued: a
  // pulse still queued takes the new reason (and the current pulse text) in place of a second pulse.
  private queuePulse(record: ManagerRecord, wakeReason: PulseWakeReason): boolean {
    const managerId = record.sessionId;
    const unseenRefusalCount = this.deps.deniedCommandCountsOf?.(managerId).deniedCommandCount ?? 0;
    const pulseText = pulseMessageOf(record, { unseenRefusalCount, managerBase: this.deps.managerBase });
    const queued = this.queuedPulses.get(managerId);
    if (queued) {
      const isSameTextStillQueued = queued.pulseText === pulseText;
      const isReasonAlreadyCarried = queued.wakeReasons.includes(wakeReason);
      const queuedBody = pulseBodyOf({ pulseText: queued.pulseText, wakeReasons: queued.wakeReasons });
      const isQueuedPulseUpToDate = isSameTextStillQueued && isReasonAlreadyCarried && this.deps.sessions.hasQueuedMessage(managerId, queuedBody);
      if (isQueuedPulseUpToDate) return true;
      const wakeReasons = withWakeReason(queued.wakeReasons, wakeReason);
      const body = pulseBodyOf({ pulseText, wakeReasons });
      const isMergedIntoQueuedPulse = this.deps.sessions.replaceQueuedMessageBody({ sessionId: managerId, messageId: queued.messageId, body });
      if (isMergedIntoQueuedPulse) { this.queuedPulses.set(managerId, { messageId: queued.messageId, pulseText, wakeReasons }); return true; }
    }
    const wakeReasons = [wakeReason];
    const { messageId } = this.deps.sessions.sendMessage({ sessionId: managerId, body: pulseBodyOf({ pulseText, wakeReasons }) });
    this.queuedPulses.set(managerId, { messageId, pulseText, wakeReasons });
    return false;
  }

  // A profile edit never re-arms the timer; it only rewrites the text of the pulse still queued, so the manager reads what it wrote last.
  private refreshQueuedPulse(sessionId: string): void {
    if (this.isStopped) return;
    const queued = this.queuedPulses.get(sessionId);
    const record = this.deps.managers.getWithinBounds(sessionId);
    if (!queued || !record) return;
    const unseenRefusalCount = this.deps.deniedCommandCountsOf?.(sessionId).deniedCommandCount ?? 0;
    const pulseText = pulseMessageOf(record, { unseenRefusalCount, managerBase: this.deps.managerBase });
    if (pulseText === queued.pulseText) return;
    const body = pulseBodyOf({ pulseText, wakeReasons: queued.wakeReasons });
    const isRewritten = this.deps.sessions.replaceQueuedMessageBody({ sessionId, messageId: queued.messageId, body });
    if (isRewritten) this.queuedPulses.set(sessionId, { ...queued, pulseText });
  }

  private clearTimer(sessionId: string): void {
    const timer = this.timers.get(sessionId);
    if (timer) clearTimeout(timer);
    this.timers.delete(sessionId);
  }
}
