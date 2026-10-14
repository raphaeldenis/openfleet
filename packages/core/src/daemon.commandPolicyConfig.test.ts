import { chmodSync, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { E2E_FLAG_ENV, E2E_FLAG_ON, type CommandPolicyView, type DeniedCommandPage } from '@openfleet/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig, type Config } from './config.js';
import { startDaemon, type Daemon } from './daemon.js';
import type { FakeHarness } from './harness/fakeHarness.js';
import { createTempDirTracker } from './tempDirTracker.js';

const tempDirs = createTempDirTracker();
let daemon: Daemon | undefined;
let config: Config;
let adminToken: string;

async function bootDaemon({ home = tempDirs.make('of-policy-config-'), configJson }: { home?: string; configJson?: object } = {}): Promise<Daemon> {
  if (configJson) writeFileSync(join(home, 'config.json'), JSON.stringify(configJson));
  config = loadConfig({ OPENFLEET_HOME: home, OPENFLEET_PORT: '0', [E2E_FLAG_ENV]: E2E_FLAG_ON });
  adminToken = config.adminToken;
  daemon = await startDaemon(config);
  return daemon;
}
afterEach(async () => { vi.restoreAllMocks(); await daemon?.close(); daemon = undefined; tempDirs.removeAll(); });

const call = (path: string, init: RequestInit = {}, token: string = adminToken) =>
  fetch(`${daemon!.server.url}${path}`, { ...init, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...(init.headers ?? {}) } });
const putPolicy = (document: unknown, token: string = adminToken) => call('/api/command-policy', { method: 'PUT', body: JSON.stringify(document) }, token);
const getPolicy = async () => (await (await call('/api/command-policy')).json()) as CommandPolicyView;
const createSession = async (extra: Record<string, unknown> = {}) =>
  (await (await call('/api/sessions', { method: 'POST', body: JSON.stringify({ directory: '/tmp', name: 'Boss', harness: 'fake', emoji: '🤖', ...extra }) })).json()) as { id: string };
const createChildOf = (parentId: string) => createSession({ name: 'Worker', parentId, role: 'DEV' });
const hookTokenOf = (sessionId: string) => (daemon!.db.prepare('SELECT hook_token FROM sessions WHERE id = ?').get(sessionId) as { hook_token: string }).hook_token;
const mcpTokenOf = (sessionId: string) => (daemon!.db.prepare('SELECT mcp_token FROM sessions WHERE id = ?').get(sessionId) as { mcp_token: string }).mcp_token;

interface HookAnswer { hookSpecificOutput?: { permissionDecision?: string; decision?: { behavior: string } } }
const postHook = async (sessionId: string, body: Record<string, unknown>) =>
  (await (await fetch(`${daemon!.server.url}/hooks/${hookTokenOf(sessionId)}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ session_id: 'cli-1', cwd: '/tmp', ...body }) })).json()) as HookAnswer;
const bash = (command: string) => ({ tool_name: 'Bash', tool_input: { command } });
const preToolUse = (sessionId: string, command: string) => postHook(sessionId, { hook_event_name: 'PreToolUse', ...bash(command) });
const permissionRequest = (sessionId: string, command: string) => postHook(sessionId, { hook_event_name: 'PermissionRequest', ...bash(command) });

const journalRows = () => daemon!.db.prepare('SELECT * FROM denied_commands ORDER BY created_at, rowid').all() as Record<string, unknown>[];
const pendingApprovals = async () => (await (await call('/api/approvals')).json()) as unknown[];
const policyFilePath = () => join(config.home, 'command-policy.json');

describe('the command policy over HTTP is for the human: the admin token only', () => {
  it('serves the effective policy to the admin token: observe, ask becomes deny, the delivered rules', async () => {
    await bootDaemon();

    const response = await call('/api/command-policy');

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      mode: 'observe', unattended: { askBecomesDeny: true }, override: null, issues: [],
      rules: expect.arrayContaining([expect.objectContaining({ id: 'no-forced-recursive-rm', decision: 'deny', enabled: true, origin: 'delivered' })]),
    });
  });

  it.each([
    ['GET /api/command-policy', '/api/command-policy', 'GET'],
    ['PUT /api/command-policy', '/api/command-policy', 'PUT'],
    ['POST /api/command-policy/evaluate', '/api/command-policy/evaluate', 'POST'],
    ['GET /api/command-policy/denials', '/api/command-policy/denials', 'GET'],
  ])('answers 401 to the MCP token of a session on %s', async (_label, path, method) => {
    await bootDaemon();
    const child = await createChildOf((await createSession()).id);

    const response = await call(path, { method, ...(method === 'GET' ? {} : { body: JSON.stringify({ version: 1, mode: 'off', command: 'ls' }) }) }, mcpTokenOf(child.id));

    expect(response.status).toBe(401);
    expect((await response.json()).error).toBe('unauthorized');
  });

  it('answers 401 without any token and does not change the policy when a session token tries to save', async () => {
    await bootDaemon();
    const child = await createChildOf((await createSession()).id);

    const withoutToken = await putPolicy({ version: 1, mode: 'off' }, '');
    const withSessionToken = await putPolicy({ version: 1, mode: 'off' }, mcpTokenOf(child.id));

    expect([withoutToken.status, withSessionToken.status]).toEqual([401, 401]);
    expect((await getPolicy()).mode).toBe('observe');
    expect(existsSync(policyFilePath())).toBe(false);
  });
});

describe('saving the policy', () => {
  it('refuses a deny without an alternative with 400 invalid_body and saves nothing', async () => {
    await bootDaemon();
    const denyWithoutAlternative = { id: 'no-pnpm-install', tools: ['Bash'], decision: 'deny', when: { program: 'pnpm' }, reason: 'Installs change the lockfile.' };

    const response = await putPolicy({ version: 1, mode: 'enforce', rules: [denyWithoutAlternative] });

    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe('invalid_body');
    expect((await getPolicy()).mode).toBe('observe');
    expect(existsSync(policyFilePath())).toBe(false);
  });

  it('refuses a document the schema does not know with 400 invalid_body', async () => {
    await bootDaemon();

    const response = await putPolicy({ version: 1, mode: 'sometimes' });

    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe('invalid_body');
  });

  it('answers the new state and writes the file for the owner only', async () => {
    await bootDaemon();

    const response = await putPolicy({ version: 1, mode: 'enforce', disabledRules: ['no-forced-git-clean'] });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ mode: 'enforce', override: { version: 1, mode: 'enforce', disabledRules: ['no-forced-git-clean'] } });
    expect(JSON.parse(readFileSync(policyFilePath(), 'utf8'))).toEqual({ version: 1, mode: 'enforce', disabledRules: ['no-forced-git-clean'] });
    expect(statSync(policyFilePath()).mode & 0o777).toBe(0o600);
  });

  it('keeps the saved policy across a restart of the daemon on the same home', async () => {
    await bootDaemon();
    await putPolicy({ version: 1, mode: 'enforce', unattended: { askBecomesDeny: false } });
    const home = config.home;
    await daemon!.close();
    daemon = undefined;

    await bootDaemon({ home });

    expect(await getPolicy()).toMatchObject({ mode: 'enforce', unattended: { askBecomesDeny: false } });
  });

  it('answers 409 config_read_only when the file cannot be written, and keeps the old policy', async () => {
    await bootDaemon();
    await putPolicy({ version: 1, mode: 'observe' });
    chmodSync(policyFilePath(), 0o444);

    const response = await putPolicy({ version: 1, mode: 'enforce' });

    expect(response.status).toBe(409);
    expect((await response.json()).error).toBe('config_read_only');
    expect((await getPolicy()).mode).toBe('observe');
  });

  it('answers 409 config_unreadable and leaves a hand-edited file alone when it is not valid JSON', async () => {
    const home = tempDirs.make('of-policy-config-');
    writeFileSync(join(home, 'command-policy.json'), '{oops, a typo of the operator');
    await bootDaemon({ home });

    const response = await putPolicy({ version: 1, mode: 'enforce' });

    expect(response.status).toBe(409);
    expect((await response.json()).error).toBe('config_unreadable');
    expect(readFileSync(policyFilePath(), 'utf8')).toBe('{oops, a typo of the operator');
  });

  it('boots on the delivered policy when the file is not valid JSON, and reports it', async () => {
    const home = tempDirs.make('of-policy-config-');
    writeFileSync(join(home, 'command-policy.json'), '{oops');
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    await bootDaemon({ home });

    const view = await getPolicy();
    expect(view).toMatchObject({ mode: 'observe', unattended: { askBecomesDeny: true } });
    expect(view.issues).toHaveLength(1);
  });
});

describe('the policy answers differently as soon as it is saved, without a restart', () => {
  it('goes off, then observe, then enforce on the very next hook', async () => {
    await bootDaemon();
    const child = await createChildOf((await createSession()).id);

    await putPolicy({ version: 1, mode: 'off' });
    const whileOff = await preToolUse(child.id, 'rm -rf x');
    await putPolicy({ version: 1, mode: 'observe' });
    const whileObserving = await preToolUse(child.id, 'rm -rf x');
    await putPolicy({ version: 1, mode: 'enforce' });
    const whileEnforcing = await preToolUse(child.id, 'rm -rf x');

    expect(whileOff).toEqual({});
    expect(whileObserving).toEqual({});
    expect(whileEnforcing.hookSpecificOutput?.permissionDecision).toBe('deny');
    await vi.waitFor(() => expect(journalRows().map((row) => row.outcome)).toEqual(['observed', 'denied']));
  });

  it('stops refusing a rule the override disables', async () => {
    await bootDaemon();
    const child = await createChildOf((await createSession()).id);
    await putPolicy({ version: 1, mode: 'enforce' });
    expect((await preToolUse(child.id, 'rm -rf x')).hookSpecificOutput?.permissionDecision).toBe('deny');

    await putPolicy({ version: 1, mode: 'enforce', disabledRules: ['no-forced-recursive-rm'] });

    expect(await preToolUse(child.id, 'rm -rf x')).toEqual({});
  });

  it('refuses with a rule the operator adds', async () => {
    await bootDaemon();
    const child = await createChildOf((await createSession()).id);
    const noInstall = { id: 'no-pnpm-install', tools: ['Bash'], presence: 'unattended', decision: 'deny', when: { program: 'pnpm', subcommand: 'install' }, reason: 'Installs change the lockfile.', alternative: 'Ask your manager to run the install.' };
    await putPolicy({ version: 1, mode: 'enforce', rules: [noInstall], profiles: { default: { rules: ['no-pnpm-install'] } } });

    const answer = await preToolUse(child.id, 'pnpm install');

    expect(answer.hookSpecificOutput?.permissionDecision).toBe('deny');
  });
});

describe('the switch of the mode and the switch of the conversion are two switches', () => {
  it('keeps turning a permission dialog of a child into a refusal while the mode is off', async () => {
    await bootDaemon();
    const child = await createChildOf((await createSession()).id);
    await putPolicy({ version: 1, mode: 'off' });

    const answer = await permissionRequest(child.id, 'gh pr merge 1');

    expect(answer.hookSpecificOutput?.decision?.behavior).toBe('deny');
    expect(await pendingApprovals()).toEqual([]);
  });

  it('gives the permission dialog back to the approval flow once askBecomesDeny is false', async () => {
    await bootDaemon();
    const child = await createChildOf((await createSession()).id);
    await putPolicy({ version: 1, mode: 'enforce', unattended: { askBecomesDeny: false } });

    const answered = permissionRequest(child.id, 'gh pr merge 1');

    await vi.waitFor(async () => expect(await pendingApprovals()).toHaveLength(1));
    const [approval] = (await pendingApprovals()) as { id: string }[];
    await call(`/api/approvals/${approval!.id}/decide`, { method: 'POST', body: JSON.stringify({ behavior: 'allow' }) });
    expect((await answered).hookSpecificOutput?.decision?.behavior).toBe('allow');
  });

  it('refuses again as soon as askBecomesDeny is true again', async () => {
    await bootDaemon();
    const child = await createChildOf((await createSession()).id);
    await putPolicy({ version: 1, unattended: { askBecomesDeny: false } });
    await putPolicy({ version: 1, unattended: { askBecomesDeny: true } });

    const answer = await permissionRequest(child.id, 'gh pr merge 1');

    expect(answer.hookSpecificOutput?.decision?.behavior).toBe('deny');
  });

  it('shows the enforcement of a session as none only when both switches are off', async () => {
    await bootDaemon();
    const session = await createSession();
    const enforcementOf = async () => ((await (await call('/api/sessions')).json()) as { id: string; policyEnforcement?: string }[]).find((candidate) => candidate.id === session.id)?.policyEnforcement;

    const initially = await enforcementOf();
    await putPolicy({ version: 1, mode: 'off' });
    const modeOffOnly = await enforcementOf();
    await putPolicy({ version: 1, mode: 'off', unattended: { askBecomesDeny: false } });
    const bothOff = await enforcementOf();
    await putPolicy({ version: 1, mode: 'enforce', unattended: { askBecomesDeny: false } });
    const enforcingAgain = await enforcementOf();

    expect([initially, modeOffOnly, bothOff, enforcingAgain]).toEqual(['hook', 'hook', 'none', 'hook']);
  });
});

describe('trying a command', () => {
  const tryCommand = (body: Record<string, unknown>) => call('/api/command-policy/evaluate', { method: 'POST', body: JSON.stringify(body) });

  it('answers the verdict, the mode and the profile without writing a line in the journal', async () => {
    await bootDaemon();
    await putPolicy({ version: 1, mode: 'enforce' });

    const response = await tryCommand({ command: 'rm -rf build', role: 'DEV', presence: 'unattended', harness: 'claude-cli', cwd: '/tmp' });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ mode: 'enforce', profile: 'dev', verdict: { decision: 'deny', ruleId: 'no-forced-recursive-rm', alternative: expect.stringContaining('rm -r') } });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(journalRows()).toEqual([]);
  });

  it('answers allow for the same command in front of a person, and for a harmless one', async () => {
    await bootDaemon();
    await putPolicy({ version: 1, mode: 'enforce' });

    const attended = await (await tryCommand({ command: 'rm -rf build', presence: 'attended' })).json();
    const harmless = await (await tryCommand({ command: 'git status' })).json();

    expect(attended.verdict.decision).toBe('allow');
    expect(harmless.verdict.decision).toBe('allow');
  });

  it('says a command is only observed while the policy observes', async () => {
    await bootDaemon();

    const result = await (await tryCommand({ command: 'rm -rf build' })).json();

    expect(result).toMatchObject({ mode: 'observe', verdict: { decision: 'allow', observed: { ruleId: 'no-forced-recursive-rm' } } });
  });

  it('refuses a body without a command with 400 invalid_body', async () => {
    await bootDaemon();

    const response = await tryCommand({ role: 'DEV' });

    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe('invalid_body');
  });
});

describe('the list of refusals', () => {
  async function refuseNTimes(count: number): Promise<{ parent: { id: string }; child: { id: string } }> {
    await putPolicy({ version: 1, mode: 'enforce' });
    const parent = await createSession();
    const child = await createChildOf(parent.id);
    for (let attempt = 0; attempt < count; attempt += 1) await preToolUse(child.id, `rm -rf target-${attempt}`);
    await vi.waitFor(() => expect(journalRows()).toHaveLength(count));
    return { parent, child };
  }
  const denials = async (query = '') => (await (await call(`/api/command-policy/denials${query}`)).json()) as DeniedCommandPage;

  it('lists the newest refusal first', async () => {
    await bootDaemon();
    await refuseNTimes(3);

    const page = await denials();

    expect(page.items.map((denial) => denial.commandExcerpt)).toEqual(['rm -rf target-2', 'rm -rf target-1', 'rm -rf target-0']);
    expect(page.items[0]).toMatchObject({ ruleId: 'no-forced-recursive-rm', outcome: 'denied', alternative: expect.stringContaining('rm -r') });
    expect(page.nextCursor).toBeUndefined();
  });

  it('never lets a secret of a refused command reach the journal, the API or the command.denied frame', async () => {
    await bootDaemon();
    await putPolicy({ version: 1, mode: 'enforce' });
    const child = await createChildOf((await createSession()).id);
    const { ticket } = (await (await call('/api/ws-ticket', { method: 'POST' })).json()) as { ticket: string };
    const socket = new WebSocket(`${daemon!.server.url.replace('http', 'ws')}/ws?ticket=${ticket}`);
    const frames: string[] = [];
    socket.addEventListener('message', (message) => frames.push(String(message.data)));
    await new Promise((resolve) => socket.addEventListener('open', resolve, { once: true }));

    await preToolUse(child.id, 'rm -rf s5 --password hunter2plain');
    await preToolUse(child.id, 'PASSWORD=hunter2plain rm -rf s6 --token=hunter2plain');
    await vi.waitFor(() => expect(frames.filter((frame) => frame.includes('command.denied'))).toHaveLength(2));
    socket.close();

    const journalText = JSON.stringify(journalRows());
    const apiText = JSON.stringify(await denials());
    expect(journalText).not.toContain('hunter2plain');
    expect(apiText).not.toContain('hunter2plain');
    expect(frames.join('\n')).not.toContain('hunter2plain');
    expect((await denials()).items.map((denial) => denial.commandExcerpt)).toEqual(['PASSWORD=*** rm -rf s6 --token=***', 'rm -rf s5 --password ***']);
  });

  it('pages through refusals recorded in the same millisecond without a gap or a repeat', async () => {
    await bootDaemon();
    await refuseNTimes(5);
    daemon!.db.exec("UPDATE denied_commands SET created_at = '2026-10-14T10:00:00.000Z'");

    const first = await denials('?limit=2');
    const second = await denials(`?limit=2&cursor=${encodeURIComponent(first.nextCursor!)}`);
    const third = await denials(`?limit=2&cursor=${encodeURIComponent(second.nextCursor!)}`);

    const ids = [...first.items, ...second.items, ...third.items].map((denial) => denial.id);
    const rowidOrder = (daemon!.db.prepare('SELECT id FROM denied_commands ORDER BY rowid DESC').all() as { id: string }[]).map((row) => row.id);
    expect(ids).toEqual(rowidOrder);
    expect([first.items.length, second.items.length, third.items.length]).toEqual([2, 2, 1]);
    expect(third.nextCursor).toBeUndefined();
  });

  it('filters by manager and by date', async () => {
    await bootDaemon();
    const { parent } = await refuseNTimes(2);
    const otherParent = await createSession({ name: 'Other' });
    const otherChild = await createChildOf(otherParent.id);
    await preToolUse(otherChild.id, 'rm -rf elsewhere');
    await vi.waitFor(() => expect(journalRows()).toHaveLength(3));

    const ofParent = await denials(`?manager=${parent.id}`);
    const inTheFuture = await denials('?since=2999-01-01T00:00:00.000Z');

    expect(ofParent.items).toHaveLength(2);
    expect(ofParent.items.every((denial) => denial.managerId === parent.id)).toBe(true);
    expect(inTheFuture.items).toEqual([]);
  });

  it('refuses a malformed cursor or limit with 400 invalid_body', async () => {
    await bootDaemon();

    const badCursor = await call('/api/command-policy/denials?cursor=not-a-cursor');
    const badLimit = await call('/api/command-policy/denials?limit=0');

    expect([badCursor.status, badLimit.status]).toEqual([400, 400]);
    expect((await badCursor.json()).error).toBe('invalid_body');
  });
});

describe('the net under a child that waits on a prompt for good', () => {
  const waitsOnPromptNobodySees = (sessionId: string) => postHook(sessionId, { hook_event_name: 'Notification', notification_type: 'permission_prompt' });
  const messagesQueuedFor = (sessionId: string) => (daemon!.db.prepare('SELECT body FROM message_queue WHERE session_id = ?').all(sessionId) as { body: string }[]);
  const typedInTerminals = () => ((daemon!.harnesses.find((harness) => harness.id === 'fake') as FakeHarness).handles).flatMap((handle) => handle.written);

  async function openWsFrames() {
    const { ticket } = (await (await call('/api/ws-ticket', { method: 'POST' })).json()) as { ticket: string };
    const ws = new WebSocket(`${daemon!.server.url.replace('http', 'ws')}/ws?ticket=${ticket}`);
    const frames: { type: string; blocks?: { sessionId: string }[] }[] = [];
    ws.addEventListener('message', (message) => frames.push(JSON.parse(String(message.data))));
    await new Promise((resolve) => ws.addEventListener('open', resolve, { once: true }));
    return { frames, close: () => ws.close() };
  }
  const silentBlockOf = (frames: { type: string; blocks?: { sessionId: string }[] }[], sessionId: string) =>
    frames.find((frame) => frame.type === 'permission.silent_blocks' && frame.blocks?.some((block) => block.sessionId === sessionId));

  it('raises permission.silent_blocks after the configured seconds, tells the manager, and never types in the terminal', async () => {
    await bootDaemon({ configJson: { permissions: { unattendedSilentBlockSeconds: 1 } } });
    const parent = await createSession();
    const child = await createChildOf(parent.id);
    const socket = await openWsFrames();
    const typedBefore = typedInTerminals().length;

    await waitsOnPromptNobodySees(child.id);

    await vi.waitFor(() => expect(silentBlockOf(socket.frames, child.id)).toBeDefined(), { timeout: 3000, interval: 50 });
    socket.close();
    await vi.waitFor(() => expect(messagesQueuedFor(parent.id)).toHaveLength(1));
    expect(messagesQueuedFor(parent.id)[0]!.body).toContain(child.id);
    expect(typedInTerminals().slice(typedBefore).join('')).not.toContain('\u001b');
    expect((daemon!.harnesses.find((harness) => harness.id === 'fake') as FakeHarness).handles.every((handle) => handle.interruptCount === 0)).toBe(true);
  });

  it('does not raise it when the child leaves the prompt in time', async () => {
    await bootDaemon({ configJson: { permissions: { unattendedSilentBlockSeconds: 1 } } });
    const parent = await createSession();
    const child = await createChildOf(parent.id);
    const socket = await openWsFrames();

    await waitsOnPromptNobodySees(child.id);
    await postHook(child.id, { hook_event_name: 'UserPromptSubmit' });
    await new Promise((resolve) => setTimeout(resolve, 1500));

    socket.close();
    expect(silentBlockOf(socket.frames, child.id)).toBeUndefined();
    expect(messagesQueuedFor(parent.id)).toEqual([]);
  });

  it('keeps the five minutes of the permissions config for a session a person watches', async () => {
    await bootDaemon({ configJson: { permissions: { unattendedSilentBlockSeconds: 1 } } });
    const human = await createSession();
    const socket = await openWsFrames();

    await waitsOnPromptNobodySees(human.id);
    await new Promise((resolve) => setTimeout(resolve, 1500));

    socket.close();
    expect(silentBlockOf(socket.frames, human.id)).toBeUndefined();
  });

  it('keeps the five minutes for a child whose dialogs go to the approval flow (askBecomesDeny off): a person can answer the card', async () => {
    await bootDaemon({ configJson: { permissions: { unattendedSilentBlockSeconds: 1 } } });
    const child = await createChildOf((await createSession()).id);
    await putPolicy({ version: 1, unattended: { askBecomesDeny: false } });
    const socket = await openWsFrames();

    await waitsOnPromptNobodySees(child.id);
    await new Promise((resolve) => setTimeout(resolve, 1500));

    socket.close();
    expect(silentBlockOf(socket.frames, child.id)).toBeUndefined();
  });

  it('raises it within 35 seconds with the default configuration (30 seconds)', async () => {
    await bootDaemon();
    const parent = await createSession();
    const child = await createChildOf(parent.id);
    const socket = await openWsFrames();
    const startedAt = performance.now();

    await waitsOnPromptNobodySees(child.id);

    await vi.waitFor(() => expect(silentBlockOf(socket.frames, child.id)).toBeDefined(), { timeout: 35_000, interval: 250 });
    socket.close();
    const elapsedSeconds = (performance.now() - startedAt) / 1000;
    expect(elapsedSeconds).toBeGreaterThanOrEqual(29);
    expect(elapsedSeconds).toBeLessThanOrEqual(35);
  }, 40_000);
});
