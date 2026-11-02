import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { SECRET_NAME } from '../playbooks/kernel/secretName.js';
import type { SecretService } from '../secrets/secretService.js';
import { ok } from './toolResults.js';

const MAX_ID_CHARS = 128;

export interface SecretToolDeps {
  secrets: Pick<SecretService, 'statusesOf' | 'clear'>;
}

/**
 * The agent side of the secrets of playbooks: it learns whether a secret is stored and it can clear one. No tool sets a value and none returns one:
 * a value is set by a human in the desktop app and resolved by the daemon for the length of a step.
 */
export function registerSecretTools(server: McpServer, { secrets }: SecretToolDeps): void {
  server.registerTool('list_playbook_secret_statuses', {
    description: 'The secrets a playbook declares, each as "stored" (a value is on this device) or "missing". Never returns a value; a human sets values in the desktop app.',
    inputSchema: { playbook_id: z.string().min(1).max(MAX_ID_CHARS).describe('The playbook whose secrets to list') },
  }, async ({ playbook_id }) => {
    const statuses = secrets.statusesOf({ kind: 'playbook', id: playbook_id }).map(({ name, status }) => ({ name, status }));
    return ok({ playbook_id, statuses });
  });

  server.registerTool('clear_playbook_secret', {
    description: 'Removes the value of one secret of a playbook from this device; clearing a secret that holds no value succeeds. Only a human can set it again, in the desktop app.',
    inputSchema: {
      playbook_id: z.string().min(1).max(MAX_ID_CHARS).describe('The playbook that declares the secret'),
      name: z.string().regex(SECRET_NAME).max(MAX_ID_CHARS).describe('The declared name of the secret'),
    },
  }, async ({ playbook_id, name }) => {
    const { status } = await secrets.clear({ kind: 'playbook', id: playbook_id }, name);
    return ok({ playbook_id, name, status });
  });
}
