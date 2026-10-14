import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { E2E_FLAG_ENV, E2E_FLAG_ON, type CommandPolicyDocument } from '@openfleet/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from './config.js';
import { startDaemon, type Daemon, type DaemonOptions } from './daemon.js';
import { DEFAULT_COMMAND_POLICY } from './policy/defaultCommandPolicy.js';
import { defaultCommandPolicySettings, type CommandPolicySettings } from './policy/commandPolicySettings.js';
import { createTempDirTracker } from './tempDirTracker.js';

const tempDirs = createTempDirTracker();
let daemon: Daemon | undefined;
let adminToken: string;

const enforcing = (changes: { document?: Partial<CommandPolicyDocument> } = {}): CommandPolicySettings => {
  const defaults = defaultCommandPolicySettings();
  return { document: { ...DEFAULT_COMMAND_POLICY, mode: 'enforce', ...changes.document }, unattended: defaults.unattended };
};

async function bootDaemon(commandPolicy?: DaemonOptions['commandPolicy']): Promise<Daemon> {
  const home = tempDirs.make('of-daemon-denials-');
  const config = loadConfig({ OPENFLEET_HOME: home, OPENFLEET_PORT: '0', [E2E_FLAG_ENV]: E2E_FLAG_ON });
  adminToken = config.adminToken;
  daemon = await startDaemon(config, { commandPolicy });
  return daemon;
}
afterEach(async () => { vi.restoreAllMocks(); await daemon?.close(); daemon = undefined; tempDirs.removeAll(); });

const api = (path: string, init: RequestInit = {}) => fetch(`${daemon!.server.url}${path}`, { ...init, headers: { 'content-type': 'application/json', authorization: `Bearer ${adminToken}`, ...(init.headers ?? {}) } });
const createSession = async (extra: Record<string, unknown> = {}) =>
  (await (await api('/api/sessions', { method: 'POST', body: JSON.stringify({ directory: '/tmp', name: 'Plain', harness: 'fake', emoji: '🤖', ...extra }) })).json()) as { id: string };
const createManager = (name: string, extra: Record<string, unknown> = {}) => createSession({ name, manager: { childrenCap: 4, mission: 'keep the fleet moving' }, ...extra });
const createWorkerOf = (parentId: string, name = 'Worker') => createSession({ name, parentId, role: 'DEV' });

const hookTokenOf = (sessionId: string) => (daemon!.db.prepare('SELECT hook_token FROM sessions WHERE id = ?').get(sessionId) as { hook_token: string }).hook_token;
const mcpTokenOf = (sessionId: string) => (daemon!.db.prepare('SELECT mcp_token FROM sessions WHERE id = ?').get(sessionId) as { mcp_token: string }).mcp_token;
const journalRowCount = () => (daemon!.db.prepare('SELECT count(*) AS n FROM denied_commands').get() as { n: number }).n;

async function refuse(sessionId: string, command = 'rm -rf x') {
  const expectedRows = journalRowCount() + 1;
  await fetch(`${daemon!.server.url}/hooks/${hookTokenOf(sessionId)}`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ session_id: 'cli-1', cwd: '/tmp', hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command } }),
  });
  await vi.waitFor(() => expect(journalRowCount()).toBe(expectedRows));
}

async function connectAs(sessionId: string): Promise<Client> {
  const client = new Client({ name: 'denials', version: '0.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${daemon!.server.url}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${mcpTokenOf(sessionId)}` } } }));
  return client;
}
const textOf = (result: unknown) => (result as { content: { text: string }[] }).content[0]!.text;
const isErrorResult = (result: unknown) => (result as { isError?: boolean }).isError === true;
interface ListedDenial { kind: string; id: string; at: string; session_id: string; session_name: string; rule_id: string; decision: string; excerpt: string; alternative?: string }
interface DenialList { denials: ListedDenial[]; truncated: boolean }
const listDenials = async (managerId: string, args: Record<string, unknown> = {}) => {
  const result = await (await connectAs(managerId)).callTool({ name: 'list_denied_commands', arguments: args });
  return { result, text: textOf(result), list: isErrorResult(result) ? undefined : (JSON.parse(textOf(result)) as DenialList) };
};

const managerViewOf = async (managerId: string) => ((await (await api(`/api/managers/${managerId}`)).json()) as { manager: { deniedCommandCount?: number; deniedCommandTotal?: number } }).manager;
const pulseBodiesQueuedFor = (managerId: string) => (daemon!.db.prepare('SELECT body FROM message_queue WHERE session_id = ? AND body LIKE ?').all(managerId, '[pulse]%') as { body: string }[]).map((row) => row.body);
const pulse = (managerId: string) => api(`/api/managers/${managerId}/pulse`, { method: 'POST' });

async function aLeadWhoseWorkerWasRefusedTwice() {
  await bootDaemon({ settings: enforcing() });
  const lead = await createManager('Lead');
  const worker = await createWorkerOf(lead.id);
  await refuse(worker.id);
  await refuse(worker.id);
  return { lead, worker };
}

describe('the manager reads the refusals of its lineage', () => {
  it('lists the two refusals of its child, newest first, each tagged denied_command', async () => {
    const { lead, worker } = await aLeadWhoseWorkerWasRefusedTwice();

    const { list } = await listDenials(lead.id);

    expect(list!.denials).toHaveLength(2);
    expect(list!.denials[0]).toMatchObject({
      kind: 'denied_command', session_id: worker.id, session_name: 'Worker', rule_id: 'no-forced-recursive-rm', decision: 'denied', excerpt: 'rm -rf x',
      alternative: expect.any(String), id: expect.any(String), at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
    });
    expect(Date.parse(list!.denials[0]!.at)).toBeGreaterThanOrEqual(Date.parse(list!.denials[1]!.at));
  });

  it('also lists the refusals of a grandchild, through the manager in between', async () => {
    await bootDaemon({ settings: enforcing() });
    const lead = await createManager('Lead');
    const subLead = await createManager('SubLead', { parentId: lead.id });
    const grandchild = await createWorkerOf(subLead.id, 'Grandchild');
    await refuse(grandchild.id);

    const { list } = await listDenials(lead.id);

    expect(list!.denials.map((denial) => denial.session_name)).toEqual(['Grandchild']);
  });

  it('refuses a session that is not a manager: not_a_manager', async () => {
    const { worker } = await aLeadWhoseWorkerWasRefusedTwice();

    const { result, text } = await listDenials(worker.id);

    expect(isErrorResult(result)).toBe(true);
    expect(text).toContain('not_a_manager');
  });

  it('shows another manager nothing of a lineage that is not its own', async () => {
    const { lead } = await aLeadWhoseWorkerWasRefusedTwice();
    const otherLead = await createManager('OtherLead');
    const otherWorker = await createWorkerOf(otherLead.id, 'OtherWorker');
    await refuse(otherWorker.id);

    const { list } = await listDenials(otherLead.id);

    expect(list!.denials.map((denial) => denial.session_name)).toEqual(['OtherWorker']);
    expect((await listDenials(lead.id)).list!.denials.map((denial) => denial.session_name)).not.toContain('OtherWorker');
  });

  it('answers outside_lineage when a manager asks for a session of another lineage', async () => {
    const { worker } = await aLeadWhoseWorkerWasRefusedTwice();
    const otherLead = await createManager('OtherLead');

    const { result, text } = await listDenials(otherLead.id, { session_id: worker.id });

    expect(isErrorResult(result)).toBe(true);
    expect(text).toContain('outside_lineage');
  });

  it('narrows the list to one session of the lineage', async () => {
    const { lead } = await aLeadWhoseWorkerWasRefusedTwice();
    const sibling = await createWorkerOf(lead.id, 'Sibling');
    await refuse(sibling.id);

    const { list } = await listDenials(lead.id, { session_id: sibling.id });

    expect(list!.denials.map((denial) => denial.session_name)).toEqual(['Sibling']);
  });

  it('honors limit and keeps the newest', async () => {
    const { lead, worker } = await aLeadWhoseWorkerWasRefusedTwice();
    await refuse(worker.id, 'rm -rf newest');

    const { list } = await listDenials(lead.id, { limit: 2 });

    expect(list!.denials).toHaveLength(2);
    expect(list!.denials[0]!.excerpt).toBe('rm -rf newest');
  });

  it('refuses a limit outside 1-100', async () => {
    const { lead } = await aLeadWhoseWorkerWasRefusedTwice();

    expect(isErrorResult((await listDenials(lead.id, { limit: 0 })).result)).toBe(true);
    expect(isErrorResult((await listDenials(lead.id, { limit: 101 })).result)).toBe(true);
  });

  it('keeps only the refusals recorded at or after since', async () => {
    const { lead, worker } = await aLeadWhoseWorkerWasRefusedTwice();
    const { list: before } = await listDenials(lead.id);
    const newestAt = before!.denials[0]!.at;
    await new Promise((resolve) => setTimeout(resolve, 5));
    await refuse(worker.id, 'rm -rf later');

    const { list } = await listDenials(lead.id, { since: new Date(Date.parse(newestAt) + 1).toISOString() });

    expect(list!.denials.map((denial) => denial.excerpt)).toEqual(['rm -rf later']);
  });

  it('refuses a since that is not a date', async () => {
    const { lead } = await aLeadWhoseWorkerWasRefusedTwice();

    expect(isErrorResult((await listDenials(lead.id, { since: 'yesterday-ish' })).result)).toBe(true);
  });

  it('never prints a secret of the refused command', async () => {
    await bootDaemon({ settings: enforcing() });
    const lead = await createManager('Lead');
    const worker = await createWorkerOf(lead.id);
    const secret = 'sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
    await refuse(worker.id, `rm -rf x && echo ${secret}`);

    const { text } = await listDenials(lead.id);

    expect(text).not.toContain(secret);
    expect(text).toContain('rm -rf x');
  });
});

describe('the manager is told how many refusals it has not looked at', () => {
  it('shows deniedCommandCount 2 and deniedCommandTotal 2 on GET /api/managers/:id', async () => {
    const { lead } = await aLeadWhoseWorkerWasRefusedTwice();

    expect(await managerViewOf(lead.id)).toMatchObject({ deniedCommandCount: 2, deniedCommandTotal: 2 });
  });

  it('shows the same counts in get_argus_status.manager', async () => {
    const { lead } = await aLeadWhoseWorkerWasRefusedTwice();

    const status = JSON.parse(textOf(await (await connectAs(lead.id)).callTool({ name: 'get_argus_status', arguments: {} }))) as { manager: { deniedCommandCount: number; deniedCommandTotal: number } };

    expect(status.manager).toMatchObject({ deniedCommandCount: 2, deniedCommandTotal: 2 });
  });

  it('drops the count to 0 once the manager has read the list, and keeps the total', async () => {
    const { lead } = await aLeadWhoseWorkerWasRefusedTwice();

    await listDenials(lead.id);

    expect(await managerViewOf(lead.id)).toMatchObject({ deniedCommandCount: 0, deniedCommandTotal: 2 });
  });

  it('counts only what happens after the last look', async () => {
    const { lead, worker } = await aLeadWhoseWorkerWasRefusedTwice();
    await listDenials(lead.id);

    await refuse(worker.id);

    expect(await managerViewOf(lead.id)).toMatchObject({ deniedCommandCount: 1, deniedCommandTotal: 3 });
  });

  it('keeps the count when the read was narrowed to one session', async () => {
    const { lead, worker } = await aLeadWhoseWorkerWasRefusedTwice();
    const sibling = await createWorkerOf(lead.id, 'Sibling');
    await refuse(sibling.id);

    await listDenials(lead.id, { session_id: sibling.id });

    expect(await managerViewOf(lead.id)).toMatchObject({ deniedCommandCount: 3 });
    expect(worker.id).toBeDefined();
  });

  it('does not count the refusals of another lineage', async () => {
    const { lead } = await aLeadWhoseWorkerWasRefusedTwice();
    const otherLead = await createManager('OtherLead');

    expect(await managerViewOf(otherLead.id)).toMatchObject({ deniedCommandCount: 0, deniedCommandTotal: 0 });
    expect(await managerViewOf(lead.id)).toMatchObject({ deniedCommandCount: 2 });
  });

  it('counts a command the policy only observes as nothing: it is listed as observed and never counted', async () => {
    await bootDaemon();
    const lead = await createManager('Lead');
    const worker = await createWorkerOf(lead.id);
    await refuse(worker.id);
    await refuse(worker.id);

    expect(await managerViewOf(lead.id)).toMatchObject({ deniedCommandCount: 0, deniedCommandTotal: 0 });
    const { list } = await listDenials(lead.id);
    expect(list!.denials.map((denial) => denial.decision)).toEqual(['observed', 'observed']);
  });
});

describe('the pulse tells the manager about refusals it has not looked at', () => {
  it('mentions the number of refusals in the next pulse text', async () => {
    const { lead } = await aLeadWhoseWorkerWasRefusedTwice();

    await pulse(lead.id);

    expect(pulseBodiesQueuedFor(lead.id)).toHaveLength(1);
    expect(pulseBodiesQueuedFor(lead.id)[0]).toContain('2 command refusals since your last look — call list_denied_commands');
  });

  it('adds no line when there is no unseen refusal', async () => {
    await bootDaemon({ settings: enforcing() });
    const lead = await createManager('Lead');

    await pulse(lead.id);

    expect(pulseBodiesQueuedFor(lead.id)[0]).not.toContain('command refusal');
  });

  it('adds no line once the manager has looked', async () => {
    const { lead } = await aLeadWhoseWorkerWasRefusedTwice();
    await listDenials(lead.id);

    await pulse(lead.id);

    expect(pulseBodiesQueuedFor(lead.id)[0]).not.toContain('command refusal');
  });

  it('adds no line for observed commands', async () => {
    await bootDaemon();
    const lead = await createManager('Lead');
    const worker = await createWorkerOf(lead.id);
    await refuse(worker.id);

    await pulse(lead.id);

    expect(pulseBodiesQueuedFor(lead.id)[0]).not.toContain('command refusal');
  });

  it('keeps one queued pulse with the same text between two pulses without a new refusal', async () => {
    const { lead } = await aLeadWhoseWorkerWasRefusedTwice();

    await pulse(lead.id);
    const firstBody = pulseBodiesQueuedFor(lead.id)[0];
    const second = await (await pulse(lead.id)).json();

    expect(second).toEqual({ pulsed: false, coalesced: true });
    expect(pulseBodiesQueuedFor(lead.id)).toEqual([firstBody]);
  });

  it('updates the queued pulse in place when a new refusal arrives', async () => {
    const { lead, worker } = await aLeadWhoseWorkerWasRefusedTwice();
    await pulse(lead.id);

    await refuse(worker.id);
    await pulse(lead.id);

    const bodies = pulseBodiesQueuedFor(lead.id);
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toContain('3 command refusals since your last look');
  });
});
