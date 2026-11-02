import type { ServerEvent, Session, SessionCloseReason } from '@openfleet/shared';
import type { EventBus } from '../events/eventBus.js';
import { log } from '../logger.js';
import type { ManagerRepository } from '../managers/managerRepository.js';
import type { SessionService } from '../sessions/sessionService.js';
import type { TriggerEngine } from './triggerEngine.js';
import type { TriggerRecord, TriggerRepository } from './triggerRepository.js';

const MINUTE_MS = 60_000;
const MAX_NAME_CHARS = 200;
/** The reasons a session closes that are failures; a user closing it or the daemon stopping are not. */
const ERROR_CLOSE_REASONS: readonly SessionCloseReason[] = ['launch_failed', 'resume_timeout', 'conversation_not_found', 'harness_exit'];

type SessionStateTrigger = TriggerRecord & { when: Extract<TriggerRecord['when'], { source: 'session_state' }> };
const isSessionStateTrigger = (trigger: TriggerRecord): trigger is SessionStateTrigger => trigger.when.source === 'session_state';

export interface SessionStateSourceDeps {
  bus: Pick<EventBus, 'subscribe'>;
  sessions: Pick<SessionService, 'get' | 'list'>;
  managers: Pick<ManagerRepository, 'get'>;
  triggers: Pick<TriggerRepository, 'listArmed'>;
  engine: Pick<TriggerEngine, 'submit'>;
  clock: () => number;
  schedule: (callback: () => void, delayMs: number) => () => void;
}

/**
 * Offers the engine the events of the children of a manager: a process that closed on a failure, and a session that stayed idle or on a permission
 * prompt for the minutes of a trigger. The wait is read from `stateSince`, which the database keeps, so a restart loses nothing: the boot
 * fires what came due while the daemon was stopped and re-arms the rest with the time that remains. The ledger keeps a late episode from firing twice.
 */
export class SessionStateSource {
  private readonly cancelByWait = new Map<string, () => void>();
  private unsubscribe: (() => void) | undefined;

  constructor(private readonly deps: SessionStateSourceDeps) {}

  start(): void {
    this.unsubscribe = this.deps.bus.subscribe((event) => this.onEvent(event));
    this.rescan();
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    for (const cancel of this.cancelByWait.values()) cancel();
    this.cancelByWait.clear();
  }

  /** Reads every session against the armed triggers: used at boot and when a trigger is armed. */
  rescan(): void {
    for (const session of this.deps.sessions.list()) this.guarded(() => this.watch(session));
  }

  private guarded(work: () => void): void {
    try {
      work();
    } catch (error) {
      log('error', 'the session_state source failed on a session', error);
    }
  }

  private onEvent(event: ServerEvent): void {
    if (event.type === 'session.state') this.guarded(() => this.onStateChanged(event.sessionId));
    if (event.type === 'session.closed') this.guarded(() => this.onClosed(event.sessionId, event.reason));
  }

  private onStateChanged(sessionId: string): void {
    const session = this.deps.sessions.get(sessionId);
    if (session !== undefined) this.watch(session);
  }

  private onClosed(sessionId: string, reason: SessionCloseReason | undefined): void {
    this.forgetWaitsOf(sessionId);
    const session = this.deps.sessions.get(sessionId);
    const hasFailed = reason !== undefined && ERROR_CLOSE_REASONS.includes(reason);
    if (session === undefined || !hasFailed) return;
    for (const trigger of this.triggersWatching(session, 'closed_with_error')) {
      this.offer(trigger, session, { dedupKey: `closed_with_error:${session.id}:${session.closedAt ?? ''}`, state: 'closed_with_error' });
    }
  }

  /** Starts, or restarts, the waits that apply to the state the session is in now. */
  private watch(session: Session): void {
    this.forgetWaitsOf(session.id);
    const isWaitableState = session.state === 'idle' || session.state === 'waiting_permission';
    if (!isWaitableState) return;
    for (const trigger of this.triggersWatching(session, session.state)) this.waitFor(trigger, session);
  }

  private waitFor(trigger: SessionStateTrigger, session: Session): void {
    const minutes = trigger.when.minutes ?? 0;
    const dueAt = Date.parse(session.stateSince) + minutes * MINUTE_MS;
    const delayMs = dueAt - this.deps.clock();
    const isDue = delayMs <= 0;
    if (isDue) return this.offerEpisode(trigger, session);
    const cancel = this.deps.schedule(() => this.guarded(() => this.offerEpisodeIfUnchanged(trigger, session)), delayMs);
    this.cancelByWait.set(`${trigger.id}|${session.id}`, cancel);
  }

  private offerEpisodeIfUnchanged(trigger: SessionStateTrigger, waiting: Session): void {
    this.cancelByWait.delete(`${trigger.id}|${waiting.id}`);
    const current = this.deps.sessions.get(waiting.id);
    const isSameEpisode = current !== undefined && current.state === waiting.state && current.stateSince === waiting.stateSince;
    if (isSameEpisode) this.offerEpisode(trigger, current);
  }

  private offerEpisode(trigger: SessionStateTrigger, session: Session): void {
    this.offer(trigger, session, { dedupKey: `${session.state}:${session.id}:${session.stateSince}`, state: session.state, minutes: trigger.when.minutes });
  }

  private forgetWaitsOf(sessionId: string): void {
    for (const [key, cancel] of this.cancelByWait) {
      if (!key.endsWith(`|${sessionId}`)) continue;
      cancel();
      this.cancelByWait.delete(key);
    }
  }

  private offer(trigger: SessionStateTrigger, session: Session, input: { dedupKey: string; state: string; minutes?: number }): void {
    const event = { session: { id: session.id, name: session.name.slice(0, MAX_NAME_CHARS), parentId: session.parentId, state: input.state, ...(input.minutes !== undefined && { minutes: input.minutes }) } };
    this.deps.engine.submit({ triggerId: trigger.id, dedupKey: input.dedupKey, event });
  }

  /** The armed triggers that watch `state` for this session: it is a child of a manager of the project, and of the one the RUN names, if it names one. */
  private triggersWatching(session: Session, state: string): SessionStateTrigger[] {
    const managerId = session.parentId;
    const manager = managerId === undefined ? undefined : this.deps.sessions.get(managerId);
    const isChildOfAManager = managerId !== undefined && manager !== undefined && this.deps.managers.get(managerId) !== undefined;
    if (!isChildOfAManager) return [];
    return this.deps.triggers.listArmed().filter(isSessionStateTrigger).filter((trigger) => {
      const isWatchingThisState = trigger.when.state === state;
      const isInProject = trigger.projectId === session.projectId && trigger.projectId === manager.projectId;
      const namesAnotherManager = trigger.run.kind === 'prompt_manager' && trigger.run.managerId !== undefined && trigger.run.managerId !== managerId;
      return isWatchingThisState && isInProject && !namesAnotherManager;
    });
  }
}
