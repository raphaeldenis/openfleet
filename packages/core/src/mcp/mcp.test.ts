import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startServer } from '../api/server.js';
import { openDatabase } from '../db/database.js';
import { EventBus } from '../events/eventBus.js';
import { ApprovalService } from '../governance/approvalService.js';
import { FakeHarness } from '../harness/fakeHarness.js';
import { ManagerRepository } from '../managers/managerRepository.js';
import { ManagerService } from '../managers/managerService.js';
import { PulseScheduler } from '../managers/pulseScheduler.js';
import { DEFAULT_MODEL_TABLE } from '../models.js';
import { SessionService } from '../sessions/sessionService.js';
import { createMcpHandler } from './mcpServer.js';

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'of-repo-'));
  execFileSync('git', ['init', '-b', 'main'], { cwd: dir });
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '--allow-empty', '-m', 'init'], { cwd: dir });
  return dir;
}

let server: Awaited<ReturnType<typeof startServer>>;
let db: DatabaseSync;
let bus: EventBus;
let sessions: SessionService;
let harness: FakeHarness;
let parentToken: string;
let parentId: string;

beforeEach(async () => {
  db = openDatabase(':memory:');
  bus = new EventBus();
  harness = new FakeHarness();
  sessions = new SessionService({ db, bus, harnesses: [harness], baseUrl: 'http://127.0.0.1:0', worktreesRoot: '/tmp/of-wt' });
  const managerRepo = new ManagerRepository(db);
  const pulseScheduler = new PulseScheduler({ managers: managerRepo, sessions, bus });
  const managers = new ManagerService({ managers: managerRepo, sessions, bus, scheduler: pulseScheduler });
  server = await startServer({ host: '127.0.0.1', port: 0, adminToken: 'admin', sessions, approvals: new ApprovalService({ db, bus }), managers, pulseScheduler, bus, modelTable: DEFAULT_MODEL_TABLE, mcp: createMcpHandler({ sessions }) });
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

  it('rejects the pre-restart mcp bearer once resume has rotated it', async () => {
    const staleToken = parentToken;
    const restartHarness = new FakeHarness();
    const restarted = new SessionService({ db, bus, harnesses: [restartHarness], baseUrl: 'http://127.0.0.1:0', worktreesRoot: '/tmp/of-wt', resumeTimeoutMs: 5000 });
    await restarted.resumeAll();

    await expect(connect(staleToken)).rejects.toThrow();

    await restarted.closeAll();
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

  it('create_worktree rejects a repo_path outside the caller\'s own repository', async () => {
    const ownRepo = makeRepo();
    const foreignRepo = makeRepo();
    const parent = await connect(parentToken);
    text(await parent.callTool({ name: 'create_session', arguments: { directory: ownRepo, name: 'Builder' } }));
    const builderToken = harness.launches[1]!.mcpToken;
    const builder = await connect(builderToken);

    const rejected = await builder.callTool({ name: 'create_worktree', arguments: { repo_path: foreignRepo, branch_name: `task/${randomUUID()}` } });
    expect(rejected.isError).toBe(true);
  });

  it('create_worktree allows a repo_path inside the caller\'s own repository', async () => {
    const ownRepo = makeRepo();
    const parent = await connect(parentToken);
    text(await parent.callTool({ name: 'create_session', arguments: { directory: ownRepo, name: 'Builder' } }));
    const builderToken = harness.launches[1]!.mcpToken;
    const builder = await connect(builderToken);

    const allowed = await builder.callTool({ name: 'create_worktree', arguments: { repo_path: ownRepo, branch_name: `task/${randomUUID()}` } });
    expect(allowed.isError).toBeFalsy();
  });
});
