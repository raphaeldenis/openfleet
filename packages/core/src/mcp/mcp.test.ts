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
  sessions = new SessionService({ db, bus, harnesses: [harness], baseUrl: 'http://127.0.0.1:0', worktreesRoot: '/tmp/of-wt', submitKeystrokeDelayMs: 0 });
  const managerRepo = new ManagerRepository(db);
  const pulseScheduler = new PulseScheduler({ managers: managerRepo, sessions, bus });
  const managers = new ManagerService({ managers: managerRepo, sessions, bus, scheduler: pulseScheduler });
  const approvals = new ApprovalService({ db, bus });
  server = await startServer({ host: '127.0.0.1', port: 0, adminToken: 'admin', sessions, approvals, managers, pulseScheduler, bus, modelTable: DEFAULT_MODEL_TABLE, mcp: createMcpHandler({ sessions, approvals, managers, pulseScheduler, modelTable: DEFAULT_MODEL_TABLE, worktreesRoot: '/tmp/of-wt' }) });
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
    expect(tools.map((t) => t.name).sort()).toEqual(['close_session', 'create_session', 'create_worktree', 'get_argus_status', 'get_session_status', 'list_children', 'list_sessions', 'message_parent', 'pulse_now', 'send_session_message', 'update_session']);
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
    const created = text(await parent.callTool({ name: 'create_session', arguments: { directory: '/tmp/of-wt/gimli', name: 'Gimli', emoji: '⚔️' } }));
    expect(created.parentId).toBe(parentId);
    const childToken = harness.launches[1]!.mcpToken;
    const child = await connect(childToken);
    sessions.applyInput(parentId, { kind: 'hook', event: { session_id: 'x', hook_event_name: 'SessionStart' } });
    const sent = text(await child.callTool({ name: 'message_parent', arguments: { body: 'done' } }));
    expect(sent.status).toBe('delivered');
    await new Promise((resolve) => setTimeout(resolve, 0)); // let the (0ms) submit-keystroke timer fire
    expect(harness.handles[0]!.written).toEqual(['done', '\r']);
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
    // Builder's own session directory must itself be ownRepo for create_session's directory-scope
    // guard (Task 7) to admit it — a repo-rooted parent stands in for the caller's own repository.
    const repoParent = await sessions.create({ directory: ownRepo, name: 'RepoLead', harness: 'fake', emoji: '🧭' });
    const repoParentToken = harness.launches.find((l) => l.sessionId === repoParent.id)!.mcpToken;
    const parent = await connect(repoParentToken);
    const launchesBefore = harness.launches.length;
    text(await parent.callTool({ name: 'create_session', arguments: { directory: ownRepo, name: 'Builder' } }));
    const builderToken = harness.launches[launchesBefore]!.mcpToken;
    const builder = await connect(builderToken);

    const rejected = await builder.callTool({ name: 'create_worktree', arguments: { repo_path: foreignRepo, branch_name: `task/${randomUUID()}` } });
    expect(rejected.isError).toBe(true);
  });

  it('create_worktree allows a repo_path inside the caller\'s own repository', async () => {
    const ownRepo = makeRepo();
    const repoParent = await sessions.create({ directory: ownRepo, name: 'RepoLead', harness: 'fake', emoji: '🧭' });
    const repoParentToken = harness.launches.find((l) => l.sessionId === repoParent.id)!.mcpToken;
    const parent = await connect(repoParentToken);
    const launchesBefore = harness.launches.length;
    text(await parent.callTool({ name: 'create_session', arguments: { directory: ownRepo, name: 'Builder' } }));
    const builderToken = harness.launches[launchesBefore]!.mcpToken;
    const builder = await connect(builderToken);

    const allowed = await builder.callTool({ name: 'create_worktree', arguments: { repo_path: ownRepo, branch_name: `task/${randomUUID()}` } });
    expect(allowed.isError).toBeFalsy();
  });
});

describe('create_session guardrails', () => {
  it('rejects a directory outside both the worktrees root and the caller\'s own repository', async () => {
    const client = await connect(parentToken);
    const result = await client.callTool({ name: 'create_session', arguments: { directory: '/etc', name: 'Intruder' } });
    expect(result.isError).toBe(true);
  });

  it('accepts a directory inside the daemon worktrees root', async () => {
    const client = await connect(parentToken);
    const result = await client.callTool({ name: 'create_session', arguments: { directory: '/tmp/of-wt/task-1', name: 'Gimli' } });
    expect(result.isError).toBeFalsy();
  });

  it('accepts a directory inside the caller\'s own git repository', async () => {
    const repoPath = makeRepo();
    sessions.applyInput(parentId, { kind: 'hook', event: { session_id: 'x', hook_event_name: 'SessionStart' } } as never);
    // The caller's own directory must itself be that repo for the "own repository" branch to apply —
    // recreate the parent session there instead of reusing the /tmp fixture from beforeEach.
    const repoParent = await sessions.create({ directory: repoPath, name: 'Lead', harness: 'fake', emoji: '🧭' });
    const repoParentToken = harness.launches.find((l) => l.sessionId === repoParent.id)!.mcpToken;
    const client = await connect(repoParentToken);
    const result = await client.callTool({ name: 'create_session', arguments: { directory: repoPath, name: 'Gimli' } });
    expect(result.isError).toBeFalsy();
  });

  it('defaults permissionMode to manual for an MCP-created child, so its gates reach the inbox', async () => {
    const client = await connect(parentToken);
    const created = text(await client.callTool({ name: 'create_session', arguments: { directory: '/tmp/of-wt/task-2', name: 'Gimli' } }));
    expect(created.permissionMode).toBe('manual');
  });

  it('a plain child cannot create a manager', async () => {
    const parent = await connect(parentToken);
    const created = text(await parent.callTool({ name: 'create_session', arguments: { directory: '/tmp/of-wt/task-3', name: 'Gimli' } }));
    const childToken = harness.launches.find((l) => l.sessionId === created.id)!.mcpToken;
    const child = await connect(childToken);
    const result = await child.callTool({ name: 'create_session', arguments: { directory: '/tmp/of-wt/task-4', name: 'Sub', manager: { pulse_seconds: 60, children_cap: 1, mission: 'x' } } });
    expect(result.isError).toBe(true);
  });

  it('a plain child cannot forge a manager role by setting role directly instead of the manager spec', async () => {
    const parent = await connect(parentToken);
    const midChild = text(await parent.callTool({ name: 'create_session', arguments: { directory: '/tmp/of-wt/mid-child', name: 'Gimli' } }));
    const midChildToken = harness.launches.find((l) => l.sessionId === midChild.id)!.mcpToken;
    const midChildClient = await connect(midChildToken);
    const result = await midChildClient.callTool({ name: 'create_session', arguments: { directory: '/tmp/of-wt/fake-manager', name: 'FakeManager', role: 'manager' } });
    expect(result.isError).toBe(true);
  });

  it('a session with a role of manager but no manager record is still capped when creating children', async () => {
    const parent = await connect(parentToken);
    const midChild = text(await parent.callTool({ name: 'create_session', arguments: { directory: '/tmp/of-wt/mid-child-2', name: 'Gimli' } }));
    const midChildToken = harness.launches.find((l) => l.sessionId === midChild.id)!.mcpToken;
    const midChildClient = await connect(midChildToken);
    const forged = text(await midChildClient.callTool({ name: 'create_session', arguments: { directory: '/tmp/of-wt/fake-manager-2', name: 'FakeManager', role: 'manager' } }));
    const forgedToken = harness.launches.find((l) => l.sessionId === forged.id)!.mcpToken;
    const forgedClient = await connect(forgedToken);
    const kid1 = await forgedClient.callTool({ name: 'create_session', arguments: { directory: '/tmp/of-wt/forged-kid-1', name: 'Kid1' } });
    const kid2 = await forgedClient.callTool({ name: 'create_session', arguments: { directory: '/tmp/of-wt/forged-kid-2', name: 'Kid2' } });
    const kid3 = await forgedClient.callTool({ name: 'create_session', arguments: { directory: '/tmp/of-wt/forged-kid-3', name: 'Kid3' } });
    expect([kid1, kid2, kid3].some((r) => r.isError)).toBe(true);
  });

  it('enforces the caller\'s children cap', async () => {
    const managerClient = await connect(parentToken);
    // parentToken belongs to a plain session in beforeEach — spawn an actual manager to test the cap.
    const lead = text(await managerClient.callTool({ name: 'create_session', arguments: { directory: '/tmp/of-wt/lead', name: 'Lead2', manager: { pulse_seconds: 3600, children_cap: 1, mission: 'x' } } }));
    const leadToken = harness.launches.find((l) => l.sessionId === lead.id)!.mcpToken;
    const leadClient = await connect(leadToken);
    const first = await leadClient.callTool({ name: 'create_session', arguments: { directory: '/tmp/of-wt/lead-child-1', name: 'Child1' } });
    expect(first.isError).toBeFalsy();
    const second = await leadClient.callTool({ name: 'create_session', arguments: { directory: '/tmp/of-wt/lead-child-2', name: 'Child2' } });
    expect(second.isError).toBe(true);
  });

  it('two concurrent create_session calls at the cap admit only one child', async () => {
    const managerClient = await connect(parentToken);
    const lead = text(await managerClient.callTool({ name: 'create_session', arguments: { directory: '/tmp/of-wt/lead3', name: 'Lead3', manager: { pulse_seconds: 3600, children_cap: 1, mission: 'x' } } }));
    const leadToken = harness.launches.find((l) => l.sessionId === lead.id)!.mcpToken;
    const leadClient = await connect(leadToken);
    const [first, second] = await Promise.all([
      leadClient.callTool({ name: 'create_session', arguments: { directory: '/tmp/of-wt/race-1', name: 'RaceA' } }),
      leadClient.callTool({ name: 'create_session', arguments: { directory: '/tmp/of-wt/race-2', name: 'RaceB' } }),
    ]);
    const errors = [first, second].filter((r) => r.isError).length;
    expect(errors).toBe(1);
    expect(sessions.list().filter((s) => s.parentId === lead.id)).toHaveLength(1);
  });
});

describe('update_session', () => {
  it('changes its own model', async () => {
    const client = await connect(parentToken);
    const result = text(await client.callTool({ name: 'update_session', arguments: { model: 'sonnet' } }));
    // The caller is 'starting' in beforeEach (no SessionStart hook applied yet), so the relaunch cannot
    // fire immediately (Amendment A4 item 2: only idle/waiting_input sessions relaunch right away).
    expect(result.status).toBe('deferred');
  });

  it('changes a child\'s model but not an unrelated session\'s', async () => {
    const client = await connect(parentToken);
    const created = text(await client.callTool({ name: 'create_session', arguments: { directory: '/tmp/of-wt/task-5', name: 'Gimli' } }));
    const ownChild = await client.callTool({ name: 'update_session', arguments: { session_id: created.id, model: 'opus' } });
    expect(ownChild.isError).toBeFalsy();

    const stranger = await sessions.create({ directory: '/tmp', name: 'Stranger', harness: 'fake', emoji: '👤' });
    const forbidden = await client.callTool({ name: 'update_session', arguments: { session_id: stranger.id, model: 'opus' } });
    expect(forbidden.isError).toBe(true);
  });
});

describe('get_argus_status, list_sessions, pulse_now', () => {
  it('get_argus_status reports each child\'s state and pending permission', async () => {
    const client = await connect(parentToken);
    const created = text(await client.callTool({ name: 'create_session', arguments: { directory: '/tmp/of-wt/task-6', name: 'Gimli' } }));
    sessions.applyInput(created.id, { kind: 'hook', event: { session_id: 'x', hook_event_name: 'SessionStart' } } as never);
    const status = text(await client.callTool({ name: 'get_argus_status', arguments: {} }));
    expect(status.children).toHaveLength(1);
    expect(status.children[0].id).toBe(created.id);
    expect(status.children[0].state).toBe('idle');
    expect(status.children[0].pendingPermission).toBeUndefined();
  });

  it('list_sessions returns the caller\'s full descendant subtree', async () => {
    const client = await connect(parentToken);
    const child = text(await client.callTool({ name: 'create_session', arguments: { directory: '/tmp/of-wt/task-7', name: 'Gimli' } }));
    const childToken = harness.launches.find((l) => l.sessionId === child.id)!.mcpToken;
    const childClient = await connect(childToken);
    const grandchild = text(await childClient.callTool({ name: 'create_session', arguments: { directory: '/tmp/of-wt/task-8', name: 'Legolas' } }));
    const listed = text(await client.callTool({ name: 'list_sessions', arguments: {} }));
    expect(listed.map((s: { id: string }) => s.id).sort()).toEqual([parentId, child.id, grandchild.id].sort());
  });

  it('pulse_now on a manager delivers the pulse immediately', async () => {
    const managerClient = await connect(parentToken);
    const lead = text(await managerClient.callTool({ name: 'create_session', arguments: { directory: '/tmp/of-wt/lead4', name: 'Lead4', manager: { pulse_seconds: 3600, children_cap: 1, mission: 'x' } } }));
    sessions.applyInput(lead.id, { kind: 'hook', event: { session_id: 'x', hook_event_name: 'SessionStart' } } as never);
    const result = await managerClient.callTool({ name: 'pulse_now', arguments: { session_id: lead.id } });
    expect(result.isError).toBeFalsy();
    const leadHandle = harness.handles.find((_, i) => harness.launches[i]!.sessionId === lead.id)!;
    expect(leadHandle.written.some((w) => w.includes('[pulse]'))).toBe(true);
  });

  it('pulse_now refuses a target outside the caller\'s lineage', async () => {
    const stranger = await sessions.create({ directory: '/tmp', name: 'Stranger', harness: 'fake', emoji: '👤' });
    const client = await connect(parentToken);
    const result = await client.callTool({ name: 'pulse_now', arguments: { session_id: stranger.id } });
    expect(result.isError).toBe(true);
  });
});
