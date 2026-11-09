import { OpenFleetError, type Session, type SessionCloseReason, type TriggerFireReason, type TriggerRun } from '@openfleet/shared';
import { log } from '../logger.js';
import { lineageRootIdOf } from '../managers/lineage.js';
import type { ManagerRepository } from '../managers/managerRepository.js';
import type { PlaybookRunner } from '../playbooks/playbookRunner.js';
import type { PlaybookService } from '../playbooks/playbookService.js';
import type { SessionService } from '../sessions/sessionService.js';
import type { ActionResult, SettledResult, TriggerActions } from './triggerEngine.js';
import type { TriggerFire } from './fireLedger.js';
import { triggerMessageOf } from './triggerMessage.js';
import type { TriggerRecord } from './triggerRepository.js';

export interface TriggerActionsDeps {
  sessions: Pick<SessionService, 'get' | 'sendMessage' | 'close'>;
  managers: Pick<ManagerRepository, 'get'>;
  playbooks: Pick<PlaybookService, 'getById'>;
  playbookRunner: Pick<PlaybookRunner, 'start'>;
  /** Tells the desktop that a `notify` trigger fired, by ids only. */
  announce: (notice: { triggerId: string; fireId: string }) => void;
  clock: () => number;
}

type RunOf<Kind extends TriggerRun['kind']> = Extract<TriggerRun, { kind: Kind }>;

const MINUTE_MS = 60_000;
/** The reasons a session closes that are failures; the others are a user, a shutdown. */
const ERROR_CLOSE_REASONS: readonly SessionCloseReason[] = ['launch_failed', 'resume_timeout', 'conversation_not_found', 'harness_exit'];

/** The reason a fire is cancelled with, for each refusal of the playbook service or runner; a code not listed is an unexpected failure. */
const FIRE_REASON_OF_REFUSAL: Partial<Record<string, TriggerFireReason>> = {
  playbook_unapproved: 'playbook_unapproved', script_changed: 'playbook_unapproved',
  playbook_not_found: 'playbook_unavailable', playbook_not_runnable: 'playbook_unavailable', secret_not_connected_on_this_device: 'playbook_unavailable',
  invalid_body: 'playbook_inputs_invalid',
  playbook_run_busy: 'playbook_busy', playbook_review_backlog: 'playbook_busy',
};

const completed = (): SettledResult => ({ settlement: 'completed' });
const cancelled = (reason: TriggerFireReason): SettledResult => ({ settlement: 'cancelled', reason });

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

/** Performs the RUN of a trigger for one fire. */
export function createTriggerActions(deps: TriggerActionsDeps): TriggerActions {
  const { sessions, managers, playbooks, playbookRunner, announce, clock } = deps;

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
    const ownerIsGone = trigger.ownerManagerId !== null && ownerId === undefined;
    if (ownerIsGone) return cancelled('target_not_eligible');
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

  /** Starts the run of an approved playbook of the project of the trigger, with the inputs the RUN holds and nothing from the event. */
  const startPlaybookRun = async (trigger: TriggerRecord, run: RunOf<'run_playbook'>): Promise<SettledResult> => {
    try {
      const playbook = playbooks.getById(run.playbookId);
      const isOfAnotherProject = playbook.projectId !== trigger.projectId;
      if (isOfAnotherProject) return cancelled('playbook_unavailable');
      const started = await playbookRunner.start({ playbookId: playbook.id, inputs: run.inputs ?? {}, actorKind: 'admin' });
      return { settlement: 'completed', runId: started.id };
    } catch (error) {
      const reason = error instanceof OpenFleetError ? FIRE_REASON_OF_REFUSAL[error.code] : undefined;
      if (reason !== undefined) return cancelled(reason);
      log('error', `the playbook run of trigger ${trigger.id} failed to start`, error);
      return cancelled('action_failed');
    }
  };

  return {
    perform({ trigger, fire, batchSize }) {
      const { run } = trigger;
      if (run.kind === 'prompt_manager') return promptManager(trigger, fire, batchSize, run);
      if (run.kind === 'prompt_session') return promptSession(trigger, fire, batchSize, run);
      if (run.kind === 'notify') return notify(trigger, fire);
      if (run.kind === 'close_session') return closeSession(trigger, fire, run);
      return { settlement: 'pending', settled: startPlaybookRun(trigger, run) };
    },
  };
}
