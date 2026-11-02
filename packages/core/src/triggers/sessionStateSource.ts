import type { ServerEvent, Session, SessionCloseReason } from '@openfleet/shared';
import type { EventBus } from '../events/eventBus.js';
import { log } from '../logger.js';
import { lineageRootIdOf } from '../managers/lineage.js';
import type { ManagerRepository } from '../managers/managerRepository.js';
import type { SessionService } from '../sessions/sessionService.js';
import type { TriggerCursors } from './triggerCursors.js';
import type { TriggerEngine } from './triggerEngine.js';
import type { TriggerRecord, TriggerRepository } from './triggerRepository.js';

const MINUTE_MS = 60_000;
const MAX_NAME_CHARS = 200;
/** The reasons a session closes that are failures; a user closing it or the daemon stopping are not. */
const ERROR_CLOSE_REASONS: readonly SessionCloseReason[] = ['launch_failed', 'resume_timeout', 'conversation_not_found', 'harness_exit'];

type SessionStateTrigger = TriggerRecord & { when: Extract<TriggerRecord['when'], { source: 'session_state' }> };
const isSessionStateTrigger = (trigger: TriggerRecord): trigger is SessionStateTrigger => trigger.when.source === 'session_state';

type WaitableState = 'idle' | 'waiting_permission';
const isWaitableState = (state: string): state is WaitableState => state === 'idle' || state === 'waiting_permission';

/** One stay of a session in a state a trigger waits on, identified by the moment the session entered the state. */
interface Episode { sessionId: string; state: WaitableState; stateSince: string }
const isEpisode = (value: unknown): value is Episode => {
  const candidate = value as Partial<Episode> | null;
  return typeof candidate?.sessionId === 'string' && typeof candidate.state === 'string' && isWaitableState(candidate.state) && typeof candidate.stateSince === 'string';
};
const episodeKeyOf = (episode: Episode) => `${episode.state}:${episode.sessionId}:${episode.stateSince}`;

interface PendingWait { triggerId: string; episode: Episode; cancel: () => void }
interface LateOffer { dedupKey: string; event: Record<string, unknown>; dueAtMs: number }

export interface SessionStateSourceDeps {
  bus: Pick<EventBus, 'subscribe'>;
  sessions: Pick<SessionService, 'get' | 'list'>;
  managers: Pick<ManagerRepository, 'get'>;
  triggers: Pick<TriggerRepository, 'listArmed'>;
  cursors: Pick<TriggerCursors, 'save' | 'takeAll'>;
  engine: Pick<TriggerEngine, 'submit' | 'submitBacklog'>;
  clock: () => number;
  schedule: (callback: () => void, delayMs: number) => () => void;
}

/**
 * Offers the engine the events of the children of a manager: a process that closed on a failure, and a session that stayed idle or on a permission
 * prompt for the minutes of a trigger. The wait is read from `stateSince`. A restart loses nothing: the waits that had not ended are written to the
 * cursors when the source stops, the boot reads them (and the sessions as the database held them before they were resumed, for a daemon that was killed),
 * and what came due while the daemon was stopped is offered with its real deadline, so the backlog policy judges its age. The ledger keeps an episode from firing twice.
 */
export class SessionStateSource {
  private readonly pendingWaits = new Map<string, PendingWait>();
  private unsubscribe: (() => void) | undefined;

  constructor(private readonly deps: SessionStateSourceDeps) {}

  /** `sessionsBeforeResume` are the sessions as the database held them before the boot resumed them: resuming writes a new state time. */
  start(options: { sessionsBeforeResume?: Session[] } = {}): void {
    this.unsubscribe = this.deps.bus.subscribe((event) => this.onEvent(event));
    this.guarded(() => this.offerWhatCameDueWhileStopped(options.sessionsBeforeResume ?? []));
    this.rescan();
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.guarded(() => this.rememberPendingWaits());
    for (const { cancel } of this.pendingWaits.values()) cancel();
    this.pendingWaits.clear();
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
    if (!isWaitableState(session.state)) return;
    for (const trigger of this.triggersWatching(session, session.state)) this.waitFor(trigger, session, session.state);
  }

  private waitFor(trigger: SessionStateTrigger, session: Session, state: WaitableState): void {
    const minutes = trigger.when.minutes ?? 0;
    const dueAt = Date.parse(session.stateSince) + minutes * MINUTE_MS;
    const delayMs = dueAt - this.deps.clock();
    const isDue = delayMs <= 0;
    if (isDue) return this.offerEpisode(trigger, session);
    const cancel = this.deps.schedule(() => this.guarded(() => this.offerEpisodeIfUnchanged(trigger, session)), delayMs);
    this.pendingWaits.set(`${trigger.id}|${session.id}`, { triggerId: trigger.id, episode: { sessionId: session.id, state, stateSince: session.stateSince }, cancel });
  }

  private offerEpisodeIfUnchanged(trigger: SessionStateTrigger, waiting: Session): void {
    this.pendingWaits.delete(`${trigger.id}|${waiting.id}`);
    const current = this.deps.sessions.get(waiting.id);
    const isSameEpisode = current !== undefined && current.state === waiting.state && current.stateSince === waiting.stateSince;
    if (isSameEpisode) this.offerEpisode(trigger, current);
  }

  private offerEpisode(trigger: SessionStateTrigger, session: Session): void {
    this.offer(trigger, session, { dedupKey: `${session.state}:${session.id}:${session.stateSince}`, state: session.state, minutes: trigger.when.minutes });
  }

  private forgetWaitsOf(sessionId: string): void {
    for (const [key, { cancel }] of this.pendingWaits) {
      if (!key.endsWith(`|${sessionId}`)) continue;
      cancel();
      this.pendingWaits.delete(key);
    }
  }

  private offer(trigger: SessionStateTrigger, session: Session, input: { dedupKey: string; state: string; minutes?: number }): void {
    this.deps.engine.submit({ triggerId: trigger.id, dedupKey: input.dedupKey, event: this.eventOf(session, input) });
  }

  private eventOf(session: Session, input: { state: string; minutes?: number }): Record<string, unknown> {
    return { session: { id: session.id, name: session.name.slice(0, MAX_NAME_CHARS), parentId: session.parentId, state: input.state, ...(input.minutes !== undefined && { minutes: input.minutes }) } };
  }

  /** Writes the waits that have not ended to the cursors, one row per trigger, for the next boot. */
  private rememberPendingWaits(): void {
    const armedTriggerIds = new Set(this.deps.triggers.listArmed().map((trigger) => trigger.id));
    const episodesByTrigger = new Map<string, Episode[]>();
    for (const { triggerId, episode } of this.pendingWaits.values()) {
      if (armedTriggerIds.has(triggerId)) episodesByTrigger.set(triggerId, [...(episodesByTrigger.get(triggerId) ?? []), episode]);
    }
    for (const [triggerId, episodes] of episodesByTrigger) this.guarded(() => this.deps.cursors.save(triggerId, { episodes }));
  }

  /** Offers what came due while the daemon was stopped, to each trigger in one batch so its backlog policy sees them together. */
  private offerWhatCameDueWhileStopped(sessionsBeforeResume: Session[]): void {
    const offersByTrigger = new Map<string, LateOffer[]>();
    const addOffer = (trigger: SessionStateTrigger, offer: LateOffer) => offersByTrigger.set(trigger.id, [...(offersByTrigger.get(trigger.id) ?? []), offer]);
    const now = this.deps.clock();

    for (const episode of this.episodesOfTheLastRun(sessionsBeforeResume)) {
      const session = this.deps.sessions.get(episode.sessionId);
      if (session === undefined) continue;
      for (const trigger of this.triggersWatching(session, episode.state)) {
        const minutes = trigger.when.minutes ?? 0;
        const dueAtMs = Date.parse(episode.stateSince) + minutes * MINUTE_MS;
        const hasCameDue = dueAtMs <= now;
        if (hasCameDue) addOffer(trigger, { dedupKey: episodeKeyOf(episode), event: this.eventOf(session, { state: episode.state, minutes: trigger.when.minutes }), dueAtMs });
      }
    }

    for (const session of this.deps.sessions.list()) {
      const closedAt = session.closedAt;
      const hasClosedWithError = session.state === 'closed' && session.closeReason !== undefined && ERROR_CLOSE_REASONS.includes(session.closeReason) && closedAt !== undefined;
      if (!hasClosedWithError) continue;
      for (const trigger of this.triggersWatching(session, 'closed_with_error')) {
        const wasArmedWhenItClosed = trigger.armedAt !== null && Date.parse(closedAt) >= Date.parse(trigger.armedAt);
        if (wasArmedWhenItClosed) addOffer(trigger, { dedupKey: `closed_with_error:${session.id}:${closedAt}`, event: this.eventOf(session, { state: 'closed_with_error' }), dueAtMs: Date.parse(closedAt) });
      }
    }

    for (const [triggerId, offers] of offersByTrigger) this.deps.engine.submitBacklog({ triggerId, offers });
  }

  /** The episodes the previous run was in the middle of: the cursors it wrote when it stopped, and the sessions a killed daemon left in a waitable state. */
  private episodesOfTheLastRun(sessionsBeforeResume: Session[]): Episode[] {
    const fromCursors = this.deps.cursors.takeAll().flatMap(({ value }) => {
      const episodes = (value as { episodes?: unknown })?.episodes;
      return Array.isArray(episodes) ? episodes.filter(isEpisode) : [];
    });
    const fromSessions = sessionsBeforeResume.flatMap((session): Episode[] => (isWaitableState(session.state) ? [{ sessionId: session.id, state: session.state, stateSince: session.stateSince }] : []));
    const byKey = new Map([...fromCursors, ...fromSessions].map((episode) => [episodeKeyOf(episode), episode]));
    return [...byKey.values()];
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
      const isOutsideTheLineageOfTheOwner = trigger.ownerManagerId !== null && trigger.ownerManagerId !== lineageRootIdOf(this.deps.sessions, session);
      return isWatchingThisState && isInProject && !namesAnotherManager && !isOutsideTheLineageOfTheOwner;
    });
  }
}
