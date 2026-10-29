import type { ServerEvent } from '@openfleet/shared';
import type { EventBus } from '../events/eventBus.js';
import { log } from '../logger.js';
import { CHILD_RESTARTED_PREFIX, CHILD_RESTART_EXHAUSTED_PREFIX, HARNESS_EXITED_PREFIX } from '../sessions/daemonLines.js';
import { EARLY_EXIT_WINDOW_MS, type SessionService } from '../sessions/sessionService.js';
import type { ChildRestartLedger } from './childRestartLedger.js';
import { toSingleLineName } from './singleLineName.js';
import { modeOf, type ManagerRepository } from './managerRepository.js';

/** The wait before each successive restart of a child inside the window; its length is the cap of restarts. */
export const CHILD_RESTART_DELAYS_MS = [5_000, 30_000, 120_000] as const;
export const CHILD_RESTART_WINDOW_MS = 30 * 60_000;

type ChildRestartSessions = Pick<SessionService, 'get' | 'reopen' | 'sendMessage' | 'lastProcessExitOf' | 'setRestartPending' | 'onCloseRequested'>;
type SessionClosedEvent = Extract<ServerEvent, { type: 'session.closed' }>;

export interface ChildAutoRestarterDeps {
  bus: EventBus;
  sessions: ChildRestartSessions;
  managers: Pick<ManagerRepository, 'get'>;
  ledger: Pick<ChildRestartLedger, 'record' | 'countSince'>;
  clock: () => number;
  /** Runs the callback after the delay; the returned function cancels it. */
  schedule: (callback: () => void, delayMs: number) => () => void;
}

/**
 * Restarts a child of a manager that opted in when the child's process crashed on its own, with growing delays and a cap
 * per sliding window, and tells the manager through its message queue, which a manager without pulses reads as well.
 */
export class ChildAutoRestarter {
  private readonly cancelByChildId = new Map<string, () => void>();
  private readonly missedWhileDisabled = new Map<string, Set<string>>();
  private readonly unsubscribe: () => void;

  constructor(private readonly deps: ChildAutoRestarterDeps) {
    const unsubscribeFromBus = deps.bus.subscribe((event) => {
      if (event.type === 'session.closed') this.onSessionClosed(event);
      if (event.type === 'manager.updated') this.onManagerUpdated(event.manager.sessionId);
    });
    const unsubscribeFromCloseRequests = deps.sessions.onCloseRequested((childId) => this.cancelPendingRestart(childId));
    this.unsubscribe = () => { unsubscribeFromBus(); unsubscribeFromCloseRequests(); };
  }

  stop(): void {
    this.unsubscribe();
    for (const [childId, cancel] of this.cancelByChildId) {
      cancel();
      this.deps.sessions.setRestartPending(childId, false);
    }
    this.cancelByChildId.clear();
  }

  private onSessionClosed({ sessionId: childId, reason }: SessionClosedEvent): void {
    const isCrash = reason === 'harness_exit';
    if (isCrash) this.decideRestartOf(childId);
  }

  // A disabled manager gets no restart: the crashes it missed are looked at once, when it is reactivated.
  private onManagerUpdated(managerId: string): void {
    const record = this.deps.managers.get(managerId);
    const missed = this.missedWhileDisabled.get(managerId);
    const isReactivated = record !== undefined && modeOf(record) !== 'disabled' && missed !== undefined;
    if (!isReactivated) return;
    this.missedWhileDisabled.delete(managerId);
    for (const childId of missed) this.decideRestartOf(childId);
  }

  private decideRestartOf(childId: string): void {
    const child = this.deps.sessions.get(childId);
    const managerId = child?.parentId;
    if (!child || !managerId || child.state !== 'closed') return;
    const manager = this.deps.managers.get(managerId);
    const managerOptedIn = manager?.childAutoRestart === true;
    if (!managerOptedIn) return;
    if (this.cancelByChildId.has(childId)) return;
    if (modeOf(manager) === 'disabled') {
      this.rememberMissed(managerId, childId);
      return;
    }

    const label = this.labelOf(child);
    if (this.neverStarted(childId)) {
      this.tell(managerId, `${HARNESS_EXITED_PREFIX} ${label} exited right after launch without any output: it never started, so it is not restarted.`);
      return;
    }
    const restartsInWindow = this.deps.ledger.countSince(childId, new Date(this.deps.clock() - CHILD_RESTART_WINDOW_MS).toISOString());
    const isCapReached = restartsInWindow >= CHILD_RESTART_DELAYS_MS.length;
    if (isCapReached) {
      this.tell(managerId, `${CHILD_RESTART_EXHAUSTED_PREFIX} ${label} crashed again after ${restartsInWindow} restarts in ${CHILD_RESTART_WINDOW_MS / 60_000} minutes: it stays closed.`);
      return;
    }
    const attempt = restartsInWindow + 1;
    this.deps.sessions.setRestartPending(childId, true);
    const cancel = this.deps.schedule(() => this.restart(childId, attempt), CHILD_RESTART_DELAYS_MS[restartsInWindow]!);
    this.cancelByChildId.set(childId, cancel);
  }

  // A process that died inside the early-exit window without a byte on its pty never started: restarting it would only loop.
  private neverStarted(childId: string): boolean {
    const lastExit = this.deps.sessions.lastProcessExitOf(childId);
    if (!lastExit) return false;
    return lastExit.lifetimeMs < EARLY_EXIT_WINDOW_MS && lastExit.outputBytes === 0;
  }

  // A close asked for during the wait is the end of the child: nothing is announced, the one who asked knows.
  private cancelPendingRestart(childId: string): void {
    const cancel = this.cancelByChildId.get(childId);
    if (!cancel) return;
    cancel();
    this.cancelByChildId.delete(childId);
    this.deps.sessions.setRestartPending(childId, false);
  }

  private restart(childId: string, attempt: number): void {
    const isStillPending = this.cancelByChildId.has(childId);
    if (!isStillPending) return;
    this.cancelByChildId.delete(childId);
    this.deps.sessions.setRestartPending(childId, false);
    const child = this.deps.sessions.get(childId);
    const managerId = child?.parentId;
    if (!child || !managerId) return;
    const isStillClosed = child.state === 'closed';
    const manager = this.deps.managers.get(managerId);
    const managerStillOptedIn = manager?.childAutoRestart === true;
    const managerState = this.deps.sessions.get(managerId)?.state;
    const isManagerAlive = managerState !== undefined && managerState !== 'closed';
    if (!isStillClosed || !managerStillOptedIn || !isManagerAlive) return;
    if (modeOf(manager) === 'disabled') {
      this.rememberMissed(managerId, childId);
      return;
    }

    const label = this.labelOf(child);
    this.deps.ledger.record(childId, new Date(this.deps.clock()).toISOString());
    try {
      this.deps.sessions.reopen(childId, { mode: 'resume' });
      this.tell(managerId, `${CHILD_RESTARTED_PREFIX} ${label} was restarted after a crash (restart ${attempt} of ${CHILD_RESTART_DELAYS_MS.length}).`);
    } catch (error) {
      log('warn', `child restart: ${childId} could not be reopened`, error);
      this.tell(managerId, `${HARNESS_EXITED_PREFIX} ${label} crashed and could not be restarted: it stays closed.`);
    }
  }

  private rememberMissed(managerId: string, childId: string): void {
    const missed = this.missedWhileDisabled.get(managerId) ?? new Set<string>();
    missed.add(childId);
    this.missedWhileDisabled.set(managerId, missed);
  }

  private labelOf(child: { id: string; name: string }): string {
    return `"${toSingleLineName(child.name)}" (${child.id})`;
  }

  // The announcement never stops the restart flow: a manager that closed meanwhile has no queue to receive it.
  private tell(managerId: string, body: string): void {
    try {
      this.deps.sessions.sendMessage({ sessionId: managerId, body });
    } catch (error) {
      log('warn', `child restart: manager ${managerId} could not be told`, error);
    }
  }
}
