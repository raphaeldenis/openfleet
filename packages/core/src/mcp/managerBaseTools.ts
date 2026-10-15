import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Session } from '@openfleet/shared';
import { z } from 'zod';
import type { ManagerBase } from '../managers/managerBase.js';
import type { ManagerService } from '../managers/managerService.js';
import { ok, refuse } from './toolResults.js';

export interface RegisterManagerBaseToolsDeps {
  managerBase: ManagerBase;
  managers: ManagerService;
  caller: Session;
}

export function registerManagerBaseTools(server: McpServer, deps: RegisterManagerBaseToolsDeps): void {
  const { managerBase, managers, caller } = deps;

  server.registerTool('get_manager_base', {
    description: 'Read the manager base, the common rules every manager follows (managers only). Without section it returns the whole body plus the list of sections (id, title, type, bytes). With section (a short id such as "§5") it returns that section alone. The answer always carries the version and the sha of the whole base. Read it whole after every context reset and whenever its version changes',
    inputSchema: { section: z.string().optional().describe('A section id from the list, such as "§5". Omit it to read the whole base.') },
  }, async ({ section }) => {
    const callerIsManager = managers.get(caller.id) !== undefined;
    if (!callerIsManager) return refuse('not_a_manager', 'only a manager can read the manager base');

    const { version, sha, bytes, sections, body } = managerBase;
    const sectionList = sections.map(({ id, title, type, bytes: sectionBytes }) => ({ id, title, type, bytes: sectionBytes }));
    const identity = { version, sha, bytes, sections: sectionList };

    if (section === undefined) return ok({ ...identity, body });

    const requestedSection = sections.find(({ id }) => id === section);
    if (!requestedSection) return refuse('invalid_body', `unknown section "${section}"`, `Valid section ids: ${sections.map(({ id }) => id).join(', ')}.`);
    return ok({ ...identity, body: requestedSection.text });
  });
}
