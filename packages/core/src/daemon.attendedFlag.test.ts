import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { E2E_FLAG_ENV, E2E_FLAG_ON, type CommandPolicyDocument } from '@openfleet/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from './config.js';
import { startDaemon, type Daemon, type DaemonOptions } from './daemon.js';
import { DEFAULT_COMMAND_POLICY } from './policy/defaultCommandPolicy.js';
import { defaultCommandPolicySettings } from './policy/commandPolicySettings.js';
import { createTempDirTracker } from './tempDirTracker.js';

const tempDirs = createTempDirTracker();
let daemon: Daemon | undefined;
let adminToken: string;
let worktreesRoot: string;
const clients: Client[] = [];

type PolicyMode = CommandPolicyDocument['mode'];

const settingsInMode = (mode: PolicyMode): NonNullable<DaemonOptions['commandPolicy']> => {
  const defaults = defaultCommandPolicySettings();
  return { settings: { document: { ...DEFAULT_COMMAND_POLICY, mode }, unattended: defaults.unattended } };
};

async function bootDaemon(mode: PolicyMode): Promise<Daemon> {
  const home = tempDirs.make('of-attended-');
  const config = loadConfig({ OPENFLEET_HOME: home, OPENFLEET_PORT: '0', [E2E_FLAG_ENV]: E2E_FLAG_ON });
  adminToken = config.adminToken;
  worktreesRoot = config.worktreesRoot;
  mkdirSync(worktreesRoot, { recursive: true });
  daemon = await startDaemon(config, { commandPolicy: settingsInMode(mode), baseNotReadEnforcement: 'warn_only', noteNotReadEnforcement: 'warn_only', claudeConfigPath: join(home, 'harness-config.json'), power: { api: { acquire: () => ({ release: () => {} }) } } });
  return daemon;
}

afterEach(async () => {
  vi.restoreAllMocks();
  for (const client of clients.splice(0)) await client.close();
  await daemon?.close();
  daemon = undefined;
  tempDirs.removeAll();
});

const api = (path: string, init: RequestInit = {}) => fetch(`${daemon!.server.url}${path}`, { ...init, headers: { 'content-type': 'application/json', authorization: `Bearer ${adminToken}`, ...(init.headers ?? {}) } });
const createSessionResponse = (extra: Record<string, unknown>) =>
  api('/api/sessions', { method: 'POST', body: JSON.stringify({ directory: worktreesRoot, name: 'Boss', harness: 'fake', emoji: '🤖', ...extra }) });
const createSession = async (extra: Record<string, unknown> = {}) => (await (await createSessionResponse(extra)).json()) as { id: string; attended?: boolean };
const aManager = { childrenCap: 2, mission: 'Ship the thing' };
const hookTokenOf = (sessionId: string) => (daemon!.db.prepare('SELECT hook_token FROM sessions WHERE id = ?').get(sessionId) as { hook_token: string }).hook_token;
const mcpTokenOf = (sessionId: string) => (daemon!.db.prepare('SELECT mcp_token FROM sessions WHERE id = ?').get(sessionId) as { mcp_token: string }).mcp_token;
const attendedColumnOf = (sessionId: string) => (daemon!.db.prepare('SELECT attended FROM sessions WHERE id = ?').get(sessionId) as { attended: number }).attended;

interface HookAnswer { hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string; decision?: { behavior: string; message?: string } } }
const hook = async (sessionId: string, body: Record<string, unknown>): Promise<HookAnswer> =>
  (await fetch(`${daemon!.server.url}/hooks/${hookTokenOf(sessionId)}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ session_id: 'cli-1', cwd: '/tmp', ...body }) })).json() as Promise<HookAnswer>;
const askUserQuestion = (sessionId: string, hookEventName: 'PreToolUse' | 'PermissionRequest' = 'PreToolUse') =>
  hook(sessionId, { hook_event_name: hookEventName, tool_name: 'AskUserQuestion', tool_input: { questions: [] } });
const journalRows = () => daemon!.db.prepare('SELECT * FROM denied_commands ORDER BY created_at, rowid').all() as Record<string, unknown>[];

async function connectAs(sessionId: string): Promise<Client> {
  const client = new Client({ name: 'attended-flag', version: '1' });
  clients.push(client);
  await client.connect(new StreamableHTTPClientTransport(new URL(`${daemon!.server.url}/mcp`), { requestInit: { headers: { authorization: `Bearer ${mcpTokenOf(sessionId)}` } } }));
  return client;
}

const modes: PolicyMode[] = ['observe', 'enforce'];

describe.each(modes)('a manager created from the desktop in %s mode', (mode) => {
  it('is refused AskUserQuestion when it was not created attended, with a pointer to submit_plan_questions and to the attended re-creation', async () => {
    await bootDaemon(mode);
    const lead = await createSession({ name: 'Lead', manager: aManager });

    const answer = await askUserQuestion(lead.id);

    expect(answer.hookSpecificOutput?.permissionDecision).toBe('deny');
    expect(answer.hookSpecificOutput?.permissionDecisionReason).toContain('submit_plan_questions');
    expect(answer.hookSpecificOutput?.permissionDecisionReason).toMatch(/attended/i);
  });

  it('journals the refused question once, as denied under the ladder rule', async () => {
    await bootDaemon(mode);
    const lead = await createSession({ name: 'Lead', manager: aManager });

    await askUserQuestion(lead.id);

    await vi.waitFor(() => expect(journalRows()).toHaveLength(1));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(journalRows()).toHaveLength(1);
    expect(journalRows()[0]).toMatchObject({ session_id: lead.id, rule_id: 'manager-ask-user-via-ladder', tool_name: 'AskUserQuestion', outcome: 'denied', role: 'manager' });
  });

  it('is refused the permission dialog of AskUserQuestion as well', async () => {
    await bootDaemon(mode);
    const lead = await createSession({ name: 'Lead', manager: aManager });

    const answer = await askUserQuestion(lead.id, 'PermissionRequest');

    expect(answer.hookSpecificOutput?.decision).toMatchObject({ behavior: 'deny', message: expect.stringContaining('submit_plan_questions') });
  });

  it('keeps AskUserQuestion when the human created it attended, and journals the question as observed', async () => {
    await bootDaemon(mode);
    const lead = await createSession({ name: 'Lead', manager: aManager, attended: true });

    const answer = await askUserQuestion(lead.id);

    expect(answer).toEqual({});
    await vi.waitFor(() => expect(journalRows()).toHaveLength(1));
    expect(journalRows()[0]).toMatchObject({ session_id: lead.id, rule_id: 'root-manager-ask-user', outcome: 'observed', role: 'manager' });
  });

  it('refuses a manager that has a parent, whatever the mode, journaling it once', async () => {
    await bootDaemon(mode);
    const lead = await createSession({ name: 'Lead', manager: aManager, attended: true });
    const subLead = await createSession({ name: 'SubLead', parentId: lead.id, manager: aManager });

    const answer = await askUserQuestion(subLead.id);

    expect(answer.hookSpecificOutput?.permissionDecision).toBe('deny');
    await vi.waitFor(() => expect(journalRows()).toHaveLength(1));
    expect(journalRows()[0]).toMatchObject({ session_id: subLead.id, rule_id: 'manager-ask-user-via-ladder', outcome: 'denied' });
  });

  it('leaves a session that is not a manager as it was: a root worker may ask, a child worker may not', async () => {
    await bootDaemon(mode);
    const solo = await createSession({ name: 'Solo' });
    const lead = await createSession({ name: 'Lead', manager: aManager, attended: true });
    const worker = await createSession({ name: 'Worker', parentId: lead.id, role: 'DEV' });

    expect(await askUserQuestion(solo.id)).toEqual({});
    const workerAnswer = await askUserQuestion(worker.id);

    const isRefusedByPolicyOnlyWhenEnforcing = mode === 'enforce';
    expect(workerAnswer.hookSpecificOutput?.permissionDecision === 'deny').toBe(isRefusedByPolicyOnlyWhenEnforcing);
  });
});

describe('creating a session with the attended flag over REST', () => {
  it('stores the flag and shows it read-only in the session view of an attended manager', async () => {
    await bootDaemon('observe');

    const lead = await createSession({ name: 'Lead', manager: aManager, attended: true });

    expect(lead.attended).toBe(true);
    expect(attendedColumnOf(lead.id)).toBe(1);
    const view = (await (await api(`/api/sessions/${lead.id}`)).json()) as { attended?: boolean };
    expect(view.attended).toBe(true);
  });

  it('defaults to not attended and shows no flag', async () => {
    await bootDaemon('observe');

    const lead = await createSession({ name: 'Lead', manager: aManager });

    expect(lead.attended).toBeUndefined();
    expect(attendedColumnOf(lead.id)).toBe(0);
  });

  it.each([
    ['a session that is not a manager', { attended: true }],
    ['a manager that has a parent', { attended: true, manager: aManager, parentId: 'placeholder' }],
  ])('refuses the flag on %s with invalid_body', async (_label, extra) => {
    await bootDaemon('observe');
    const lead = await createSession({ name: 'Lead', manager: aManager, attended: true });
    const body = 'parentId' in extra ? { ...extra, parentId: lead.id } : extra;

    const response = await createSessionResponse(body);

    expect(response.status).toBe(400);
    expect(await response.text()).toContain('invalid_body');
  });

  it('refuses a session token on the creation route', async () => {
    await bootDaemon('observe');
    const lead = await createSession({ name: 'Lead', manager: aManager, attended: true });

    const response = await fetch(`${daemon!.server.url}/api/sessions`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${mcpTokenOf(lead.id)}` },
      body: JSON.stringify({ directory: worktreesRoot, name: 'Child', harness: 'fake', manager: aManager, attended: true }),
    });

    expect(response.status).toBe(401);
  });
});

describe('a manager spawning a child manager through MCP create_session', () => {
  it('can never produce an attended child, even when it passes the flag', async () => {
    await bootDaemon('observe');
    const lead = await createSession({ name: 'Lead', manager: aManager, attended: true });
    const client = await connectAs(lead.id);
    const directory = join(worktreesRoot, `child-${randomUUID()}`);
    mkdirSync(directory);

    const result = await client.callTool({ name: 'create_session', arguments: { directory, name: 'SubLead', attended: true, manager: { children_cap: 1, mission: 'Sub', pulse_seconds: 3600 } } });

    const child = JSON.parse((result as { content: { text: string }[] }).content[0]!.text) as { id: string; attended?: boolean };
    expect(child.attended).toBeUndefined();
    expect(attendedColumnOf(child.id)).toBe(0);
  });
});

describe('the attended flag is fixed at creation', () => {
  it('cannot be flipped through the session or manager REST routes', async () => {
    await bootDaemon('observe');
    const lead = await createSession({ name: 'Lead', manager: aManager });

    await api(`/api/sessions/${lead.id}`, { method: 'PATCH', body: JSON.stringify({ name: 'Renamed', attended: true }) });
    await api(`/api/managers/${lead.id}`, { method: 'PATCH', body: JSON.stringify({ mission: 'Other', attended: true }) });

    expect(attendedColumnOf(lead.id)).toBe(0);
  });

  it('cannot be flipped by a direct database update, in either direction', async () => {
    await bootDaemon('observe');
    const unattended = await createSession({ name: 'Unattended', manager: aManager });
    const attended = await createSession({ name: 'Attended', manager: aManager, attended: true });

    expect(() => daemon!.db.prepare('UPDATE sessions SET attended = 1 WHERE id = ?').run(unattended.id)).toThrow(/attended/);
    expect(() => daemon!.db.prepare('UPDATE sessions SET attended = 0 WHERE id = ?').run(attended.id)).toThrow(/attended/);
    expect(attendedColumnOf(unattended.id)).toBe(0);
    expect(attendedColumnOf(attended.id)).toBe(1);
  });

  it('survives a close and a reopen of the session', async () => {
    await bootDaemon('observe');
    const lead = await createSession({ name: 'Lead', manager: aManager, attended: true });

    await api(`/api/sessions/${lead.id}/close`, { method: 'POST', body: JSON.stringify({}) });
    await api(`/api/sessions/${lead.id}/reopen`, { method: 'POST', body: JSON.stringify({}) });

    expect(attendedColumnOf(lead.id)).toBe(1);
  });
});
