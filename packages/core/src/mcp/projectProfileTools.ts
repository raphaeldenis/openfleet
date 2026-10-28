import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Session } from '@openfleet/shared';
import { z } from 'zod';
import type { ManagerService } from '../managers/managerService.js';
import type { ProjectProfileBootstrap } from '../managers/projectProfileBootstrap.js';
import type { SessionService } from '../sessions/sessionService.js';
import { ok, refuse } from './toolResults.js';

export interface RegisterProjectProfileToolsDeps {
  projectProfile: ProjectProfileBootstrap;
  managers: Pick<ManagerService, 'get'>;
  sessions: Pick<SessionService, 'get'>;
  caller: Session;
}

export function registerProjectProfileTools(server: McpServer, deps: RegisterProjectProfileToolsDeps): void {
  const { projectProfile, managers, sessions, caller } = deps;

  server.registerTool('bootstrap_project_profile', {
    description: 'Give a manager the skeleton of its project in one transaction: the tables "Manager journal" and "Manager backlog", a mission note linked to the manager, the journal bound as its log table, and one pending resource access request per table. Calling it again changes nothing and returns the same identifiers. It grants nothing, changes no pulse (a paused manager stays paused), spawns no session and creates no playbook, trigger or integration. Without manager_id the target is you',
    inputSchema: { manager_id: z.string().min(1).optional().describe('The manager to equip: yourself, or a manager you spawned. Omit it to equip yourself.') },
  }, async ({ manager_id }) => {
    const targetId = manager_id ?? caller.id;
    const isManager = managers.get(targetId) !== undefined;
    if (!isManager) return refuse('not_a_manager', 'only a manager can be given a project profile');

    const target = sessions.get(targetId);
    const isInLineage = targetId === caller.id || target?.parentId === caller.id;
    if (!target || !isInLineage) return refuse('outside_lineage', 'you can equip yourself or a manager you spawned');
    if (!target.projectId) return refuse('project_not_found', 'this manager has no project');

    const report = projectProfile.bootstrap({ managerId: targetId, managerName: target.name, projectId: target.projectId, author: `${caller.emoji} ${caller.name}` });
    return ok(report);
  });
}
