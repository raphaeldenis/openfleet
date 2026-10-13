import type { Session } from '@openfleet/shared';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ManagerService } from '../managers/managerService.js';
import { ok, refuse } from './toolResults.js';

export interface RegisterManagerLinkToolsDeps {
  managers: ManagerService;
  caller: Session;
}

export function registerManagerLinkTools(server: McpServer, deps: RegisterManagerLinkToolsDeps): void {
  const { managers, caller } = deps;

  server.registerTool('set_argus_log_store', {
    description: 'Bind the table where you log your actions (managers only). store_id is a table of your own project; the manager dashboard links to it. Rebinding replaces the previous table',
    inputSchema: { store_id: z.string().min(1) },
  }, async ({ store_id }) => {
    const updatedManager = managers.bindLogStore(caller.id, store_id);
    if (!updatedManager) return refuse('not_a_manager', 'only a manager can set its log table');
    return ok({ logStoreId: updatedManager.logStoreId });
  });
}
