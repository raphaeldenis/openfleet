import { OpenFleetError, type Session, type SessionCloseReason, type TriggerFireReason, type TriggerRun } from '@openfleet/shared';
import { log } from '../logger.js';
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

  const send = (session: Session, message: string, fire: TriggerFire): ActionResult => {
    sessions.sendMessage({ sessionId: session.id, messageId: fire.id, body: message });
    return completed();
  };

  const promptManager = (trigger: TriggerRecord, fire: TriggerFire, batchSize: number, run: RunOf<'prompt_manager'>): ActionResult => {
    const candidateIds = run.managerId === undefined ? sessionIdsOfEvent(fire.event) : [run.managerId];
    const manager = candidateIds.map((id) => sessions.get(id)).find((session) => isOpenSessionOfTheProject(trigger, session) && isManager(session.id));
    if (manager === undefined) return cancelled('target_unavailable');
    return send(manager, triggerMessageOf({ trigger, fire, prompt: run.prompt, batchSize }), fire);
  };

  const promptSession = (trigger: TriggerRecord, fire: TriggerFire, batchSize: number, run: RunOf<'prompt_session'>): ActionResult => {
    const target = sessions.get(run.sessionId);
    if (!isOpenSessionOfTheProject(trigger, target)) return cancelled('target_unavailable');
    return send(target, triggerMessageOf({ trigger, fire, prompt: run.prompt, batchSize }), fire);
  };

  const notify = (trigger: TriggerRecord, fire: TriggerFire): ActionResult => {
    announce({ triggerId: trigger.id, fireId: fire.id });
    return completed();
  };

  const closeSession = (trigger: TriggerRecord, run: RunOf<'close_session'>): ActionResult => {
    const target = sessions.get(run.sessionId);
    const isChildOfAManagerOfTheProject = target !== undefined && target.projectId === trigger.projectId && target.parentId !== undefined && isManager(target.parentId);
    if (!isChildOfAManagerOfTheProject) return cancelled('target_not_eligible');

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
      if (run.kind === 'close_session') return closeSession(trigger, run);
      throw new OpenFleetError('invalid_body', `the RUN kind ${run.kind} is not performed by the engine.`);
    },
  };
}
