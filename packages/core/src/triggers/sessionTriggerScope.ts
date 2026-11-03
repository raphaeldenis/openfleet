import type { Session } from '@openfleet/shared';
import { lineageRootIdOf } from '../managers/lineage.js';
import type { ManagerRepository } from '../managers/managerRepository.js';
import type { SessionService } from '../sessions/sessionService.js';
import type { TriggerRecord } from './triggerRepository.js';

export interface SessionTriggerScopeDeps {
  sessions: Pick<SessionService, 'get'>;
  managers: Pick<ManagerRepository, 'get'>;
}

/** True when the session is a child of a manager of the project of the trigger, of the manager its RUN names if it names one, and of the lineage of its owner if it has one. */
export function isChildInScopeOfTrigger({ sessions, managers }: SessionTriggerScopeDeps, trigger: TriggerRecord, session: Session): boolean {
  const managerId = session.parentId;
  const manager = managerId === undefined ? undefined : sessions.get(managerId);
  const isChildOfAManager = managerId !== undefined && manager !== undefined && managers.get(managerId) !== undefined;
  if (!isChildOfAManager) return false;
  const isInProject = trigger.projectId === session.projectId && trigger.projectId === manager.projectId;
  const namesAnotherManager = trigger.run.kind === 'prompt_manager' && trigger.run.managerId !== undefined && trigger.run.managerId !== managerId;
  const ownerManagerId = trigger.ownerManagerId;
  const isOwnerAnExistingManager = ownerManagerId !== null && sessions.get(ownerManagerId) !== undefined && managers.get(ownerManagerId) !== undefined;
  const isOutsideTheLineageOfTheOwner = ownerManagerId !== null && (!isOwnerAnExistingManager || ownerManagerId !== lineageRootIdOf(sessions, session));
  return isInProject && !namesAnotherManager && !isOutsideTheLineageOfTheOwner;
}
