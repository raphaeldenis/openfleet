import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Session } from '@openfleet/shared';
import { describe, expect, it, vi } from 'vitest';
import type { ManagerService } from '../managers/managerService.js';
import type { NoteService } from '../notes/noteService.js';
import { registerManagerMissionTools } from './managerMissionTools.js';

const MISSION = 'Follow @note:some-note';

async function aClientCallingGetManagerMission(callerProjectId: string | undefined) {
  const notes = { expandText: vi.fn(() => 'EXPANDED'), getTextMentionIndex: vi.fn(() => []) };
  const managers = { get: () => ({ missionText: MISSION }) };
  const caller = { id: 'manager-1', projectId: callerProjectId } as Session;
  const server = new McpServer({ name: 'test', version: '0.0.0' });
  registerManagerMissionTools(server, { managers: managers as unknown as ManagerService, notes: notes as unknown as NoteService, caller });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  const answer = await client.callTool({ name: 'get_manager_mission', arguments: {} });
  const { missionText } = JSON.parse((answer as { content: { text: string }[] }).content[0]!.text) as { missionText: string };
  return { missionText, notes };
}

describe('get_manager_mission without a usable project', () => {
  it.each([{ label: 'an empty project id', projectId: '' }, { label: 'no project id', projectId: undefined }])(
    'returns the mission as stored and expands nothing for $label',
    async ({ projectId }) => {
      const { missionText, notes } = await aClientCallingGetManagerMission(projectId);

      expect(missionText).toBe(MISSION);
      expect(notes.expandText).not.toHaveBeenCalled();
    },
  );

  it('expands the mentions for a caller that has a project', async () => {
    const { missionText } = await aClientCallingGetManagerMission('project-1');

    expect(missionText).toBe('EXPANDED');
  });
});
