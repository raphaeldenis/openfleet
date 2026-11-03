import { OpenFleetError, type Session, type SessionCloseReason, type TriggerFireReason, type TriggerRun } from '@openfleet/shared';
import { log } from '../logger.js';
import { lineageRootIdOf } from '../managers/lineage.js';
import type { ManagerRepository } from '../managers/managerRepository.js';
import type { SessionService } from '../sessions/sessionService.js';
import type { ActionResult, TriggerActions } from './triggerEngine.js';
import type { TriggerFire } from './fireLedger.js';
import { triggerMessageOf } from './triggerMessage.js';
import type { TriggerRecord } from './triggerRepository.js';

export interface TriggerActionsDeps {
  sessions: Pick<SessionService, 'get' | 'sendMessage' | 'close'>;
  managers: Pick<ManagerRepository, 'get'>;
  /** Tells the desktop that a `notify` trigger fired, by ids only. */
  announce: (notice: { triggerId: string; fireId: string }) => void;
  clock: () => number;
}

type RunOf<Kind extends TriggerRun['kind']> = Extract<TriggerRun, { kind: Kind }>;

const MINUTE_MS = 60_000;
/** The reasons a session closes that are failures; the others are a user, a shutdown. */
const ERROR_CLOSE_REASONS: readonly SessionCloseReason[] = ['launch_failed', 'resume_timeout', 'conversation_not_found', 'harness_exit'];

const completed = (): ActionResult => ({ settlement: 'completed' });
const cancelled = (reason: TriggerFireReason): ActionResult => ({ settlement: 'cancelled', reason });

/** The session an event is about, and its parent: the sessions whose manager a trigger may prompt when its RUN names none. */
const sessionIdsOfEvent = (event: Record<string, unknown>): string[] => {
  const { id, parentId } = (event.session ?? {}) as { id?: unknown; parentId?: unknown };
  return [parentId, id].filter((candidate): candidate is string => typeof candidate === 'string');
};

/** Minutes a session must have been idle, when the WHEN of the trigger names them. */
const idleMinutesOf = (trigger: TriggerRecord): number | undefined => {
  const { when } = trigger;
  if (when.source === 'silent_run') return when.minutes;
  return when.source === 'session_state' && when.state === 'idle' ? when.minutes : undefined;
};

/** Performs the RUN of a trigger for one fire. A kind not performed yet cancels the fire. */
export function createTriggerActions(deps: TriggerActionsDeps): TriggerActions {
  const { sessions, managers, announce, clock } = deps;

  const isOpenSessionOfTheProject = (trigger: TriggerRecord, session: Session | undefined): session is Session =>
    session !== undefined && session.state !== 'closed' && session.projectId === trigger.projectId;

  const isManager = (sessionId: string) => managers.get(sessionId) !== undefined;

  const sessionOfEvent = (event: Record<string, unknown>): Session | undefined => {
    const { id } = (event.session ?? {}) as { id?: unknown };
    return typeof id === 'string' ? sessions.get(id) : undefined;
  };

  const isInLineageOf = (ownerId: string, session: Session) => lineageRootIdOf(sessions, session) === ownerId;
  const isChildOfManagerInLineageOf = (ownerId: string, session: Session) => session.parentId !== undefined && isManager(session.parentId) && isInLineageOf(ownerId, session);

  /** The manager that owns the trigger; none when the trigger has no owner or its owner is no longer a manager. */
  const ownerOf = (trigger: TriggerRecord): string | undefined => {
    const { ownerManagerId } = trigger;
    return ownerManagerId !== null && isManager(ownerManagerId) ? ownerManagerId : undefined;
  };

  const send = (session: Session, message: string, fire: TriggerFire): ActionResult => {
    sessions.sendMessage({ sessionId: session.id, messageId: fire.id, body: message });
    return completed();
  };

  const promptManager = (trigger: TriggerRecord, fire: TriggerFire, batchSize: number, run: RunOf<'prompt_manager'>): ActionResult => {
    const ownerId = ownerOf(trigger);
    const sessionIdsOfTheEvent = sessionIdsOfEvent(fire.event);
    const eventIsAboutNoSession = sessionIdsOfTheEvent.length === 0;
    const managerIdsOfTheOwner = eventIsAboutNoSession && ownerId !== undefined ? [ownerId] : [];
    const candidateIds = run.managerId === undefined ? [...sessionIdsOfTheEvent, ...managerIdsOfTheOwner] : [run.managerId];
    const manager = candidateIds.map((id) => sessions.get(id)).find((session) => isOpenSessionOfTheProject(trigger, session) && isManager(session.id));
    if (manager === undefined) return cancelled('target_unavailable');
    const isOutsideTheLineageOfTheOwner = ownerId !== undefined && !isInLineageOf(ownerId, manager);
    if (isOutsideTheLineageOfTheOwner) return cancelled('target_not_eligible');
    return send(manager, triggerMessageOf({ trigger, fire, prompt: run.prompt, batchSize }), fire);
  };

  const promptSession = (trigger: TriggerRecord, fire: TriggerFire, batchSize: number, run: RunOf<'prompt_session'>): ActionResult => {
    const ownerId = ownerOf(trigger);
    if (ownerId === undefined) return cancelled('target_not_eligible');
    const target = sessions.get(run.sessionId);
    if (!isOpenSessionOfTheProject(trigger, target)) return cancelled('target_unavailable');
    if (!isInLineageOf(ownerId, target)) return cancelled('target_not_eligible');
    return send(target, triggerMessageOf({ trigger, fire, prompt: run.prompt, batchSize }), fire);
  };

  const notify = (trigger: TriggerRecord, fire: TriggerFire): ActionResult => {
    announce({ triggerId: trigger.id, fireId: fire.id });
    return completed();
  };

  const closeSession = (trigger: TriggerRecord, fire: TriggerFire, run: RunOf<'close_session'>): ActionResult => {
    const ownerId = ownerOf(trigger);
    if (ownerId === undefined) return cancelled('target_not_eligible');

    const target = sessions.get(run.sessionId);
    const isChildOfTheOwner = target !== undefined && target.projectId === trigger.projectId && isChildOfManagerInLineageOf(ownerId, target);
    if (!isChildOfTheOwner) return cancelled('target_not_eligible');

    const eventSession = sessionOfEvent(fire.event);
    const eventIsAboutAChildOfTheOwner = eventSession !== undefined && isChildOfManagerInLineageOf(ownerId, eventSession);
    if (!eventIsAboutAChildOfTheOwner) return cancelled('target_not_eligible');

    const hasClosedWithError = target.state === 'closed' && target.closeReason !== undefined && ERROR_CLOSE_REASONS.includes(target.closeReason);
    if (hasClosedWithError) return completed();

    const idleMinutes = idleMinutesOf(trigger);
    const idleForMs = clock() - Date.parse(target.stateSince);
    const hasBeenIdleLongEnough = target.state === 'idle' && idleMinutes !== undefined && idleForMs >= idleMinutes * MINUTE_MS;
    if (!hasBeenIdleLongEnough) return cancelled('target_not_eligible');

    sessions.close(target.id, { closedByParent: true }).catch((error: unknown) => log('warn', `trigger ${trigger.id} could not close session ${target.id}`, error));
    return completed();
  };

  return {
    perform({ trigger, fire, batchSize }) {
      const { run } = trigger;
      if (run.kind === 'prompt_manager') return promptManager(trigger, fire, batchSize, run);
      if (run.kind === 'prompt_session') return promptSession(trigger, fire, batchSize, run);
      if (run.kind === 'notify') return notify(trigger, fire);
      if (run.kind === 'close_session') return closeSession(trigger, fire, run);
      throw new OpenFleetError('invalid_body', `the RUN kind ${run.kind} is not performed by the engine.`);
    },
  };
}
