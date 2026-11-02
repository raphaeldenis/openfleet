import { ToolListSchema, type ToolList } from '@openfleet/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startGovernanceFixture, type GovernanceFixture } from '../governance/governanceQueue.testkit.js';

let fixture: GovernanceFixture;
beforeEach(async () => { fixture = await startGovernanceFixture(); });
afterEach(async () => { await fixture.close(); });

const toolList = async (): Promise<ToolList> => {
  const response = await fixture.api('/api/tools');
  if (response.status !== 200) throw new Error(`GET /api/tools answered ${response.status}`);
  return ToolListSchema.parse(await response.json());
};

describe('GET /api/tools', () => {
  it('lists exactly the tools an MCP client sees, each with a domain and a category', async () => {
    const client = await fixture.connect(fixture.lead.id);
    const seenByClient = (await client.listTools()).tools.map((tool) => tool.name).sort();

    const { items } = await toolList();

    expect(items.map((tool) => tool.name).sort()).toEqual(seenByClient);
    expect(items.every((tool) => tool.domain.length > 0)).toBe(true);
  });

  it('names the category of a read, an addition, a removal and an execution', async () => {
    const { items } = await toolList();
    const categoryOf = (name: string) => items.find((tool) => tool.name === name)?.category;

    expect([categoryOf('list_notes'), categoryOf('create_note'), categoryOf('delete_note'), categoryOf('create_session')])
      .toEqual(['read_only', 'additive', 'destructive', 'execution_external']);
  });

  it('answers 401 without a token, with a wrong token and with the MCP token of a session', async () => {
    const mcpToken = (fixture.db.prepare('SELECT mcp_token FROM sessions WHERE id = ?').get(fixture.lead.id) as { mcp_token: string }).mcp_token;
    const withBearer = (token: string) => fetch(`${fixture.daemon.server.url}/api/tools`, { headers: { authorization: `Bearer ${token}` } });

    const statuses = [
      (await fetch(`${fixture.daemon.server.url}/api/tools`)).status,
      (await withBearer('not-the-admin-token')).status,
      (await withBearer(mcpToken)).status,
    ];

    expect(statuses).toEqual([401, 401, 401]);
  });
});
