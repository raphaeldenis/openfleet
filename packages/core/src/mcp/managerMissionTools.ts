import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Session } from '@openfleet/shared';
import { z } from 'zod';
import type { ManagerService } from '../managers/managerService.js';
import type { NoteService } from '../notes/noteService.js';
import { missionDigestOf } from './toolViews.js';
import { ok, refuse } from './toolResults.js';

export interface RegisterManagerMissionToolsDeps {
  managers: ManagerService;
  notes: NoteService;
  caller: Session;
}

export function registerManagerMissionTools(server: McpServer, deps: RegisterManagerMissionToolsDeps): void {
  const { managers, notes, caller } = deps;

  server.registerTool('get_manager_mission', {
    description: 'Read the mission of a manager (managers only, your own). missionText is the stored mission followed by the notes its @-mentions point to, as get_note expands them; missionBytes and missionSha256 are the size in UTF-8 bytes and the sha256 of the stored mission alone, the same two fields get_argus_status gives. Call it when get_argus_status shows a missionSha256 you have not read',
    inputSchema: { manager_id: z.string().min(1).optional().describe('Your own session id. Omit it to read your own mission.') },
  }, async ({ manager_id }) => {
    const record = managers.get(caller.id);
    if (!record) return refuse('not_a_manager', 'only a manager can read a manager mission');

    const asksForAnotherManager = manager_id !== undefined && manager_id !== caller.id;
    if (asksForAnotherManager) return refuse('outside_lineage', 'you can read only your own mission');

    const { missionText } = record;
    const viewerProjectId = caller.projectId;
    const expandedMission = viewerProjectId ? notes.expandText(missionText, { viewerProjectId }) : missionText;
    return ok({ ...missionDigestOf(missionText), missionText: expandedMission });
  });
}
