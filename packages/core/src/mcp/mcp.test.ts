import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startServer } from '../api/server.js';
import { openDatabase } from '../db/database.js';
import { EventBus } from '../events/eventBus.js';
import { ApprovalService } from '../governance/approvalService.js';
import { FakeHarness } from '../harness/fakeHarness.js';
import { SessionService } from '../sessions/sessionService.js';
import { createMcpHandler } from './mcpServer.js';

let server: Awaited<ReturnType<typeof startServer>>;
let sessions: SessionService;
let harness: FakeHarness;
let parentToken: string;
let parentId: string;

beforeEach(async () => {
  const db = openDatabase(':memory:');
  const bus = new EventBus();
  harness = new FakeHarness();
  sessions = new SessionService({ db, bus, harnesses: [harness], baseUrl: 'http://127.0.0.1:0', worktreesRoot: '/tmp/of-wt' });
  server = await startServer({ host: '127.0.0.1', port: 0, adminToken: 'admin', sessions, approvals: new ApprovalService({ db, bus }), bus, mcp: createMcpHandler({ sessions }) });
  const parent = await sessions.create({ directory: '/tmp', name: 'Lead', harness: 'fake', emoji: '🧭' });
  parentId = parent.id;
  parentToken = harness.launches[0]!.mcpToken;
});
afterEach(() => server.close());

async function connect(token: string) {
  const client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${server.url}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  return client;
}
const text = (r: unknown) => JSON.parse(((r as { content: { text: string }[] }).content[0]!).text);

describe('MCP', () => {
  it('lists the tools', async () => {
    const client = await connect(parentToken);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(['close_session', 'create_session', 'create_worktree', 'get_session_status', 'list_children', 'message_parent', 'send_session_message']);
  });

  it('rejects a bad token', async () => {
    await expect(connect('nope')).rejects.toThrow();
  });

  it('rejects an unauthorized request without reading the body, even when it is huge', async () => {
    const oversizedBody = JSON.stringify({ jsonrpc: '2.0', method: 'x', params: { pad: 'x'.repeat(2 * 1024 * 1024) }, id: 1 });
    const res = await fetch(`${server.url}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer nope' }, body: oversizedBody });
    expect(res.status).toBe(401);
  });

  it('rejects an authorized request body over 1 MiB with 413', async () => {
    const oversizedBody = JSON.stringify({ jsonrpc: '2.0', method: 'x', params: { pad: 'x'.repeat(2 * 1024 * 1024) }, id: 1 });
    const res = await fetch(`${server.url}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${parentToken}` }, body: oversizedBody });
    expect(res.status).toBe(413);
  });

  it('creates a child that inherits harness and can message its parent', async () => {
    const parent = await connect(parentToken);
    const created = text(await parent.callTool({ name: 'create_session', arguments: { directory: '/tmp', name: 'Gimli', emoji: '⚔️' } }));
    expect(created.parentId).toBe(parentId);
    const childToken = harness.launches[1]!.mcpToken;
    const child = await connect(childToken);
    sessions.applyInput(parentId, { kind: 'hook', event: { session_id: 'x', hook_event_name: 'SessionStart' } });
    const sent = text(await child.callTool({ name: 'message_parent', arguments: { body: 'done' } }));
    expect(sent.status).toBe('delivered');
    expect(harness.handles[0]!.written).toEqual(['done\r']);
  });

  it('refuses to message a session outside the caller lineage', async () => {
    const stranger = await sessions.create({ directory: '/tmp', name: 'S', harness: 'fake', emoji: '👤' });
    const parent = await connect(parentToken);
    const result = await parent.callTool({ name: 'send_session_message', arguments: { target_uuid: stranger.id, body: 'hi' } });
    expect(result.isError).toBe(true);
  });
});
