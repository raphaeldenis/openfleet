import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { E2E_FLAG_ENV, E2E_FLAG_ON } from '@openfleet/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadConfig, type Config } from '../config.js';
import { startDaemon, type Daemon } from '../daemon.js';
import { FakeHarness, type FakeHandle } from '../harness/fakeHarness.js';
import { makeRepo } from '../git/testRepo.js';
import { childEnvironmentForGit } from '../process/childEnvironment.js';
import { ProjectRepository } from '../projects/projectRepository.js';
import { createTempDirTracker } from '../tempDirTracker.js';
import { PENDING_PERMISSION_INPUT_LIMIT, PENDING_PERMISSION_TRUNCATION_MARKER } from './pendingPermissionView.js';

vi.setConfig({ testTimeout: 30_000 });

const tempDirs = createTempDirTracker();
let daemon: Daemon;
let config: Config;

const adminApi = (path: string, init: RequestInit = {}) => fetch(`${daemon.server.url}${path}`, { ...init, headers: { 'content-type': 'application/json', authorization: `Bearer ${config.adminToken}` } });
const mcpTokenOf = (sessionId: string) => (daemon.db.prepare('SELECT mcp_token FROM sessions WHERE id = ?').get(sessionId) as { mcp_token: string }).mcp_token;
const rawText = (result: unknown) => (result as { content: { text: string }[] }).content[0]!.text;
const fakeHarness = () => daemon.harnesses.find((harness) => harness.id === 'fake') as FakeHarness;
const messagesQueuedFor = (sessionId: string) => (daemon.db.prepare('SELECT body FROM message_queue WHERE session_id = ?').all(sessionId) as { body: string }[]).map((row) => row.body);
const wait = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function eventually<T>(read: () => Promise<T> | T, isReady: (value: T) => boolean): Promise<T> {
  let value = await read();
  for (let attempt = 0; attempt < 400 && !isReady(value); attempt += 1) {
    await wait(40);
    value = await read();
  }
  return value;
}

async function connectAs(sessionId: string): Promise<Client> {
  const client = new Client({ name: 'qe', version: '0.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${daemon.server.url}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${mcpTokenOf(sessionId)}` } } }));
  return client;
}

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd, env: childEnvironmentForGit(process.env), encoding: 'utf8' }).trim();

const worktreeOf = (projectRepository: string, name: string) => {
  const directory = join(config.worktreesRoot, name);
  mkdirSync(config.worktreesRoot, { recursive: true });
  git(projectRepository, 'worktree', 'add', '-b', name, directory);
  return directory;
};

const putUnattendedPolicy = (askBecomesDeny: boolean) => adminApi('/api/command-policy', { method: 'PUT', body: JSON.stringify({ version: 1, unattended: { askBecomesDeny } }) });

interface ManagerAndChild { client: Client; managerId: string; childId: string; handle: FakeHandle }

/** A manager (read through MCP) and its child, whose CLI the fake harness drives through the real PermissionRequest hook. */
async function managerWithChild(): Promise<ManagerAndChild> {
  const projectRepository = makeRepo();
  const created = (await (await adminApi('/api/sessions', { method: 'POST', body: JSON.stringify({ directory: projectRepository, name: 'Root', harness: 'fake', emoji: '🧭' }) })).json()) as { id: string };
  new ProjectRepository(daemon.db).insert({ id: 'p1', name: 'One', docsFolderPath: null, createdAt: 't0' });
  daemon.db.prepare('UPDATE sessions SET project_id = ? WHERE id = ?').run('p1', created.id);
  const root = await connectAs(created.id);
  const lead = JSON.parse(rawText(await root.callTool({ name: 'create_session', arguments: { directory: worktreeOf(projectRepository, 'lead'), name: 'Lead', manager: { pulse_seconds: 3600, children_cap: 2, mission: 'm' } } })));
  const client = await connectAs(lead.id);
  await client.callTool({ name: 'get_manager_base', arguments: {} });
  const child = JSON.parse(rawText(await client.callTool({ name: 'create_session', arguments: { directory: worktreeOf(projectRepository, 'worker'), name: 'Worker' } })));
  const handle = fakeHarness().handles.at(-1)!;
  // The test daemon listens on an ephemeral port, which the launch's hook URL does not carry.
  handle.hookUrl = `${daemon.server.url}${new URL(handle.hookUrl!).pathname}`;
  await fetch(handle.hookUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ session_id: 'c', hook_event_name: 'SessionStart' }) });
  return { client, managerId: lead.id, childId: child.id, handle };
}

const pendingPermissionSeenByManager = async (client: Client) => {
  const statusText = await eventually(async () => rawText(await client.callTool({ name: 'get_argus_status', arguments: {} })), (text) => text.includes('"pendingPermission"'));
  return statusText;
};

const UNATTENDED_SILENT_BLOCK_SECONDS = 3;
let armedSilentBlockTimers: { callback: () => void; delayMs: number }[];

/** Holds every silent block timer instead of running it, so the test raises the block once the approval is pending. */
const holdSilentBlockTimer = (callback: () => void, delayMs: number) => {
  const timer = { callback, delayMs };
  armedSilentBlockTimers.push(timer);
  return () => { armedSilentBlockTimers = armedSilentBlockTimers.filter((armed) => armed !== timer); };
};

const raiseUnattendedSilentBlock = () => {
  const unattendedTimers = armedSilentBlockTimers.filter(({ delayMs }) => delayMs === UNATTENDED_SILENT_BLOCK_SECONDS * 1000);
  expect(unattendedTimers).toHaveLength(1);
  unattendedTimers[0]!.callback();
};

beforeEach(async () => {
  armedSilentBlockTimers = [];
  const home = tempDirs.make('of-qe-pending01-');
  writeFileSync(join(home, 'config.json'), JSON.stringify({ permissions: { unattendedSilentBlockSeconds: UNATTENDED_SILENT_BLOCK_SECONDS } }));
  config = loadConfig({ OPENFLEET_HOME: home, OPENFLEET_PORT: '0', [E2E_FLAG_ENV]: E2E_FLAG_ON });
  daemon = await startDaemon(config, { silentBlocks: { schedule: holdSilentBlockTimer } });
});
afterEach(async () => { await daemon.close(); tempDirs.removeAll(); });

/**
 * The CLI of a child nobody watches opens a prompt (the daemon starts the short wait), then an approval is pending for it:
 * the prompt that raises the silent block is the one the manager must be able to read.
 */
async function requestPermissionOnUnwatchedPrompt(handle: FakeHandle, request: { toolName: string; toolInput: unknown }): Promise<void> {
  await fetch(handle.hookUrl!, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ session_id: 'c', hook_event_name: 'Notification', notification_type: 'permission_prompt' }) });
  const policyUpdate = await putUnattendedPolicy(false);
  expect(policyUpdate.status).toBe(200);
  void handle.requestPermission({ sessionId: 'c', ...request });
}

const SECRET_FORMS: [label: string, command: string, secrets: string[], shownInput: string][] = [
  ['token=<value>', 'curl https://example.test/api?x=1 token=Zx81QmVd7TnWk3Pa', ['Zx81QmVd7TnWk3Pa'], 'curl'],
  ['a long base64 key-shaped string', 'curl -d QjFnS2V5TWF0ZXJpYWxGb3JUZXN0aW5nT25seTEyMzQ1Njc4OTBhYmNkZWY= https://example.test', ['QjFnS2V5TWF0ZXJpYWxGb3JUZXN0aW5nT25seTEyMzQ1Njc4OTBhYmNkZWY'], 'curl'],
  ['--password <value>', 'deploy --user bob --password hunter2', ['hunter2'], 'deploy'],
  ['mysql -p<value>', 'mysql -u root -pSECRETPW42 shop', ['SECRETPW42'], 'mysql'],
  ['Authorization: Bearer <token>', 'curl -H "Authorization: Bearer abcDEF123456xyzQRS" https://example.test', ['abcDEF123456xyzQRS'], 'curl'],
  ['API_KEY=<value>', 'API_KEY=ak_inv_55aa66bb77cc node run.js', ['ak_inv_55aa66bb77cc'], 'API_KEY=***'],
];

describe('QE — the pending permission a manager reads carries a masked, capped input, on a booted daemon', () => {
  it.each(SECRET_FORMS)('shows no trace of %s in get_argus_status, get_session_status and the silent-block message', async (_label, command, secrets, shownInput) => {
    const { client, managerId, childId, handle } = await managerWithChild();
    await requestPermissionOnUnwatchedPrompt(handle, { toolName: 'Bash', toolInput: { command } });

    const argusStatus = await pendingPermissionSeenByManager(client);
    const sessionStatus = rawText(await client.callTool({ name: 'get_session_status', arguments: { session_id: childId } }));
    raiseUnattendedSilentBlock();
    const queued = messagesQueuedFor(managerId);

    const everythingTheManagerReads = JSON.stringify({ argusStatus, sessionStatus, queued });
    for (const secret of secrets) expect(everythingTheManagerReads).not.toContain(secret);
    expect(JSON.parse(argusStatus).children[0].pendingPermission).toMatchObject({ toolName: 'Bash', input: shownInput });
    expect(JSON.parse(sessionStatus).pendingPermission).toMatchObject({ toolName: 'Bash', input: shownInput });
    expect(queued[0]).toContain(`It waits on Bash: ${shownInput}`);
  });

  it('masks a secret held by a named field of a tool without a command, in the statuses and the silent-block message', async () => {
    const { client, managerId, childId, handle } = await managerWithChild();
    await requestPermissionOnUnwatchedPrompt(handle, { toolName: 'mcp__x__login', toolInput: { user: 'bob', password: 'hunter2' } });

    const argusStatus = await pendingPermissionSeenByManager(client);
    const sessionStatus = rawText(await client.callTool({ name: 'get_session_status', arguments: { session_id: childId } }));
    raiseUnattendedSilentBlock();
    const queued = messagesQueuedFor(managerId);

    const everythingTheManagerReads = JSON.stringify({ argusStatus, sessionStatus, queued });
    expect(everythingTheManagerReads).not.toContain('hunter2');
    expect(JSON.parse(argusStatus).children[0].pendingPermission.input).toContain('***');
    expect(queued[0]).toContain('It waits on mcp__x__login:');
  });

  it('sends the generic silent-block message, with no tool and no secret, when the block is raised before the approval is pending', async () => {
    const { client, managerId, handle } = await managerWithChild();
    await fetch(handle.hookUrl!, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ session_id: 'c', hook_event_name: 'Notification', notification_type: 'permission_prompt' }) });
    expect((await putUnattendedPolicy(false)).status).toBe(200);

    raiseUnattendedSilentBlock();
    void handle.requestPermission({ sessionId: 'c', toolName: 'Bash', toolInput: { command: 'deploy --user bob --password hunter2' } });
    await pendingPermissionSeenByManager(client);
    const queued = messagesQueuedFor(managerId);

    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatch(/^\[OpenFleet\] Worker \([^)]+\) has waited more than 3 seconds on a permission prompt nobody can answer\. Look at it, or close and relaunch it\.$/);
    expect(queued[0]).not.toContain('It waits on');
    expect(queued[0]).not.toContain('hunter2');
  });

  it('caps a 5000-character input at the limit with the truncation marker, in both statuses', async () => {
    const { client, childId, handle } = await managerWithChild();
    await requestPermissionOnUnwatchedPrompt(handle, { toolName: 'mcp__scape__create_note', toolInput: { body_md: 'ab '.repeat(1700) } });

    const argusStatus = JSON.parse(await pendingPermissionSeenByManager(client));
    const sessionStatus = JSON.parse(rawText(await client.callTool({ name: 'get_session_status', arguments: { session_id: childId } })));

    for (const input of [argusStatus.children[0].pendingPermission.input, sessionStatus.pendingPermission.input]) {
      expect(input.length).toBeLessThanOrEqual(PENDING_PERMISSION_INPUT_LIMIT + PENDING_PERMISSION_TRUNCATION_MARKER.length);
      expect(input.endsWith(PENDING_PERMISSION_TRUNCATION_MARKER)).toBe(true);
    }
  });

  it('shows a short safe form for a tool without a command', async () => {
    const { client, handle } = await managerWithChild();
    await requestPermissionOnUnwatchedPrompt(handle, { toolName: 'mcp__scape__create_note', toolInput: { title: 'Plan', body_md: 'x' } });

    const argusStatus = JSON.parse(await pendingPermissionSeenByManager(client));

    expect(argusStatus.children[0].pendingPermission).toMatchObject({ toolName: 'mcp__scape__create_note', input: '{"title":"Plan","body_md":"x"}' });
  });

  it('leaves the field out of get_session_status when no approval is pending', async () => {
    const { client, childId } = await managerWithChild();

    const sessionStatus = JSON.parse(rawText(await client.callTool({ name: 'get_session_status', arguments: { session_id: childId } })));

    expect(sessionStatus).not.toHaveProperty('pendingPermission');
  });
});
