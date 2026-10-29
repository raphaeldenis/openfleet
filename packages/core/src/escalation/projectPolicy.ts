import { DEFAULT_ESCALATION_POLICY, type EscalationPolicy } from '@openfleet/shared';
import type { ProjectRepository } from '../projects/projectRepository.js';

/** The escalation setting of a project, or the defaults when the project sets none. */
export const escalationPolicyOf = (projects: Pick<ProjectRepository, 'get'>, projectId: string | undefined): EscalationPolicy =>
  (projectId === undefined ? undefined : projects.get(projectId)?.escalation) ?? DEFAULT_ESCALATION_POLICY;
