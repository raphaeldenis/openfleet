import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Session } from '@openfleet/shared';
import { z } from 'zod';
import type { ManagerService } from '../managers/managerService.js';
import type { NoteService } from '../notes/noteService.js';
import { boundedReadView, mentionsIndexEntryOf, NOTE_READ_SAFE_BYTES, readLimitBytes } from './noteReadPaging.js';
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
    description: 'Read the mission of a manager (managers only, your own). missionText is the stored mission followed by the notes its @-mentions point to, as get_note expands them; missionBytes and missionSha256 are the size in UTF-8 bytes and the sha256 of the stored mission alone, the same two fields get_argus_status gives. Call it when get_argus_status shows a missionSha256 you have not read. '
      + `A response never exceeds ${NOTE_READ_SAFE_BYTES / 1024} KiB, as for get_note (max_bytes can only lower that): when the mission plus its mentions would, the result holds the stored mission and mentionsIndex ([{id, type, bytes, readWith}]) with complete false, and you read each mention with get_note; when the mission alone would, it is paged with offset (bytes) and the result carries truncated, offset, bytes, totalBytes, nextOffset, nextAction and complete false. A result without complete false is a whole read`,
    inputSchema: {
      manager_id: z.string().min(1).optional().describe('Your own session id. Omit it to read your own mission.'),
      max_bytes: z.number().int().positive().optional(),
      offset: z.number().int().min(0).optional(),
    },
  }, async ({ manager_id, max_bytes, offset }) => {
    const record = managers.get(caller.id);
    if (!record) return refuse('not_a_manager', 'only a manager can read a manager mission');

    const asksForAnotherManager = manager_id !== undefined && manager_id !== caller.id;
    if (asksForAnotherManager) return refuse('outside_lineage', 'you can read only your own mission');

    const { missionText, missionNoteId } = record;
    const header = missionDigestOf(missionText);
    const viewerScope = caller.projectId ? { viewerProjectId: caller.projectId } : undefined;
    const missionNoteSkipReason = `mission note: read it with get_note note=${missionNoteId}`;

    const readFullView = () => {
      const expandedMission = viewerScope
        ? notes.expandText(missionText, { ...viewerScope, rootNoteId: missionNoteId, rootNoteSkipReason: missionNoteSkipReason })
        : missionText;
      return { ...header, missionText: expandedMission };
    };
    const readFraming = () => ({
      header,
      bodyMd: missionText,
      bodyField: 'missionText' as const,
      mentionsIndex: viewerScope ? notes.getTextMentionIndex(missionText, viewerScope).map(mentionsIndexEntryOf) : [],
    });

    return ok(boundedReadView({
      readFullView, readFraming, offset,
      nextPageCall: (nextOffset) => `get_manager_mission offset=${nextOffset}`,
      limitBytes: readLimitBytes(max_bytes),
    }));
  });
}
