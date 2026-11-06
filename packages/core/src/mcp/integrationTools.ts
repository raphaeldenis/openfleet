import { OpenFleetError, type IntegrationView, type Session } from '@openfleet/shared';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { IntegrationService } from '../integrations/integrationService.js';
import { ok } from './toolResults.js';

const MAX_ID_CHARS = 128;

/** An integration as an agent reads it: ids, the status of its credential and its typed health. No host, no url, no value. */
export const integrationToolView = (integration: IntegrationView) => ({
  id: integration.id, project_id: integration.projectId, connection_id: integration.connectionId, name: integration.name, provider: integration.provider,
  ...(integration.resource !== undefined && { resource: integration.resource }),
  credential: integration.credential, health: integration.health, ...(integration.checkedAt !== undefined && { checked_at: integration.checkedAt }),
});

const integrationParameter = z.string().min(1).max(MAX_ID_CHARS).describe('The integration id (id in list_integrations)');

export interface IntegrationToolDeps {
  integrations: Pick<IntegrationService, 'list' | 'healthOf' | 'refresh'>;
  caller: Session;
}

/**
 * The agent side of the integrations: read what exists, read the last health, ask for a fresh probe.
 * No tool creates a connection, names a host or a url, sets a credential or returns one: a human does that in the desktop app.
 */
export function registerIntegrationTools(server: McpServer, { integrations, caller }: IntegrationToolDeps): void {
  const projectIdOfCaller = (): string => {
    if (caller.projectId === undefined) throw new OpenFleetError('project_not_found', 'your session belongs to no project.');
    return caller.projectId;
  };

  server.registerTool('list_integrations', {
    description: 'The integrations of your project: id, name, provider, whether its credential is "stored" or "missing" on this device, and its last recorded health (ok, auth_failed, unreachable, rate_limited, or unknown before any refresh). Never returns a credential.',
    inputSchema: {},
  }, async () => ok({ integrations: integrations.list(projectIdOfCaller()).map(integrationToolView) }));

  server.registerTool('get_integration_health', {
    description: 'The last recorded health of one integration and the time it was checked. Reads what the last refresh stored and calls no provider.',
    inputSchema: { integration: integrationParameter },
  }, async ({ integration }) => ok(integrationToolView(integrations.healthOf(projectIdOfCaller(), integration))));

  server.registerTool('refresh_integration', {
    description: 'Asks the provider once whether the credential still works and records the typed result (ok, auth_failed, unreachable, rate_limited). Refused during the cooldown of the previous refresh. The answer of the provider is never returned.',
    inputSchema: { integration: integrationParameter },
  }, async ({ integration }) => ok(integrationToolView(await integrations.refresh(projectIdOfCaller(), integration))));
}
