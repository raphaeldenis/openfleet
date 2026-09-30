import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { Server } from 'node:http';
import { join } from 'node:path';
import { E2E_FLAG_ENV, E2E_FLAG_ON } from '@openfleet/shared';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig, type Config } from './config.js';
import { startDaemon, type Daemon } from './daemon.js';
import { openDatabase } from './db/database.js';
import { ManagerRepository } from './managers/managerRepository.js';
import { PulseScheduler } from './managers/pulseScheduler.js';
import { SessionRepository } from './sessions/sessionRepository.js';
import { SessionService } from './sessions/sessionService.js';
import { createTempDirTracker } from './tempDirTracker.js';

const tempDirs = createTempDirTracker();
let daemon: Daemon | undefined;
let adminToken: string;
let bootedConfig: Config;

async function bootDaemon(configJson?: object, { seedPreviousRun, e2e = true }: { seedPreviousRun?: (config: Config) => void; e2e?: boolean } = {}): Promise<Daemon> {
  const home = tempDirs.make('of-daemon-wiring-');
  if (configJson) writeFileSync(join(home, 'config.json'), JSON.stringify(configJson));
  const config = loadConfig({ OPENFLEET_HOME: home, OPENFLEET_PORT: '0', ...(e2e ? { [E2E_FLAG_ENV]: E2E_FLAG_ON } : {}) });
  seedPreviousRun?.(config);
  bootedConfig = config;
  adminToken = config.adminToken;
  daemon = await startDaemon(config);
  return daemon;
}
afterEach(async () => { vi.restoreAllMocks(); await daemon?.close(); daemon = undefined; tempDirs.removeAll(); });

const api = (path: string, init: RequestInit = {}) => fetch(`${daemon!.server.url}${path}`, { ...init, headers: { 'content-type': 'application/json', authorization: `Bearer ${adminToken}`, ...(init.headers ?? {}) } });
const createSession = async (extra: Record<string, unknown> = {}) => (await (await api('/api/sessions', { method: 'POST', body: JSON.stringify({ directory: '/tmp', name: 'Boss', harness: 'fake', emoji: '🤖', ...extra }) })).json()) as { id: string };
const hookTokenOf = (sessionId: string) => (daemon!.db.prepare('SELECT hook_token FROM sessions WHERE id = ?').get(sessionId) as { hook_token: string }).hook_token;
const postHook = async (sessionId: string, body: Record<string, unknown>) => {
  const response = await fetch(`${daemon!.server.url}/hooks/${hookTokenOf(sessionId)}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ session_id: 'c', ...body }) });
  return response.json() as Promise<{ decision?: string; hookSpecificOutput?: { additionalContext: string } }>;
};

async function firstWsFrame(): Promise<{ workingStateMaxAgeMinutes?: number; managers: { pulseSeconds: number }[] }> {
  const { ticket } = (await (await api('/api/ws-ticket', { method: 'POST' })).json()) as { ticket: string };
  const ws = new WebSocket(`${daemon!.server.url.replace('http', 'ws')}/ws?ticket=${ticket}`);
  const frame = await new Promise<string>((resolve) => ws.addEventListener('message', (message) => resolve(String(message.data)), { once: true }));
  ws.close();
  return JSON.parse(frame);
}

describe('operator gets every daemon feature when the daemon boots from its config', () => {
  it('offers neither the fake harness nor the fake-output route unless the e2e flag is set (AUD-18)', async () => {
    await bootDaemon(undefined, { e2e: false });

    const created = await api('/api/sessions', { method: 'POST', body: JSON.stringify({ directory: '/tmp', name: 'Boss', harness: 'fake', emoji: '🤖' }) });
    const fakeOutput = await api('/api/sessions/any/fake-output', { method: 'POST', body: JSON.stringify({ data: 'x' }) });

    expect(created.ok).toBe(false);
    expect(fakeOutput.status).toBe(404);
  });

  it('refuses the end of a turn that has no working state', async () => {
    await bootDaemon();
    const session = await createSession();
    await postHook(session.id, { hook_event_name: 'UserPromptSubmit' });

    const answer = await postHook(session.id, { hook_event_name: 'Stop' });

    expect(answer.decision).toBe('block');
  });

  it('gives a cleared session its working state back as additional context', async () => {
    await bootDaemon();
    const session = await createSession();

    const answer = await postHook(session.id, { hook_event_name: 'SessionStart', source: 'clear' });

    expect(answer.hookSpecificOutput?.additionalContext).toBeTruthy();
  });

  it('serves the working-state route (a session without state answers no_state, not a missing route)', async () => {
    await bootDaemon();
    const session = await createSession();

    const response = await api(`/api/sessions/${session.id}/working-state`);

    expect((await response.json())).toEqual({ error: 'no_state' });
  });

  it('tells connected clients the working-state max age configured in config.json', async () => {
    await bootDaemon({ workingState: { maxAgeMinutes: 45 } });

    const snapshot = await firstWsFrame();

    expect(snapshot.workingStateMaxAgeMinutes).toBe(45);
  });

  it('gives a manager created without a pulse the configured default heartbeat', async () => {
    await bootDaemon({ managers: { heartbeatDefaultSeconds: 777 } });

    await createSession({ name: 'Lead', manager: { childrenCap: 1, mission: 'x' } });
    const snapshot = await firstWsFrame();

    expect(snapshot.managers[0]?.pulseSeconds).toBe(777);
  });

  it('records a design link typed by the human as a handover and reminds the agent to note it', async () => {
    await bootDaemon();
    const session = await createSession();
    const designLink = 'https://claude.ai/design/abc123XYZ';

    const answer = await postHook(session.id, { hook_event_name: 'UserPromptSubmit', prompt: `Here is the design ${designLink} please build it` });
    const handovers = (await (await api(`/api/sessions/${session.id}/handovers`)).json()) as { kind: string; value: string }[];

    expect(handovers).toEqual([expect.objectContaining({ kind: 'design_link', value: designLink })]);
    expect(answer.hookSpecificOutput?.additionalContext).toContain(`Handover recorded: ${designLink}`);
  });

  it('lets an agent replace its working state through the MCP route', async () => {
    await bootDaemon();
    const session = await createSession();
    const mcpToken = (daemon!.db.prepare('SELECT mcp_token FROM sessions WHERE id = ?').get(session.id) as { mcp_token: string }).mcp_token;
    const client = new Client({ name: 'wiring-test', version: '0.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${daemon!.server.url}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${mcpToken}` } } }));

    await client.callTool({ name: 'update_working_state', arguments: { plan: ['ship the wiring'], todo: [], remaining: [], questions_for_human: [], internal_questions: [], blockers: [] } });
    const stored = (await (await api(`/api/sessions/${session.id}/working-state`)).json()) as { plan?: string[] };
    await client.close();

    expect(stored.plan).toEqual(['ship the wiring']);
  });
});

const seedProject = () => daemon!.db.prepare("INSERT INTO projects (id, name, docs_folder_path, created_at) VALUES ('p1', 'One', NULL, 't0')").run();
const assignProject = (sessionId: string) => daemon!.db.prepare("UPDATE sessions SET project_id = 'p1' WHERE id = ?").run(sessionId);
const mcpTokenOf = (sessionId: string) => (daemon!.db.prepare('SELECT mcp_token FROM sessions WHERE id = ?').get(sessionId) as { mcp_token: string }).mcp_token;
const sessionStateOf = (sessionId: string) => (daemon!.db.prepare('SELECT state FROM sessions WHERE id = ?').get(sessionId) as { state: string }).state;

async function connectMcp(sessionId: string) {
  const client = new Client({ name: 'wiring-test', version: '0.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${daemon!.server.url}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${mcpTokenOf(sessionId)}` } } }));
  return client;
}
async function callMcpTool<T = Record<string, unknown>>(sessionId: string, name: string, args: Record<string, unknown> = {}): Promise<T> {
  const client = await connectMcp(sessionId);
  const result = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: { text: string }[] };
  await client.close();
  const text = result.content[0]!.text;
  if (result.isError) throw new Error(`${name} failed: ${text}`);
  return JSON.parse(text) as T;
}

async function openWsFrames() {
  const { ticket } = (await (await api('/api/ws-ticket', { method: 'POST' })).json()) as { ticket: string };
  const ws = new WebSocket(`${daemon!.server.url.replace('http', 'ws')}/ws?ticket=${ticket}`);
  const frames: { type: string }[] = [];
  ws.addEventListener('message', (message) => frames.push(JSON.parse(String(message.data))));
  await new Promise((resolve) => ws.addEventListener('open', resolve, { once: true }));
  const waitForFrame = (type: string) => vi.waitFor(() => { const frame = frames.find((candidate) => candidate.type === type); if (!frame) throw new Error(`no ${type} frame yet`); return frame; }, { timeout: 2500, interval: 25 });
  return { waitForFrame, close: () => ws.close() };
}

const childDirectoryUnderWorktreesRoot = (name: string) => { const directory = join(bootedConfig.worktreesRoot, name); mkdirSync(directory, { recursive: true }); return directory; };
const createRootSession = async () => { const session = await createSession(); assignProject(session.id); return session; };
const spawnManagerThroughMcp = (parentId: string, { pulseSeconds = 3600 }: { pulseSeconds?: number } = {}) =>
  callMcpTool<{ id: string }>(parentId, 'create_session', { directory: childDirectoryUnderWorktreesRoot('lead'), name: 'Lead', manager: { pulse_seconds: pulseSeconds, children_cap: 2, mission: 'lead the fleet' } });

describe('operator reaches every REST surface of a booted daemon', () => {
  it('lists the projects', async () => {
    await bootDaemon();
    seedProject();

    const page = (await (await api('/api/projects')).json()) as { items: { name: string }[] };

    expect(page.items.map((project) => project.name)).toEqual(['One']);
  });

  it('creates and lists notes (notes, note repository and docs folder are all wired)', async () => {
    await bootDaemon();
    seedProject();

    const created = await api('/api/notes', { method: 'POST', body: JSON.stringify({ projectId: 'p1', title: 'Plan', bodyMd: '# plan' }) });
    const listed = (await (await api('/api/notes?projectId=p1')).json()) as { total: number };

    expect(created.status).toBe(201);
    expect(await created.json()).toMatchObject({ title: 'Plan', docsRelativePath: null });
    expect(listed.total).toBe(1);
  });

  it('creates and lists data stores (data store service and repository are both wired)', async () => {
    await bootDaemon();
    seedProject();

    const created = await api('/api/data-stores', { method: 'POST', body: JSON.stringify({ projectId: 'p1', displayName: 'Inventory' }) });
    const listed = (await (await api('/api/data-stores?projectId=p1')).json()) as { items: { displayName: string }[] };

    expect(created.status).toBe(201);
    expect(listed.items.map((store) => store.displayName)).toEqual(['Inventory']);
  });

  it('serves the model table configured in config.json', async () => {
    await bootDaemon({ models: { haiku: 'claude-haiku-from-config' } });

    const models = (await (await api('/api/models')).json()) as { haiku: string };

    expect(models.haiku).toBe('claude-haiku-from-config');
  });

  it('persists a model change into config.json under the daemon home', async () => {
    await bootDaemon();

    const response = await api('/api/models', { method: 'PUT', body: JSON.stringify({ sonnet: 'claude-sonnet-from-put' }) });

    expect(response.status).toBe(200);
    expect(JSON.parse(readFileSync(join(bootedConfig.home, 'config.json'), 'utf8')).models.sonnet).toBe('claude-sonnet-from-put');
  });

  it('pulses a manager on demand', async () => {
    await bootDaemon();
    const lead = await createSession({ name: 'Lead', manager: { childrenCap: 1, mission: 'x' } });

    const response = await api(`/api/managers/${lead.id}/pulse`, { method: 'POST' });

    expect(response.status).toBe(200);
  });
});

describe('agent reaches every MCP tool family of a booted daemon', () => {
  it('reads and writes notes', async () => {
    await bootDaemon();
    seedProject();
    const session = await createRootSession();

    await callMcpTool(session.id, 'create_note', { title: 'Plan', body_md: '# plan' });
    const listed = await callMcpTool<{ count: number }>(session.id, 'list_notes');

    expect(listed.count).toBe(1);
  });

  it('creates, describes and queries a data store', async () => {
    await bootDaemon();
    seedProject();
    const session = await createRootSession();

    const store = await callMcpTool<{ id: string }>(session.id, 'create_data_store', { display_name: 'Inventory' });
    const described = await callMcpTool<{ displayName: string }>(session.id, 'describe_data_store', { store: store.id });
    const queried = await callMcpTool<{ count: number }>(session.id, 'query_data_store', { store: store.id });

    expect(described.displayName).toBe('Inventory');
    expect(queried.count).toBe(0);
  });

  it('spawns a manager and lets it pulse itself', async () => {
    await bootDaemon();
    const session = await createSession();
    const lead = await spawnManagerThroughMcp(session.id);

    const pulsed = await callMcpTool<{ pulsed: boolean }>(lead.id, 'pulse_now');

    expect(pulsed.pulsed).toBe(true);
  });

  it('resolves a model rung against the configured model table when spawning a child', async () => {
    await bootDaemon({ models: { opus: 'claude-opus-from-config' } });
    const session = await createSession();

    const child = await callMcpTool<{ model: string }>(session.id, 'create_session', { directory: childDirectoryUnderWorktreesRoot('worker'), name: 'Worker', model: 'opus' });

    expect(child.model).toBe('claude-opus-from-config');
  });

  it('shows the pending permission of a child to its parent', async () => {
    await bootDaemon();
    const parent = await createSession();
    const child = await callMcpTool<{ id: string }>(parent.id, 'create_session', { directory: childDirectoryUnderWorktreesRoot('worker'), name: 'Worker' });
    const hookAnswer = postHook(child.id, { hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: {} });

    await vi.waitFor(async () => expect(((await (await api('/api/approvals')).json()) as unknown[]).length).toBe(1));
    const status = await callMcpTool<{ children: { pendingPermission?: { toolName: string } }[] }>(parent.id, 'get_argus_status');
    const [approval] = (await (await api('/api/approvals')).json()) as { id: string }[];
    await api(`/api/approvals/${approval!.id}/decide`, { method: 'POST', body: JSON.stringify({ behavior: 'allow' }) });
    await hookAnswer;

    expect(status.children[0]?.pendingPermission?.toolName).toBe('Bash');
  });
});

describe('manager heartbeat of a booted daemon', () => {
  it('announces a created manager to connected clients', async () => {
    await bootDaemon();
    const frames = await openWsFrames();

    const response = await api('/api/sessions', { method: 'POST', body: JSON.stringify({ directory: '/tmp', name: 'Lead', harness: 'fake', emoji: '🤖', manager: { childrenCap: 1, mission: 'x' } }) });

    expect(response.status).toBeLessThan(300);
    await frames.waitForFrame('manager.created');
    frames.close();
  });

  it('pulses a manager one interval after its session changed state', async () => {
    await bootDaemon();
    const session = await createSession();
    const lead = await spawnManagerThroughMcp(session.id, { pulseSeconds: 1 });
    const frames = await openWsFrames();

    await postHook(lead.id, { hook_event_name: 'SessionStart', source: 'startup' });

    await frames.waitForFrame('manager.pulsed');
    frames.close();
  });
});

const OLD_TIMESTAMP = '2026-01-01T00:00:00.000Z';

type SeededSession = { id: string; state: string; createdAt?: string; parentId?: string; role?: string };
function seedPreviousRun(config: Config, { sessions = [], managerIds = [], pendingApprovalOf }: { sessions?: SeededSession[]; managerIds?: string[]; pendingApprovalOf?: string } = {}): void {
  const db = openDatabase(config.dbPath);
  const sessionRepository = new SessionRepository(db);
  for (const { id, state, createdAt = OLD_TIMESTAMP, parentId, role } of sessions) {
    sessionRepository.insert({ id, name: id, emoji: '🤖', directory: '/tmp', worktree: null, model: null, parent_id: parentId ?? null, role: role ?? null, harness: 'fake',
      state: state as never, state_since: OLD_TIMESTAMP, hook_token: `hook-${id}`, mcp_token: `mcp-${id}`, permission_mode: null, branch: null, created_at: createdAt });
  }
  for (const sessionId of managerIds) new ManagerRepository(db).insert({ sessionId, pulseSeconds: 3600, childrenCap: 2, missionText: 'lead', createdAt: OLD_TIMESTAMP });
  if (pendingApprovalOf) db.prepare("INSERT INTO approvals (id, session_id, tool_name, tool_input_json, status, created_at) VALUES ('old-approval', ?, 'Bash', 'null', 'pending', ?)").run(pendingApprovalOf, OLD_TIMESTAMP);
  db.close();
}

describe('daemon boots over what the previous run left behind', () => {
  it('removes a launch directory no session owns any more', async () => {
    const staleLaunchFile = { path: '' };

    await bootDaemon(undefined, { seedPreviousRun: (config) => {
      const launchDirectory = join(config.sessionsRoot, 'gone-session', 'launch');
      mkdirSync(launchDirectory, { recursive: true });
      staleLaunchFile.path = join(launchDirectory, 'settings.json');
      writeFileSync(staleLaunchFile.path, '{}');
    } });

    expect(existsSync(staleLaunchFile.path)).toBe(false);
  });

  it('resumes a session that was generating when the previous daemon stopped', async () => {
    await bootDaemon(undefined, { seedPreviousRun: (config) => seedPreviousRun(config, { sessions: [{ id: 'was-generating', state: 'generating' }] }) });

    expect(sessionStateOf('was-generating')).toBe('starting');
  });

  it('starts the pulse scheduler once every session is resumed', async () => {
    const start = vi.spyOn(PulseScheduler.prototype, 'start');

    await bootDaemon();

    expect(start).toHaveBeenCalledTimes(1);
  });

  it('expires an approval that was still pending in the previous run', async () => {
    await bootDaemon(undefined, { seedPreviousRun: (config) => seedPreviousRun(config, { sessions: [{ id: 'waiting', state: 'waiting_permission' }], pendingApprovalOf: 'waiting' }) });

    const pending = (await (await api('/api/approvals')).json()) as unknown[];

    expect(pending).toEqual([]);
  });
});

describe('daemon refuses to boot after its server listens', () => {
  const failPulseSchedulerStart = () => vi.spyOn(PulseScheduler.prototype, 'start').mockImplementation(() => { throw new Error('managers table unreadable'); });

  it('rejects with the failure and closes the sessions and the server it started', async () => {
    failPulseSchedulerStart();
    const closeServer = vi.spyOn(Server.prototype, 'close');
    const closeAll = vi.spyOn(SessionService.prototype, 'closeAll');

    await expect(bootDaemon()).rejects.toThrow('managers table unreadable');

    expect(closeAll).toHaveBeenCalledTimes(1);
    expect(closeServer).toHaveBeenCalled();
  });

  it('closes the sessions a resume just relaunched before it refuses', async () => {
    failPulseSchedulerStart();
    const stop = vi.spyOn(PulseScheduler.prototype, 'stop');
    const closeAll = vi.spyOn(SessionService.prototype, 'closeAll');
    const resumeAll = vi.spyOn(SessionService.prototype, 'resumeAll');

    await expect(bootDaemon()).rejects.toThrow();

    const callOrderOf = (spy: { mock: { invocationCallOrder: number[] } }) => spy.mock.invocationCallOrder[0]!;
    expect(callOrderOf(resumeAll)).toBeLessThan(callOrderOf(stop));
    expect(callOrderOf(stop)).toBeLessThan(callOrderOf(closeAll));
  });

  it('still refuses with the original failure when closing throws', async () => {
    failPulseSchedulerStart();
    vi.spyOn(SessionService.prototype, 'closeAll').mockRejectedValue(new Error('close blew up'));

    await expect(bootDaemon()).rejects.toThrow('managers table unreadable');
  });
});

describe('daemon shutdown', () => {
  it('closes every session and stops answering', async () => {
    await bootDaemon();
    const session = await createSession();
    const { url } = daemon!.server;

    await daemon!.close();

    expect(sessionStateOf(session.id)).toBe('closed');
    await expect(fetch(`${url}/health`)).rejects.toThrow();
  });

  it('stops the pulse scheduler, then closes the sessions, then closes the server', async () => {
    await bootDaemon();
    const stop = vi.spyOn(PulseScheduler.prototype, 'stop');
    const closeAll = vi.spyOn(SessionService.prototype, 'closeAll');
    const closeServer = vi.spyOn(Server.prototype, 'close');

    await daemon!.close();

    const firstCallOrderOf = (spy: { mock: { invocationCallOrder: number[] } }) => spy.mock.invocationCallOrder[0]!;
    expect(firstCallOrderOf(stop)).toBeLessThan(firstCallOrderOf(closeAll));
    expect(firstCallOrderOf(closeAll)).toBeLessThan(firstCallOrderOf(closeServer));
  });

  it('wakes no manager for the children that close with it', async () => {
    const CHILD_CREATED_BEFORE_ITS_MANAGER = '2025-12-31T00:00:00.000Z';
    await bootDaemon(undefined, { seedPreviousRun: (config) => seedPreviousRun(config, { managerIds: ['lead'], sessions: [
      { id: 'lead', state: 'idle', role: 'manager' },
      { id: 'worker', state: 'idle', parentId: 'lead', createdAt: CHILD_CREATED_BEFORE_ITS_MANAGER },
    ] }) });

    await daemon!.close();

    const wakes = daemon!.db.prepare("SELECT count(*) AS n FROM message_queue WHERE session_id = 'lead'").get() as { n: number };
    expect(wakes.n).toBe(0);
  });
});
