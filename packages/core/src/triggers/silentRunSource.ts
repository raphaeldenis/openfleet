import type { Session, TriggerWhen } from '@openfleet/shared';
import type { TranscriptCursor } from '../harness/harness.js';
import { log } from '../logger.js';
import type { ManagerRepository } from '../managers/managerRepository.js';
import type { RuntimeProgress } from '../sessions/sessionRuntime.js';
import type { SessionService } from '../sessions/sessionService.js';
import type { FireLedger } from './fireLedger.js';
import { isChildInScopeOfTrigger } from './sessionTriggerScope.js';
import { CHAIN_CAUSE_WINDOW_MINUTES, type TriggerEngine } from './triggerEngine.js';
import type { TriggerRecord, TriggerRepository } from './triggerRepository.js';

const MINUTE_MS = 60_000;
const MAX_NAME_CHARS = 200;
/** How often a trigger looks at the children it watches. */
export const SILENT_RUN_POLL_MS = 30_000;
/** A poll this long after the previous one means the machine slept: the time that passed is not silence. */
export const SLEEP_GAP_MS = 4 * SILENT_RUN_POLL_MS;
/** What one poll offers to the engine before it leaves the rest of the silent children to the next poll. */
export const MAX_OFFERS_PER_TICK = 20;

type SilentRunWhen = Extract<TriggerWhen, { source: 'silent_run' }>;
type SilentRunTrigger = TriggerRecord & { when: SilentRunWhen };
const isSilentRunTrigger = (trigger: TriggerRecord): trigger is SilentRunTrigger => trigger.when.source === 'silent_run';

/** What a trigger saw of a generating child at the start of its current silence; any later sign of life replaces it. */
interface Observation {
  launchId: string;
  stateSince: string;
  hookSequence: number;
  transcriptCursor: TranscriptCursor | undefined;
  silentSinceMs: number;
  hasBeenOffered: boolean;
}

interface Watch {
  cancelTimer: () => void;
  lastPollAtMs: number;
  observationsBySessionId: Map<string, Observation>;
}

const observationOf = (session: Session, progress: RuntimeProgress, silentSinceMs: number): Observation => ({
  launchId: progress.launchId, stateSince: session.stateSince, hookSequence: progress.hookSequence, transcriptCursor: progress.transcriptCursor, silentSinceMs, hasBeenOffered: false,
});

const hasTranscriptGrown = (before: TranscriptCursor | undefined, now: TranscriptCursor | undefined): boolean =>
  before !== undefined && now !== undefined && now.identity === before.identity && now.offset > before.offset;

/** A sign of life since the observation: a new process, a new turn, a hook of the harness or a transcript that grew. */
function showsSignOfLife(observation: Observation, session: Session, progress: RuntimeProgress): boolean {
  const isAnotherLaunch = progress.launchId !== observation.launchId;
  const isAnotherTurn = session.stateSince !== observation.stateSince;
  const hasHooked = progress.hookSequence > observation.hookSequence;
  return isAnotherLaunch || isAnotherTurn || hasHooked || hasTranscriptGrown(observation.transcriptCursor, progress.transcriptCursor);
}

const silentRunEventOf = (session: Session, minutes: number): Record<string, unknown> =>
  ({ session: { id: session.id, name: session.name.slice(0, MAX_NAME_CHARS), parentId: session.parentId, state: session.state, minutes } });

export interface SilentRunSourceDeps {
  sessions: Pick<SessionService, 'get' | 'list' | 'runtimeProgressOf'>;
  managers: Pick<ManagerRepository, 'get'>;
  triggers: Pick<TriggerRepository, 'listArmed'>;
  engine: Pick<TriggerEngine, 'submit'>;
  ledger: Pick<FireLedger, 'causesOf'>;
  clock: () => number;
  schedule: (callback: () => void, delayMs: number) => () => void;
  /** Called with the trigger id for each silence not offered because the message of that trigger set the child going. */
  onOfferSuppressedByCause: (triggerId: string) => void;
}

/**
 * Offers the engine the children of a manager that are generating and show no sign of life for the minutes of a trigger. A sign of life is what the sleep guard calls strong progress:
 * a hook of the harness, a transcript that grew, a new turn or a new process. The pty output is not one, since a stuck screen keeps redrawing. Each armed trigger has one timer that polls
 * every `SILENT_RUN_POLL_MS`; the silence is counted from the first look that saw the child generating without a sign of life, so a trigger armed on a child that has been working for an hour,
 * and a daemon that boots, wait the whole minutes before they offer it. A poll that comes `SLEEP_GAP_MS` late restarts that count for the children not yet offered: a sleep is not silence.
 * One silence is one episode, `silent_run:<session>:<start of the silence>`, offered once; a sign of life ends it and the next silence is a new episode. Nothing is kept in `trigger_cursors`:
 * a restart resumes every session as a new process, which is a new episode. A child is not offered to the trigger whose message set it going in the hour before its silence began.
 */
export class SilentRunSource {
  private readonly watches = new Map<string, Watch>();

  constructor(private readonly deps: SilentRunSourceDeps) {}

  start(): void {
    for (const trigger of this.armedSilentRunTriggers()) this.guarded(() => this.startWatching(trigger));
  }

  stop(): void {
    for (const triggerId of [...this.watches.keys()]) this.stopWatching(triggerId);
  }

  /** Starts the watch of a trigger that was just armed: its first poll is its first look. */
  startFromNow(trigger: TriggerRecord): void {
    if (isSilentRunTrigger(trigger)) this.guarded(() => this.startWatching(trigger));
  }

  /** Drops the watch of a trigger that is deleted, edited, disarmed or no longer a silent_run trigger. */
  sync(triggerId: string): void {
    const isStillWatched = this.armedSilentRunTriggers().some((trigger) => trigger.id === triggerId);
    if (!isStillWatched) this.stopWatching(triggerId);
  }

  private guarded(work: () => void): void {
    try {
      work();
    } catch (error) {
      log('error', 'the silent_run source failed on a trigger', error);
    }
  }

  private armedSilentRunTriggers(): SilentRunTrigger[] {
    return this.deps.triggers.listArmed().filter(isSilentRunTrigger);
  }

  private startWatching(trigger: SilentRunTrigger): void {
    this.stopWatching(trigger.id);
    this.watches.set(trigger.id, { cancelTimer: () => {}, lastPollAtMs: this.deps.clock(), observationsBySessionId: new Map() });
    this.poll(trigger.id);
  }

  private stopWatching(triggerId: string): void {
    this.watches.get(triggerId)?.cancelTimer();
    this.watches.delete(triggerId);
  }

  /** One poll, then the next timer; the arming is read again after the offers, since an offer may have tripped the breaker. */
  private poll(triggerId: string): void {
    const watch = this.watches.get(triggerId);
    const trigger = this.armedSilentRunTriggers().find((candidate) => candidate.id === triggerId);
    if (watch === undefined || trigger === undefined) return this.stopWatching(triggerId);
    try {
      this.look(trigger, watch);
    } finally {
      this.setTimer(triggerId);
    }
  }

  private setTimer(triggerId: string): void {
    const watch = this.watches.get(triggerId);
    if (watch === undefined) return;
    watch.cancelTimer();
    const isStillArmed = this.armedSilentRunTriggers().some((trigger) => trigger.id === triggerId);
    if (!isStillArmed) return this.stopWatching(triggerId);
    watch.cancelTimer = this.deps.schedule(() => this.guarded(() => this.poll(triggerId)), SILENT_RUN_POLL_MS);
  }

  private look(trigger: SilentRunTrigger, watch: Watch): void {
    const now = this.deps.clock();
    const hasSlept = now - watch.lastPollAtMs > SLEEP_GAP_MS;
    watch.lastPollAtMs = now;
    const silenceLimitMs = trigger.when.minutes * MINUTE_MS;

    const generatingChildren = this.deps.sessions.list().filter((session) => session.state === 'generating' && isChildInScopeOfTrigger(this.deps, trigger, session));
    const generatingIds = new Set(generatingChildren.map((session) => session.id));
    for (const sessionId of watch.observationsBySessionId.keys()) {
      if (!generatingIds.has(sessionId)) watch.observationsBySessionId.delete(sessionId);
    }

    let offersLeft = MAX_OFFERS_PER_TICK;
    for (const session of generatingChildren) {
      const progress = this.deps.sessions.runtimeProgressOf(session.id);
      if (progress === undefined) {
        watch.observationsBySessionId.delete(session.id);
        continue;
      }
      const observation = watch.observationsBySessionId.get(session.id);
      const isFirstLookOrSignOfLife = observation === undefined || showsSignOfLife(observation, session, progress);
      if (isFirstLookOrSignOfLife) {
        watch.observationsBySessionId.set(session.id, observationOf(session, progress, now));
        continue;
      }
      if (observation.hasBeenOffered) continue;
      if (hasSlept) {
        observation.silentSinceMs = now;
        continue;
      }
      const isSilentLongEnough = now - observation.silentSinceMs >= silenceLimitMs;
      if (!isSilentLongEnough) continue;
      if (offersLeft === 0) break;

      observation.hasBeenOffered = true;
      if (this.isSetGoingByTheMessageOf(trigger, session, observation, now)) {
        this.deps.onOfferSuppressedByCause(trigger.id);
        continue;
      }
      offersLeft -= 1;
      this.deps.engine.submit({
        triggerId: trigger.id, dedupKey: `silent_run:${session.id}:${new Date(observation.silentSinceMs).toISOString()}`, event: silentRunEventOf(session, trigger.when.minutes),
      });
    }
  }

  /** True when a fire of this trigger sent a message to the child in the hour before its silence began: the silence is the child's answer to the trigger. */
  private isSetGoingByTheMessageOf(trigger: SilentRunTrigger, session: Session, observation: Observation, now: number): boolean {
    const causes = this.deps.ledger.causesOf({
      sessionIds: [session.id],
      sinceIso: new Date(observation.silentSinceMs - CHAIN_CAUSE_WINDOW_MINUTES * MINUTE_MS).toISOString(),
      untilIso: new Date(now).toISOString(),
    });
    return causes.some((cause) => cause.triggerId === trigger.id);
  }
}
