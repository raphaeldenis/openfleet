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
  const routesAcceptingABody: [string, string, (sessionId: string) => string, Record<string, unknown>][] = [
    ['PATCH', 'rename a session', (id) => `/api/sessions/${id}`, { name: 'Renamed' }],
    ['PATCH', 'update a manager', (id) => `/api/managers/${id}`, { mission: 'Other' }],
    ['POST', 'send a message', (id) => `/api/sessions/${id}/messages`, { body: 'hello' }],
    ['POST', 'reopen a session', (id) => `/api/sessions/${id}/reopen`, { mode: 'resume' }],
    ['POST', 'change the permission mode', (id) => `/api/sessions/${id}/permission-mode`, { mode: 'default' }],
    ['POST', 'write raw input', (id) => `/api/sessions/${id}/input`, { data: 'x' }],
    ['POST', 'switch the model', (id) => `/api/sessions/${id}/model`, { model: 'sonnet' }],
    ['POST', 'resize the terminal', (id) => `/api/sessions/${id}/resize`, { cols: 80, rows: 24 }],
    ['POST', 'close a session', (id) => `/api/sessions/${id}/close`, {}],
    ['POST', 'write a handoff', (id) => `/api/sessions/${id}/handoff`, {}],
    ['POST', 'fake session output', (id) => `/api/sessions/${id}/fake-output`, { data: 'x' }],
    ['POST', 'fake session exit', (id) => `/api/sessions/${id}/fake-exit`, { code: 0 }],
    ['POST', 'fail next pulses', (id) => `/api/managers/${id}/fail-next-pulses`, { count: 1 }],
  ];
  const flips = [{ requested: true, createdAttended: false }, { requested: false, createdAttended: true }];

  describe.each(routesAcceptingABody)('%s to %s', (method, _label, pathOf, fields) => {
    it.each(flips)('refuses attended=$requested with 400 and leaves the flag untouched', async ({ requested, createdAttended }) => {
      await bootDaemon('observe');
      const lead = await createSession({ name: 'Lead', manager: aManager, ...(createdAttended ? { attended: true } : {}) });
      const flagBefore = attendedColumnOf(lead.id);

      const response = await api(pathOf(lead.id), { method, body: JSON.stringify({ ...fields, attended: requested }) });

      expect(response.status).toBe(400);
      const text = await response.text();
      expect(text).toContain('invalid_body');
      expect(text).toContain('attended is immutable after creation');
      expect(attendedColumnOf(lead.id)).toBe(flagBefore);
    });
  });

  it.each(flips)('refuses a bare attended=$requested patch with the same explicit reason', async ({ requested, createdAttended }) => {
    await bootDaemon('observe');
    const lead = await createSession({ name: 'Lead', manager: aManager, ...(createdAttended ? { attended: true } : {}) });

    const sessionResponse = await api(`/api/sessions/${lead.id}`, { method: 'PATCH', body: JSON.stringify({ attended: requested }) });
    const managerResponse = await api(`/api/managers/${lead.id}`, { method: 'PATCH', body: JSON.stringify({ attended: requested }) });

    for (const response of [sessionResponse, managerResponse]) {
      expect(response.status).toBe(400);
      expect(await response.text()).toContain('attended is immutable after creation');
    }
  });

  it('still applies a normal patch that does not carry attended', async () => {
    await bootDaemon('observe');
    const lead = await createSession({ name: 'Lead', manager: aManager, attended: true });

    const renamed = await api(`/api/sessions/${lead.id}`, { method: 'PATCH', body: JSON.stringify({ name: 'Renamed' }) });
    const updated = await api(`/api/managers/${lead.id}`, { method: 'PATCH', body: JSON.stringify({ mission: 'Other' }) });

    expect(renamed.status).toBe(200);
    expect(((await renamed.json()) as { name: string }).name).toBe('Renamed');
    expect(updated.status).toBe(200);
    expect(attendedColumnOf(lead.id)).toBe(1);
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

describe('the attended refusal at the edges of a request', () => {
  const attendedReason = 'attended is immutable after creation';
  const withAttended = JSON.stringify({ name: 'Renamed', attended: true });

  it.each([
    ['a wrong admin token', { authorization: 'Bearer not-the-admin-token' }],
    ['no admin token', { authorization: '' }],
  ])('answers 401 before the attended refusal with %s', async (_label, headers) => {
    await bootDaemon('observe');
    const lead = await createSession({ name: 'Lead', manager: aManager });

    const response = await api(`/api/sessions/${lead.id}`, { method: 'PATCH', headers, body: withAttended });

    expect(response.status).toBe(401);
    expect(await response.text()).not.toContain(attendedReason);
  });

  it.each([
    ['a null body', 'null'],
    ['an array body', '[{"attended":true}]'],
    ['a non-JSON body', 'attended=true'],
  ])('does not raise the attended refusal for %s', async (_label, rawBody) => {
    await bootDaemon('observe');
    const lead = await createSession({ name: 'Lead', manager: aManager, attended: true });

    const response = await api(`/api/sessions/${lead.id}`, { method: 'PATCH', body: rawBody });

    const isServerError = response.status >= 500;
    expect(isServerError).toBe(false);
    expect(await response.text()).not.toContain(attendedReason);
    expect(attendedColumnOf(lead.id)).toBe(1);
  });

  it.each([
    ['session', (id: string) => `/api/sessions/${id}`],
    ['manager', (id: string) => `/api/managers/${id}`],
  ])('refuses attended with 400 on an unknown %s id, before the handler can answer 404', async (_label, pathOf) => {
    await bootDaemon('observe');

    const response = await api(pathOf(randomUUID()), { method: 'PATCH', body: JSON.stringify({ attended: true }) });

    expect(response.status).toBe(400);
    expect(await response.text()).toContain(attendedReason);
  });

  it('leaves a GET on a prefixed route alone, since it has no body', async () => {
    await bootDaemon('observe');
    const lead = await createSession({ name: 'Lead', manager: aManager, attended: true });

    const response = await api(`/api/sessions/${lead.id}`);

    expect(response.status).toBe(200);
    expect(((await response.json()) as { attended?: boolean }).attended).toBe(true);
  });
});
