import type { TriggerRun } from '@openfleet/shared';
import type { ManagerRepository } from '../managers/managerRepository.js';
import type { SessionService } from '../sessions/sessionService.js';
import type { ActionResult, TriggerActions } from './triggerEngine.js';
import type { TriggerFire } from './fireLedger.js';
import type { TriggerRecord } from './triggerRepository.js';

export interface TriggerActionsDeps {
  sessions: Pick<SessionService, 'get' | 'sendMessage'>;
  managers: Pick<ManagerRepository, 'get'>;
}

const completed = (): ActionResult => ({ settlement: 'completed' });
const cancelled = (reason: 'target_unavailable' | 'action_failed'): ActionResult => ({ settlement: 'cancelled', reason });

/** Performs the RUN of a trigger for one fire. A kind not performed yet cancels the fire. */
export function createTriggerActions(deps: TriggerActionsDeps): TriggerActions {
  const { sessions, managers } = deps;

  /** A manager of the project of the trigger that is still open; a trigger never reaches into another project. */
  const openManagerOf = (trigger: TriggerRecord, managerId: string | undefined) => {
    if (managerId === undefined) return undefined;
    const session = sessions.get(managerId);
    const isOpenManagerOfTheProject = session !== undefined && session.state !== 'closed' && session.projectId === trigger.projectId && managers.get(managerId) !== undefined;
    return isOpenManagerOfTheProject ? session : undefined;
  };

  const promptManager = (trigger: TriggerRecord, fire: TriggerFire, run: Extract<TriggerRun, { kind: 'prompt_manager' }>): ActionResult => {
    const manager = openManagerOf(trigger, run.managerId);
    if (manager === undefined) return cancelled('target_unavailable');
    sessions.sendMessage({ sessionId: manager.id, messageId: fire.id, body: run.prompt });
    return completed();
  };

  return {
    perform({ trigger, fire }) {
      const { run } = trigger;
      if (run.kind === 'prompt_manager') return promptManager(trigger, fire, run);
      return cancelled('action_failed');
    },
  };
}
