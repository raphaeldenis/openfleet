import { readFileSync } from 'node:fs';
import { E2E_FLAG_ENV, E2E_FLAG_ON, type CommandPolicyDocument } from '@openfleet/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from './config.js';
import { syntheticToken } from './syntheticTokens.js';
import { startDaemon, type Daemon, type DaemonOptions } from './daemon.js';
import { DEFAULT_COMMAND_POLICY } from './policy/defaultCommandPolicy.js';
import { defaultCommandPolicySettings, type CommandPolicySettings } from './policy/commandPolicySettings.js';
import { createTempDirTracker } from './tempDirTracker.js';

const tempDirs = createTempDirTracker();
let daemon: Daemon | undefined;
let adminToken: string;

const enforcing = (changes: { document?: Partial<CommandPolicyDocument>; unattended?: Partial<CommandPolicySettings['unattended']> } = {}): CommandPolicySettings => {
  const defaults = defaultCommandPolicySettings();
  return { document: { ...DEFAULT_COMMAND_POLICY, mode: 'enforce', ...changes.document }, unattended: { ...defaults.unattended, ...changes.unattended } };
};

async function bootDaemon(commandPolicy?: DaemonOptions['commandPolicy']): Promise<Daemon> {
  const home = tempDirs.make('of-daemon-policy-');
  const config = loadConfig({ OPENFLEET_HOME: home, OPENFLEET_PORT: '0', [E2E_FLAG_ENV]: E2E_FLAG_ON });
  adminToken = config.adminToken;
  daemon = await startDaemon(config, { commandPolicy });
  return daemon;
}
afterEach(async () => { vi.restoreAllMocks(); await daemon?.close(); daemon = undefined; tempDirs.removeAll(); });

const api = (path: string, init: RequestInit = {}) => fetch(`${daemon!.server.url}${path}`, { ...init, headers: { 'content-type': 'application/json', authorization: `Bearer ${adminToken}`, ...(init.headers ?? {}) } });
const createSession = async (extra: Record<string, unknown> = {}) =>
  (await (await api('/api/sessions', { method: 'POST', body: JSON.stringify({ directory: '/tmp', name: 'Boss', harness: 'fake', emoji: '🤖', ...extra }) })).json()) as { id: string };
const createChildOf = (parentId: string, extra: Record<string, unknown> = {}) => createSession({ name: 'Worker', parentId, role: 'DEV', ...extra });
const hookTokenOf = (sessionId: string) => (daemon!.db.prepare('SELECT hook_token FROM sessions WHERE id = ?').get(sessionId) as { hook_token: string }).hook_token;

const postHookRaw = (sessionId: string, body: Record<string, unknown>) =>
  fetch(`${daemon!.server.url}/hooks/${hookTokenOf(sessionId)}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ session_id: 'cli-1', cwd: '/tmp', ...body }) });
const postHook = async (sessionId: string, body: Record<string, unknown>) => (await postHookRaw(sessionId, body)).json() as Promise<HookAnswer>;
const bash = (command: string) => ({ tool_name: 'Bash', tool_input: { command } });
const preToolUse = (sessionId: string, tool: Record<string, unknown>, extra: Record<string, unknown> = {}) => postHook(sessionId, { hook_event_name: 'PreToolUse', ...tool, ...extra });
const permissionRequest = (sessionId: string, tool: Record<string, unknown>, extra: Record<string, unknown> = {}) => postHook(sessionId, { hook_event_name: 'PermissionRequest', ...tool, ...extra });

interface HookAnswer {
  hookSpecificOutput?: { hookEventName: string; permissionDecision?: string; permissionDecisionReason?: string; decision?: { behavior: string; message?: string } };
}

const journalRows = () => daemon!.db.prepare('SELECT * FROM denied_commands ORDER BY created_at, rowid').all() as Record<string, unknown>[];
const pendingApprovals = async () => (await (await api('/api/approvals')).json()) as unknown[];
const messagesQueuedFor = (sessionId: string) => (daemon!.db.prepare('SELECT body FROM message_queue WHERE session_id = ?').all(sessionId) as { body: string }[]);

async function openWsFrames() {
  const { ticket } = (await (await api('/api/ws-ticket', { method: 'POST' })).json()) as { ticket: string };
  const ws = new WebSocket(`${daemon!.server.url.replace('http', 'ws')}/ws?ticket=${ticket}`);
  const frames: { type: string; sessionId?: string; state?: string; denial?: Record<string, unknown> }[] = [];
  ws.addEventListener('message', (message) => frames.push(JSON.parse(String(message.data))));
  await new Promise((resolve) => ws.addEventListener('open', resolve, { once: true }));
  const waitForFrame = (type: string) => vi.waitFor(() => { const frame = frames.find((candidate) => candidate.type === type); if (!frame) throw new Error(`no ${type} frame yet`); return frame; }, { timeout: 2500, interval: 25 });
  return { frames, waitForFrame, close: () => ws.close() };
}

describe('an unattended child asks for a command the policy refuses', () => {
  it('is refused in under a second with the alternative spelled out', async () => {
    await bootDaemon({ settings: enforcing() });
    const parent = await createSession();
    const child = await createChildOf(parent.id);

    const startedAt = performance.now();
    const answer = await preToolUse(child.id, bash('rm -rf x'));
    const elapsedMs = performance.now() - startedAt;

    expect(answer.hookSpecificOutput).toMatchObject({ hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: expect.stringContaining('Alternative:') });
    expect(answer.hookSpecificOutput?.permissionDecisionReason).toContain('no-forced-recursive-rm');
    expect(elapsedMs).toBeLessThan(1000);
  });

  it('keeps the refusal text short enough for the model to read at a glance', async () => {
    await bootDaemon({ settings: enforcing() });
    const child = await createChildOf((await createSession()).id);

    const answer = await preToolUse(child.id, bash('rm -rf x'));

    expect(answer.hookSpecificOutput?.permissionDecisionReason?.length).toBeLessThanOrEqual(600);
  });

  it('is not refused when the session is attended: the same rm -rf goes through untouched', async () => {
    await bootDaemon({ settings: enforcing() });
    const human = await createSession();

    const answer = await preToolUse(human.id, bash('rm -rf x'));

    expect(answer).toEqual({});
  });

  it('cannot pretend to be attended through the hook payload', async () => {
    await bootDaemon({ settings: enforcing() });
    const child = await createChildOf((await createSession()).id);

    const answer = await preToolUse(child.id, bash('rm -rf x'), { presence: 'attended', parent_id: null, parentId: null });

    expect(answer.hookSpecificOutput?.permissionDecision).toBe('deny');
  });

  it('is refused when the tool is a question to a human nobody reads (AskUserQuestion)', async () => {
    await bootDaemon({ settings: enforcing() });
    const child = await createChildOf((await createSession()).id);

    const answer = await preToolUse(child.id, { tool_name: 'AskUserQuestion', tool_input: { questions: [] } });

    expect(answer.hookSpecificOutput).toMatchObject({ permissionDecision: 'deny', permissionDecisionReason: expect.stringContaining('message_parent') });
  });

  it('records a refusal that comes from a sub-agent as the work of a sub-agent', async () => {
    await bootDaemon({ settings: enforcing() });
    const child = await createChildOf((await createSession()).id);

    await preToolUse(child.id, bash('rm -rf x'), { agent_id: 'a0000000000000001', agent_type: 'general-purpose' });

    await vi.waitFor(() => expect(journalRows()).toHaveLength(1));
    expect(journalRows()[0]).toMatchObject({ actor: 'subagent', rule_id: 'no-forced-recursive-rm', outcome: 'denied' });
  });

  it('writes the refusal in the journal and announces it to connected clients', async () => {
    await bootDaemon({ settings: enforcing() });
    const parent = await createSession();
    const child = await createChildOf(parent.id);
    const socket = await openWsFrames();

    await preToolUse(child.id, bash('rm -rf x'));

    const announced = await socket.waitForFrame('command.denied');
    socket.close();
    await vi.waitFor(() => expect(journalRows()).toHaveLength(1));
    expect(journalRows()[0]).toMatchObject({
      session_id: child.id, manager_id: parent.id, role: 'DEV', profile: 'dev', harness: 'fake', rule_id: 'no-forced-recursive-rm',
      decision_source: 'policy', outcome: 'denied', tool_name: 'Bash', command_excerpt: 'rm -rf x', actor: 'session',
    });
    expect(announced.denial).toMatchObject({ sessionId: child.id, managerId: parent.id, ruleId: 'no-forced-recursive-rm', commandExcerpt: 'rm -rf x' });
  });

  it('never stores more than 200 characters of the command, secrets masked', async () => {
    await bootDaemon({ settings: enforcing() });
    const child = await createChildOf((await createSession()).id);
    const secret = syntheticToken({ shape: 'anthropic', bodyLength: 36 });

    await preToolUse(child.id, bash(`rm -rf ${'y'.repeat(400)} && echo ${secret}`));

    await vi.waitFor(() => expect(journalRows()).toHaveLength(1));
    const excerpt = String(journalRows()[0]!.command_excerpt);
    expect(excerpt.length).toBeLessThanOrEqual(200);
    expect(excerpt).not.toContain(secret);
  });

  it('masks a secret given as an option value in the journal row, the announced frame and the denials list', async () => {
    await bootDaemon({ settings: enforcing() });
    const child = await createChildOf((await createSession()).id);
    const socket = await openWsFrames();
    const base64Key = ['QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo', 'wMTIzNDU2Nzg5YWJjZGVmZ2hpamtsbW5v'].join('');
    const tokenValue = ['abc', 'DEF', '123'].join('');

    await preToolUse(child.id, bash(`rm -rf x --authorization ${base64Key} --bearer=${base64Key} --token=${tokenValue}`));

    const announced = await socket.waitForFrame('command.denied');
    socket.close();
    await vi.waitFor(() => expect(journalRows()).toHaveLength(1));
    const outputs = [String(journalRows()[0]!.command_excerpt), JSON.stringify(announced.denial), JSON.stringify(await (await api('/api/command-policy/denials')).json())];
    for (const output of outputs) {
      expect(output).not.toContain(base64Key);
      expect(output).not.toContain(tokenValue);
    }
  });
});

describe('the role profiles start by watching, not refusing', () => {
  it('lets the child go but journals what it would have refused (observe is the default mode)', async () => {
    await bootDaemon();
    const parent = await createSession();
    const child = await createChildOf(parent.id);
    const socket = await openWsFrames();

    const answer = await preToolUse(child.id, bash('rm -rf x'));

    expect(answer).toEqual({});
    await vi.waitFor(() => expect(journalRows()).toHaveLength(1));
    expect(journalRows()[0]).toMatchObject({ rule_id: 'no-forced-recursive-rm', outcome: 'observed' });
    expect(socket.frames.some((frame) => frame.type === 'command.denied')).toBe(false);
    socket.close();
  });

  it('tells the manager about nothing while it only observes', async () => {
    await bootDaemon();
    const parent = await createSession();
    const child = await createChildOf(parent.id);

    for (let attempt = 0; attempt < 4; attempt += 1) await preToolUse(child.id, bash('rm -rf x'));

    await vi.waitFor(() => expect(journalRows()).toHaveLength(4));
    expect(messagesQueuedFor(parent.id)).toEqual([]);
  });
});

describe('an unattended child receives a permission dialog it could never answer', () => {
  it('is refused at once, with no approval and no waiting_permission state', async () => {
    await bootDaemon({ settings: enforcing() });
    const parent = await createSession();
    const child = await createChildOf(parent.id);
    const socket = await openWsFrames();

    const startedAt = performance.now();
    const answer = await permissionRequest(child.id, bash("sed 's/x/y/' /elsewhere/notes.txt | gh pr merge 1"));
    const elapsedMs = performance.now() - startedAt;

    expect(answer.hookSpecificOutput).toMatchObject({ hookEventName: 'PermissionRequest', decision: { behavior: 'deny', message: expect.stringContaining('Alternative:') } });
    expect(elapsedMs).toBeLessThan(1000);
    expect(await pendingApprovals()).toEqual([]);
    const childStates = socket.frames.filter((frame) => frame.type === 'session.state' && frame.sessionId === child.id).map((frame) => frame.state);
    expect(childStates).not.toContain('waiting_permission');
    expect((daemon!.db.prepare('SELECT state FROM sessions WHERE id = ?').get(child.id) as { state: string }).state).not.toBe('waiting_permission');
    await vi.waitFor(() => expect(journalRows()).toHaveLength(1));
    expect(journalRows()[0]).toMatchObject({ session_id: child.id, decision_source: 'cli_ask', outcome: 'denied', tool_name: 'Bash' });
    socket.close();
  });

  it('is refused whatever the mode of the policy, even when the policy is off', async () => {
    await bootDaemon({ settings: enforcing({ document: { mode: 'off' } }) });
    const child = await createChildOf((await createSession()).id);

    const answer = await permissionRequest(child.id, bash('gh pr merge 1'));

    expect(answer.hookSpecificOutput?.decision?.behavior).toBe('deny');
    expect(await pendingApprovals()).toEqual([]);
  });

  it('is refused by default, with no configuration at all', async () => {
    await bootDaemon();
    const child = await createChildOf((await createSession()).id);

    const answer = await permissionRequest(child.id, bash('gh pr merge 1'));

    expect(answer.hookSpecificOutput?.decision?.behavior).toBe('deny');
  });

  it('cannot pretend to be attended through the hook payload', async () => {
    await bootDaemon({ settings: enforcing() });
    const child = await createChildOf((await createSession()).id);

    const answer = await permissionRequest(child.id, bash('gh pr merge 1'), { presence: 'attended', parentId: null });

    expect(answer.hookSpecificOutput?.decision?.behavior).toBe('deny');
    expect(await pendingApprovals()).toEqual([]);
  });

  it('keeps the approval flow when the operator turned askBecomesDeny off', async () => {
    await bootDaemon({ settings: enforcing({ unattended: { askBecomesDeny: false } }) });
    const child = await createChildOf((await createSession()).id);

    const answered = permissionRequest(child.id, bash('gh pr merge 1'));

    await vi.waitFor(async () => expect(await pendingApprovals()).toHaveLength(1));
    const [approval] = (await pendingApprovals()) as { id: string }[];
    await api(`/api/approvals/${approval!.id}/decide`, { method: 'POST', body: JSON.stringify({ behavior: 'allow' }) });
    expect((await answered).hookSpecificOutput?.decision?.behavior).toBe('allow');
  });

  it('still lets a working-state tool through: the agent must be able to save its state', async () => {
    await bootDaemon({ settings: enforcing() });
    const child = await createChildOf((await createSession()).id);

    const answer = await permissionRequest(child.id, { tool_name: 'mcp__openfleet__update_working_state', tool_input: {} });

    expect(answer.hookSpecificOutput?.decision?.behavior).toBe('allow');
  });

  it('keeps the approval flow for a manager: an approval is created and the session waits for a decision', async () => {
    await bootDaemon({ settings: enforcing() });
    const lead = await createSession({ name: 'Lead', manager: { childrenCap: 1, mission: 'x' } });
    const socket = await openWsFrames();

    const answered = permissionRequest(lead.id, bash('gh pr merge 1'));

    await vi.waitFor(async () => expect(await pendingApprovals()).toHaveLength(1));
    await vi.waitFor(() => expect(socket.frames.some((frame) => frame.type === 'session.state' && frame.sessionId === lead.id && frame.state === 'waiting_permission')).toBe(true));
    const [approval] = (await pendingApprovals()) as { id: string }[];
    await api(`/api/approvals/${approval!.id}/decide`, { method: 'POST', body: JSON.stringify({ behavior: 'allow' }) });
    expect((await answered).hookSpecificOutput?.decision?.behavior).toBe('allow');
    expect(journalRows().filter((row) => row.rule_id === 'unattended-ask-becomes-deny')).toEqual([]);
    socket.close();
  });

  it('never converts the permission dialog of a manager into a refusal, even for a manager that is the child of another manager', async () => {
    await bootDaemon({ settings: enforcing() });
    const lead = await createSession({ name: 'Lead', manager: { childrenCap: 2, mission: 'x' } });
    const subLead = await createSession({ name: 'SubLead', parentId: lead.id, manager: { childrenCap: 1, mission: 'y' } });

    const answered = permissionRequest(subLead.id, bash('gh pr merge 1'));

    await vi.waitFor(async () => expect(await pendingApprovals()).toHaveLength(1));
    const [approval] = (await pendingApprovals()) as { id: string }[];
    await api(`/api/approvals/${approval!.id}/decide`, { method: 'POST', body: JSON.stringify({ behavior: 'deny' }) });
    await answered;
    expect(journalRows().filter((row) => row.rule_id === 'unattended-ask-becomes-deny')).toEqual([]);
  });

  it('points a manager that has a parent to submit_plan_questions, not to the ask refusal of a child', async () => {
    await bootDaemon({ settings: enforcing() });
    const lead = await createSession({ name: 'Lead', manager: { childrenCap: 2, mission: 'x' } });
    const subLead = await createSession({ name: 'SubLead', parentId: lead.id, manager: { childrenCap: 1, mission: 'y' } });

    const answer = await preToolUse(subLead.id, { tool_name: 'AskUserQuestion', tool_input: { questions: [] } });

    expect(answer.hookSpecificOutput).toMatchObject({ permissionDecision: 'deny', permissionDecisionReason: expect.stringContaining('submit_plan_questions') });
    expect(answer.hookSpecificOutput?.permissionDecisionReason).not.toContain('no-human-questions-unattended');
  });

  it('refuses AskUserQuestion to a manager that has a parent and journals the attempt under the manager-ask-user-via-ladder rule', async () => {
    await bootDaemon({ settings: enforcing() });
    const lead = await createSession({ name: 'Lead', manager: { childrenCap: 2, mission: 'x' } });
    const subLead = await createSession({ name: 'SubLead', parentId: lead.id, manager: { childrenCap: 1, mission: 'y' } });

    await preToolUse(subLead.id, { tool_name: 'AskUserQuestion', tool_input: { questions: [] } });

    await vi.waitFor(() => expect(journalRows()).toHaveLength(1));
    expect(journalRows()[0]).toMatchObject({ session_id: subLead.id, rule_id: 'manager-ask-user-via-ladder', tool_name: 'AskUserQuestion', outcome: 'denied', role: 'manager' });
  });

  it('lets an attended manager ask the human with AskUserQuestion and journals the question as an observed escalation event', async () => {
    await bootDaemon({ settings: enforcing() });
    const lead = await createSession({ name: 'Lead', attended: true, manager: { childrenCap: 1, mission: 'x' } });

    const answer = await preToolUse(lead.id, { tool_name: 'AskUserQuestion', tool_input: { questions: [] } });

    expect(answer).toEqual({});
    await vi.waitFor(() => expect(journalRows()).toHaveLength(1));
    expect(journalRows()[0]).toMatchObject({ session_id: lead.id, rule_id: 'root-manager-ask-user', tool_name: 'AskUserQuestion', outcome: 'observed', role: 'manager' });
  });

  it('still lets an attended session that is not a manager ask the human', async () => {
    await bootDaemon({ settings: enforcing() });
    const human = await createSession({ name: 'Solo' });

    const answer = await preToolUse(human.id, { tool_name: 'AskUserQuestion', tool_input: { questions: [] } });

    expect(answer).toEqual({});
    expect(journalRows()).toEqual([]);
  });

  it('keeps the unattended refusal of a child that is not a manager unchanged', async () => {
    await bootDaemon({ settings: enforcing() });
    const lead = await createSession({ name: 'Lead', manager: { childrenCap: 1, mission: 'x' } });
    const worker = await createChildOf(lead.id);

    const answer = await preToolUse(worker.id, { tool_name: 'AskUserQuestion', tool_input: { questions: [] } });

    expect(answer.hookSpecificOutput?.permissionDecisionReason).toContain('no-human-questions-unattended');
    expect(answer.hookSpecificOutput?.permissionDecisionReason).toContain('message_parent');
  });

  it('does not send a manager without a parent to message_parent when the policy refuses a tool call', async () => {
    await bootDaemon({ settings: enforcing({ document: { rules: DEFAULT_COMMAND_POLICY.rules.map((rule) => ({ ...rule, presence: 'any' as const })) } }) });
    const lead = await createSession({ name: 'Lead', manager: { childrenCap: 1, mission: 'x' } });

    const answer = await preToolUse(lead.id, bash('rm -rf x'));

    expect(answer.hookSpecificOutput?.permissionDecision).toBe('deny');
    expect(answer.hookSpecificOutput?.permissionDecisionReason).not.toMatch(/message your manager|No human is watching/);
  });

  it('still applies the refusal rules of the profile to a manager that has a parent, at the permission dialog', async () => {
    await bootDaemon({ settings: enforcing() });
    const lead = await createSession({ name: 'Lead', manager: { childrenCap: 2, mission: 'x' } });
    const subLead = await createSession({ name: 'SubLead', parentId: lead.id, manager: { childrenCap: 1, mission: 'y' } });

    const answer = await permissionRequest(subLead.id, bash('rm -rf x'));

    expect(answer.hookSpecificOutput?.decision?.behavior).toBe('deny');
    expect(answer.hookSpecificOutput?.decision?.message).toContain('no-forced-recursive-rm');
  });
});

describe('a read-only pipeline arrives as a permission dialog', () => {
  const transcriptPath = '/home/user/.claude/projects/-tmp-work/cli-1.jsonl';
  const readOnlyPipeline = "sed 's/x/y/' /home/user/.claude/projects/-tmp-work/cli-1/tool-results/f | grep -n z";

  it('is allowed outright for a child: no approval, no refusal in the journal', async () => {
    await bootDaemon({ settings: enforcing() });
    const child = await createChildOf((await createSession()).id);

    const answer = await permissionRequest(child.id, bash(readOnlyPipeline), { transcript_path: transcriptPath });

    expect(answer.hookSpecificOutput).toEqual({ hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } });
    expect(await pendingApprovals()).toEqual([]);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(journalRows()).toEqual([]);
  });

  it('is allowed outright for a manager too, without opening an approval', async () => {
    await bootDaemon({ settings: enforcing() });
    const lead = await createSession({ name: 'Lead', manager: { childrenCap: 1, mission: 'x' } });

    const answer = await permissionRequest(lead.id, bash(readOnlyPipeline), { transcript_path: transcriptPath });

    expect(answer.hookSpecificOutput).toEqual({ hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } });
    expect(await pendingApprovals()).toEqual([]);
  });

  it('is allowed outright for a session without a parent too', async () => {
    await bootDaemon({ settings: enforcing() });
    const human = await createSession();

    const answer = await permissionRequest(human.id, bash(readOnlyPipeline), { transcript_path: transcriptPath });

    expect(answer.hookSpecificOutput).toEqual({ hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } });
    expect(await pendingApprovals()).toEqual([]);
  });

  it('is allowed even when the operator turned askBecomesDeny off', async () => {
    await bootDaemon({ settings: enforcing({ unattended: { askBecomesDeny: false } }) });
    const child = await createChildOf((await createSession()).id);

    const answer = await permissionRequest(child.id, bash(readOnlyPipeline), { transcript_path: transcriptPath });

    expect(answer.hookSpecificOutput?.decision?.behavior).toBe('allow');
    expect(await pendingApprovals()).toEqual([]);
  });

  it('does not vouch for a command no allow rule covers: the child is refused', async () => {
    await bootDaemon({ settings: enforcing() });
    const child = await createChildOf((await createSession()).id);

    const answer = await permissionRequest(child.id, bash('gh pr merge 1'), { transcript_path: transcriptPath });

    expect(answer.hookSpecificOutput?.decision?.behavior).toBe('deny');
  });

  it('never vouches for a sed that writes in place', async () => {
    await bootDaemon({ settings: enforcing() });
    const child = await createChildOf((await createSession()).id);

    const answer = await permissionRequest(child.id, bash("sed -i 's/x/y/' /tmp/inside.txt"), { transcript_path: transcriptPath });

    expect(answer.hookSpecificOutput?.decision?.behavior).not.toBe('allow');
  });

  it('never vouches while the policy is off', async () => {
    await bootDaemon({ settings: enforcing({ document: { mode: 'off' } }) });
    const child = await createChildOf((await createSession()).id);

    const answer = await permissionRequest(child.id, bash(readOnlyPipeline), { transcript_path: transcriptPath });

    expect(answer.hookSpecificOutput?.decision?.behavior).toBe('deny');
  });
});

describe('a session nobody supervises is not mistaken for one a human watches', () => {
  it('keeps the current behavior for a session without a parent: an approval appears and waits for a decision', async () => {
    await bootDaemon({ settings: enforcing() });
    const human = await createSession();

    const answered = permissionRequest(human.id, bash('gh pr merge 1'));

    await vi.waitFor(async () => expect(await pendingApprovals()).toHaveLength(1));
    const [approval] = (await pendingApprovals()) as { id: string }[];
    await api(`/api/approvals/${approval!.id}/decide`, { method: 'POST', body: JSON.stringify({ behavior: 'deny' }) });
    expect((await answered).hookSpecificOutput?.decision?.behavior).toBe('deny');
    expect(journalRows()).toEqual([]);
  });

  it('cannot be turned into an unattended one through the hook payload', async () => {
    await bootDaemon({ settings: enforcing() });
    const human = await createSession();

    const answered = permissionRequest(human.id, bash('gh pr merge 1'), { presence: 'unattended', parent_id: 'someone' });

    await vi.waitFor(async () => expect(await pendingApprovals()).toHaveLength(1));
    const [approval] = (await pendingApprovals()) as { id: string }[];
    await api(`/api/approvals/${approval!.id}/decide`, { method: 'POST', body: JSON.stringify({ behavior: 'allow' }) });
    await answered;
  });
});

describe('the policy evaluator breaks', () => {
  const failingEvaluator = () => { throw new Error('evaluator bug'); };

  it('answers {} with HTTP 200 on a PreToolUse and counts the degradation', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await bootDaemon({ settings: enforcing(), evaluate: failingEvaluator });
    const recordHookFailOpen = vi.spyOn(daemon!.degraded, 'recordHookFailOpen');
    const child = await createChildOf((await createSession()).id);

    const response = await postHookRaw(child.id, { hook_event_name: 'PreToolUse', ...bash('rm -rf x') });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({});
    expect(recordHookFailOpen).toHaveBeenCalledTimes(1);
  });

  it('still refuses the permission dialog of a child: the conversion does not depend on the evaluator', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await bootDaemon({ settings: enforcing(), evaluate: failingEvaluator });
    const child = await createChildOf((await createSession()).id);

    const answer = await permissionRequest(child.id, bash('gh pr merge 1'));

    expect(answer.hookSpecificOutput?.decision?.behavior).toBe('deny');
    expect(await pendingApprovals()).toEqual([]);
    await vi.waitFor(() => expect(journalRows()).toHaveLength(1));
  });

  it('keeps an attended session on its approval flow', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await bootDaemon({ settings: enforcing(), evaluate: failingEvaluator });
    const human = await createSession();

    const answered = permissionRequest(human.id, bash('gh pr merge 1'));

    await vi.waitFor(async () => expect(await pendingApprovals()).toHaveLength(1));
    const [approval] = (await pendingApprovals()) as { id: string }[];
    await api(`/api/approvals/${approval!.id}/decide`, { method: 'POST', body: JSON.stringify({ behavior: 'allow' }) });
    await answered;
  });
});

describe('a child keeps bumping into the same rule', () => {
  it('tells its manager once after three identical refusals in five minutes, then stays quiet', async () => {
    await bootDaemon({ settings: enforcing() });
    const parent = await createSession();
    const child = await createChildOf(parent.id);

    for (let attempt = 0; attempt < 5; attempt += 1) await preToolUse(child.id, bash('rm -rf x'));

    await vi.waitFor(() => expect(journalRows()).toHaveLength(5));
    const messages = messagesQueuedFor(parent.id);
    expect(messages).toHaveLength(1);
    expect(messages[0]!.body).toContain('no-forced-recursive-rm');
    expect(messages[0]!.body).toContain(child.id);
  });

  it('stays silent for two refusals', async () => {
    await bootDaemon({ settings: enforcing() });
    const parent = await createSession();
    const child = await createChildOf(parent.id);

    for (let attempt = 0; attempt < 2; attempt += 1) await preToolUse(child.id, bash('rm -rf x'));

    await vi.waitFor(() => expect(journalRows()).toHaveLength(2));
    expect(messagesQueuedFor(parent.id)).toEqual([]);
  });

  it('counts a rule per child: three refusals spread over three children make no message', async () => {
    await bootDaemon({ settings: enforcing() });
    const parent = await createSession();
    const children = [await createChildOf(parent.id), await createChildOf(parent.id), await createChildOf(parent.id)];

    for (const child of children) await preToolUse(child.id, bash('rm -rf x'));

    await vi.waitFor(() => expect(journalRows()).toHaveLength(3));
    expect(messagesQueuedFor(parent.id)).toEqual([]);
  });
});

describe('the incident: a read-only sed piped into grep on a file the CLI wrote itself', () => {
  const transcriptPath = '/home/user/.claude/projects/-tmp-work/cli-1.jsonl';
  const toolResultsFile = '/home/user/.claude/projects/-tmp-work/cli-1/tool-results/out.txt';

  it('is allowed outright for a child, so the CLI never opens a dialog', async () => {
    await bootDaemon({ settings: enforcing() });
    const child = await createChildOf((await createSession()).id);

    const answer = await preToolUse(child.id, bash(`sed 's/x/y/' ${toolResultsFile} | grep -n z`), { transcript_path: transcriptPath });

    expect(answer.hookSpecificOutput).toMatchObject({ hookEventName: 'PreToolUse', permissionDecision: 'allow' });
  });

  it('is allowed for a child inside its own working directory too (the sed substitution alone made the CLI ask)', async () => {
    await bootDaemon({ settings: enforcing() });
    const child = await createChildOf((await createSession()).id);

    const answer = await preToolUse(child.id, bash("sed 's/x/y/' /tmp/inside.txt | grep -n z"));

    expect(answer.hookSpecificOutput?.permissionDecision).toBe('allow');
  });

  it('is not vouched for when the sed writes in place', async () => {
    await bootDaemon({ settings: enforcing() });
    const child = await createChildOf((await createSession()).id);

    const answer = await preToolUse(child.id, bash("sed -i 's/x/y/' /tmp/inside.txt"));

    expect(answer.hookSpecificOutput?.permissionDecision).not.toBe('allow');
  });
});

describe('the hooks the policy does not touch', () => {
  it('answers {} to tools and events it has no opinion about', async () => {
    await bootDaemon({ settings: enforcing() });
    const child = await createChildOf((await createSession()).id);

    const answers = [
      await preToolUse(child.id, bash('git status')),
      await preToolUse(child.id, { tool_name: 'Read', tool_input: { file_path: '/tmp/a' } }),
      await postHook(child.id, { hook_event_name: 'PostToolUse', ...bash('git status') }),
    ];

    expect(answers).toEqual([{}, {}, {}]);
  });

  it('keeps accepting a payload without any of the new fields', async () => {
    await bootDaemon({ settings: enforcing() });
    const child = await createChildOf((await createSession()).id);

    const response = await postHookRaw(child.id, { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'ls' } });

    expect(response.status).toBe(200);
  });
});

describe('the daemon says how it enforces the policy', () => {
  it('reports the hook enforcement of the fake harness on the session', async () => {
    await bootDaemon();
    const session = await createSession();

    const sessions = (await (await api('/api/sessions')).json()) as { id: string; policyEnforcement?: string }[];

    expect(sessions.find((candidate) => candidate.id === session.id)?.policyEnforcement).toBe('hook');
  });
});

describe('the delivered migration', () => {
  it('ships with the daemon database', async () => {
    await bootDaemon();

    const table = daemon!.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'denied_commands'").get();

    expect(table).toEqual({ name: 'denied_commands' });
    expect(readFileSync(new URL('./db/migrations/030_denied_commands.sql', import.meta.url), 'utf8')).toContain('CREATE TABLE denied_commands');
  });
});
