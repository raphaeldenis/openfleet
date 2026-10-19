import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { E2E_FLAG_ENV, E2E_FLAG_ON } from '@openfleet/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig, type Config } from '../config.js';
import { startDaemon, type Daemon } from '../daemon.js';
import { makeRepo } from '../git/testRepo.js';
import { defaultCommandPolicySettings } from '../policy/commandPolicySettings.js';
import { ProjectRepository } from '../projects/projectRepository.js';
import { childEnvironmentForGit } from '../process/childEnvironment.js';
import { createTempDirTracker } from '../tempDirTracker.js';

const tempDirs = createTempDirTracker();
let daemon: Daemon;
let config: Config;

const adminApi = (path: string, init: RequestInit = {}) => fetch(`${daemon.server.url}${path}`, { ...init, headers: { 'content-type': 'application/json', authorization: `Bearer ${config.adminToken}` } });
const mcpTokenOf = (sessionId: string) => (daemon.db.prepare('SELECT mcp_token FROM sessions WHERE id = ?').get(sessionId) as { mcp_token: string }).mcp_token;
const hookTokenOf = (sessionId: string) => (daemon.db.prepare('SELECT hook_token FROM sessions WHERE id = ?').get(sessionId) as { hook_token: string }).hook_token;
const rawText = (result: unknown) => (result as { content: { text: string }[] }).content[0]!.text;
const parsed = (result: unknown) => JSON.parse(rawText(result));

async function connectAs(sessionId: string): Promise<Client> {
  const client = new Client({ name: 'qe', version: '0.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${daemon.server.url}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${mcpTokenOf(sessionId)}` } } }));
  return client;
}

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd, env: childEnvironmentForGit(process.env), encoding: 'utf8' }).trim();

const emptyDirectory = (name: string) => {
  const directory = join(config.worktreesRoot, name);
  mkdirSync(directory, { recursive: true });
  return directory;
};

const worktreeOnBranch = (branch: string) => {
  const directory = join(config.worktreesRoot, branch);
  git(makeRepo(), 'worktree', 'add', '-b', branch, directory);
  return directory;
};
const headOf = (directory: string) => git(directory, 'rev-parse', 'HEAD');
const commitIn = (directory: string) => git(directory, 'commit', '--allow-empty', '-m', 'next');

async function bootLead() {
  const created = (await (await adminApi('/api/sessions', { method: 'POST', body: JSON.stringify({ directory: '/tmp', name: 'Root', harness: 'fake', emoji: '🧭' }) })).json()) as { id: string };
  new ProjectRepository(daemon.db).insert({ id: 'p1', name: 'One', docsFolderPath: null, createdAt: 't0' });
  daemon.db.prepare('UPDATE sessions SET project_id = ? WHERE id = ?').run('p1', created.id);
  const root = await connectAs(created.id);
  const lead = parsed(await root.callTool({ name: 'create_session', arguments: { directory: emptyDirectory('lead'), name: 'Lead', manager: { pulse_seconds: 3600, children_cap: 8, mission: 'm' } } }));
  return { lead, leadClient: await connectAs(lead.id) };
}

/** The lead spawns, in the DEV's worktree, a child of the given role; `runnerId` is the DEV that runs gh pr create under the lead. */
async function bootTeam(branch = 'CCM-123-steps') {
  const { lead, leadClient } = await bootLead();
  const devDirectory = worktreeOnBranch(branch);
  const spawn = async (role: string) => {
    const child = parsed(await leadClient.callTool({ name: 'create_session', arguments: { directory: devDirectory, name: role, role, allow_duplicate: true } }));
    return { id: child.id as string, client: await connectAs(child.id) };
  };
  const runner = await spawn('dev');
  return { lead, leadClient, devDirectory, spawn, runnerId: runner.id };
}

const reportStep = (client: Client, report: { step: string; severity: string; claims: string[]; sha: string }) => client.callTool({ name: 'report_step_finding', arguments: report });
const rows = () => daemon.db.prepare('SELECT ticket, step, severity, claim, sha, author_session_id AS authorSessionId, manager_session_id AS managerSessionId FROM review_findings ORDER BY id').all() as Record<string, unknown>[];
const countOfEveryTable = () => daemon.db.prepare('SELECT (SELECT COUNT(*) FROM review_step_skips) AS skips, (SELECT COUNT(*) FROM message_queue) AS messages').get();

const runGhPrCreate = async (sessionId: string, directory: string) =>
  (await (await fetch(`${daemon.server.url}/hooks/${hookTokenOf(sessionId)}`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ hook_event_name: 'PreToolUse', session_id: 'cli-1', cwd: directory, tool_name: 'Bash', tool_input: { command: 'gh pr create --fill' } }),
  })).json()) as { hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string } };

async function bootDaemon(enforcement?: 'observe' | 'enforce') {
  const home = tempDirs.make('of-step-finding-');
  config = loadConfig({ OPENFLEET_HOME: home, OPENFLEET_PORT: '0', [E2E_FLAG_ENV]: E2E_FLAG_ON });
  const settings = defaultCommandPolicySettings();
  daemon = await startDaemon(config, { commandPolicy: { settings: { ...settings, unattended: { ...settings.unattended, askBecomesDeny: false } } }, ...(enforcement === undefined ? {} : { findingsGateEnforcement: enforcement }) });
}

beforeEach(async () => { await bootDaemon('observe'); });
afterEach(async () => { await daemon.close(); tempDirs.removeAll(); });

describe('QE — report_step_finding on a booted daemon', () => {
  it('a qe records a clean line at the head: the daemon writes ticket, author and manager', async () => {
    const { spawn, lead, devDirectory } = await bootTeam();
    const qe = await spawn('qe');
    const head = headOf(devDirectory);

    const result = await reportStep(qe.client, { step: 'qe', severity: 'clean', claims: [], sha: head });

    expect(result.isError).toBeFalsy();
    expect(parsed(result)).toEqual({ recorded: true, step: 'qe', severity: 'clean' });
    expect(rows()).toEqual([{ ticket: 'CCM-123', step: 'qe', severity: 'clean', claim: '', sha: head, authorSessionId: qe.id, managerSessionId: lead.id }]);
  });

  it('records findings with their claims; the stored severity is the blocking one', async () => {
    const { spawn, devDirectory } = await bootTeam();
    const qa = await spawn('qa');

    const result = await reportStep(qa.client, { step: 'qa', severity: 'findings', claims: ['the filter is missing', 'a 500 on the stream'], sha: headOf(devDirectory) });

    expect(parsed(result)).toEqual({ recorded: true, step: 'qa', severity: 'findings' });
    expect(rows()).toMatchObject([{ step: 'qa', severity: 'no-go', claim: 'the filter is missing; a 500 on the stream' }]);
  });

  it('a stale sha for qe is refused with verdict_stale and leaves no line', async () => {
    const { spawn, devDirectory } = await bootTeam();
    const qe = await spawn('qe');
    const staleHead = headOf(devDirectory);
    commitIn(devDirectory);

    const result = await reportStep(qe.client, { step: 'qe', severity: 'clean', claims: [], sha: staleHead });

    expect(result.isError).toBe(true);
    expect(rawText(result)).toMatch(/^error verdict_stale: .* \(retry: never\)$/);
    expect(rows()).toEqual([]);
  });

  it('a ponytail accepts an ancestor of the head and refuses a sha that is not on the branch', async () => {
    const { spawn, devDirectory } = await bootTeam();
    const ponytail = await spawn('ponytail');
    const ancestor = headOf(devDirectory);
    commitIn(devDirectory);
    const foreign = 'f'.repeat(40);

    const onAncestor = await reportStep(ponytail.client, { step: 'ponytail', severity: 'findings', claims: ['over-built'], sha: ancestor });
    const onForeign = await reportStep(ponytail.client, { step: 'ponytail', severity: 'clean', claims: [], sha: foreign });

    expect(onAncestor.isError).toBeFalsy();
    expect(onForeign.isError).toBe(true);
    expect(rawText(onForeign)).toMatch(/^error verdict_stale: /);
    expect(rows()).toHaveLength(1);
  });

  it('a qe sha that is an ancestor of the head is still stale', async () => {
    const { spawn, devDirectory } = await bootTeam();
    const qe = await spawn('qe');
    const ancestor = headOf(devDirectory);
    commitIn(devDirectory);

    const result = await reportStep(qe.client, { step: 'qe', severity: 'clean', claims: [], sha: ancestor });

    expect(rawText(result)).toMatch(/^error verdict_stale: /);
  });

  it('masks a secret and flattens a line break in a claim', async () => {
    const { spawn, devDirectory } = await bootTeam();
    const qe = await spawn('qe');

    await reportStep(qe.client, { step: 'qe', severity: 'findings', claims: ['token ghp_abcdefghijklmnopqrstuvwxyz0123456789 leaked\nin the log'], sha: headOf(devDirectory) });

    const [line] = rows();
    expect(line!.claim).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz0123456789');
    expect(line!.claim).not.toContain('\n');
    expect(line!.claim).toContain('in the log');
  });

  it.each([
    ['findings without claim', { step: 'qe', severity: 'findings', claims: [] as string[] }],
    ['six claims', { step: 'qe', severity: 'findings', claims: ['a', 'b', 'c', 'd', 'e', 'f'] }],
    ['an unknown severity', { step: 'qe', severity: 'go', claims: [] as string[] }],
    ['the adversarial step', { step: 'adversarial', severity: 'clean', claims: [] as string[] }],
  ])('refuses %s with an error and writes nothing', async (_name, shape) => {
    const { spawn, devDirectory } = await bootTeam();
    const qe = await spawn('qe');

    const result = await reportStep(qe.client, { ...shape, sha: headOf(devDirectory) });

    expect(result.isError).toBe(true);
    expect(rows()).toEqual([]);
  });

  it('refuses a worktree whose branch names no ticket', async () => {
    const { spawn, devDirectory } = await bootTeam('cleanup-without-ticket');
    const qe = await spawn('qe');

    const result = await reportStep(qe.client, { step: 'qe', severity: 'clean', claims: [], sha: headOf(devDirectory) });

    expect(rawText(result)).toMatch(/^error invalid_body: .*ticket/i);
    expect(rows()).toEqual([]);
  });

  it('writes nowhere else than review_findings', async () => {
    const { spawn, devDirectory } = await bootTeam();
    const qe = await spawn('qe');
    const before = countOfEveryTable();

    await reportStep(qe.client, { step: 'qe', severity: 'findings', claims: ['x'], sha: headOf(devDirectory) });

    expect(countOfEveryTable()).toEqual(before);
  });
});

describe('QE — who may write a step finding', () => {
  it('a DEV cannot write itself a clean qe', async () => {
    const { spawn, devDirectory } = await bootTeam();
    const dev = await spawn('dev');

    const result = await reportStep(dev.client, { step: 'qe', severity: 'clean', claims: [], sha: headOf(devDirectory) });

    expect(rawText(result)).toMatch(/^error not_a_manager: /);
    expect(rows()).toEqual([]);
  });

  it('a session without role cannot write', async () => {
    const { leadClient, devDirectory } = await bootTeam();
    const plain = parsed(await leadClient.callTool({ name: 'create_session', arguments: { directory: devDirectory, name: 'Plain', allow_duplicate: true } }));

    const result = await reportStep(await connectAs(plain.id), { step: 'qe', severity: 'clean', claims: [], sha: headOf(devDirectory) });

    expect(rawText(result)).toMatch(/^error not_a_manager: /);
  });

  it.each([
    ['qe', 'qa'], ['qe', 'ponytail'], ['qa', 'qe'], ['ponytail', 'qe'],
  ])('a %s cannot write the %s step', async (role, step) => {
    const { spawn, devDirectory } = await bootTeam();
    const child = await spawn(role);

    const result = await reportStep(child.client, { step, severity: 'clean', claims: [], sha: headOf(devDirectory) });

    expect(rawText(result)).toMatch(/^error not_a_manager: /);
    expect(rows()).toEqual([]);
  });

  it('a reviewer does not see the tool: its profile stays report_ship_verdict and message_parent', async () => {
    const { spawn } = await bootTeam();
    const reviewer = await spawn('reviewer');

    const toolNames = (await reviewer.client.listTools()).tools.map((tool) => tool.name).sort();

    expect(toolNames).toEqual(['message_parent', 'report_ship_verdict']);
  });

  it('a DEV that spawns a child declaring the qe role gets a child that cannot write', async () => {
    const { spawn } = await bootTeam();
    const dev = await spawn('dev');
    const impostorDirectory = worktreeOnBranch('CCM-777-impostor');
    const impostor = parsed(await dev.client.callTool({ name: 'create_session', arguments: { directory: impostorDirectory, name: 'Impostor', role: 'qe' } }));

    const result = await reportStep(await connectAs(impostor.id), { step: 'qe', severity: 'clean', claims: [], sha: headOf(impostorDirectory) });

    expect(rawText(result)).toMatch(/^error not_a_manager: /);
    expect(rows()).toEqual([]);
  });

  it('a qe, qa or ponytail keeps its whole tool registry', async () => {
    const { spawn, leadClient } = await bootTeam();
    const qe = await spawn('qe');

    const qeTools = (await qe.client.listTools()).tools.map((tool) => tool.name).sort();
    const leadTools = (await leadClient.listTools()).tools.map((tool) => tool.name).sort();

    expect(qeTools).toEqual(leadTools);
    expect(qeTools).toContain('report_step_finding');
  });
});

describe('QE — the findings gate reads what the roles report', () => {
  const bootEnforcing = async () => {
    await daemon.close();
    tempDirs.removeAll();
    await bootDaemon('enforce');
    return bootTeam();
  };

  const reportAllAtHead = async (team: Awaited<ReturnType<typeof bootTeam>>, { ponytailSeverity = 'findings' as 'clean' | 'findings' } = {}) => {
    const [qe, qa, ponytail, reviewer] = await Promise.all(['qe', 'qa', 'ponytail', 'reviewer'].map(team.spawn));
    const sha = headOf(team.devDirectory);
    await reportStep(qe!.client, { step: 'qe', severity: 'clean', claims: [], sha });
    await reportStep(qa!.client, { step: 'qa', severity: 'clean', claims: [], sha });
    await reportStep(ponytail!.client, { step: 'ponytail', severity: ponytailSeverity, claims: ponytailSeverity === 'findings' ? ['could be shorter'] : [], sha });
    await reviewer!.client.callTool({ name: 'report_ship_verdict', arguments: { verdict: 'go', reasons: [], sha } });
    return { qe: qe!, qa: qa!, ponytail: ponytail!, reviewer: reviewer! };
  };

  it('opens on qe clean, qa clean, a ponytail with findings and a reviewer go; a new commit closes it again', async () => {
    const team = await bootEnforcing();
    await reportAllAtHead(team);

    const opened = await runGhPrCreate(team.runnerId, team.devDirectory);
    commitIn(team.devDirectory);
    const closed = await runGhPrCreate(team.runnerId, team.devDirectory);

    expect(opened).toEqual({});
    expect(closed.hookSpecificOutput?.permissionDecision).toBe('deny');
  });

  it('closes on a qe findings written after the clean one, and reopens on the next clean', async () => {
    const team = await bootEnforcing();
    const { qe } = await reportAllAtHead(team);
    const sha = headOf(team.devDirectory);

    await reportStep(qe.client, { step: 'qe', severity: 'findings', claims: ['regression on the stream'], sha });
    const closed = await runGhPrCreate(team.runnerId, team.devDirectory);
    await reportStep(qe.client, { step: 'qe', severity: 'clean', claims: [], sha });
    const reopened = await runGhPrCreate(team.runnerId, team.devDirectory);

    expect(closed.hookSpecificOutput?.permissionDecisionReason).toContain('qe');
    expect(reopened).toEqual({});
  });

  it('closes on a qa findings', async () => {
    const team = await bootEnforcing();
    const { qa } = await reportAllAtHead(team);

    await reportStep(qa.client, { step: 'qa', severity: 'findings', claims: ['the card is empty'], sha: headOf(team.devDirectory) });

    expect((await runGhPrCreate(team.runnerId, team.devDirectory)).hookSpecificOutput?.permissionDecisionReason).toContain('qa');
  });

  it('stays open on a ponytail findings: the ponytail step is informative', async () => {
    const team = await bootEnforcing();
    await reportAllAtHead(team, { ponytailSeverity: 'findings' });

    expect(await runGhPrCreate(team.runnerId, team.devDirectory)).toEqual({});
  });

  it('opens on a clean ponytail as well', async () => {
    const team = await bootEnforcing();
    await reportAllAtHead(team, { ponytailSeverity: 'clean' });

    expect(await runGhPrCreate(team.runnerId, team.devDirectory)).toEqual({});
  });

  it('ships enforcing: with no option the Lead is refused without findings and opened by the reported ones', async () => {
    await daemon.close();
    tempDirs.removeAll();
    await bootDaemon();
    const team = await bootTeam();

    const refused = await runGhPrCreate(team.runnerId, team.devDirectory);
    await reportAllAtHead(team, { ponytailSeverity: 'clean' });
    const opened = await runGhPrCreate(team.runnerId, team.devDirectory);

    expect(refused.hookSpecificOutput?.permissionDecisionReason).toContain('findings_required');
    expect(opened).toEqual({});
  });

  it('observes when the daemon is told to observe', async () => {
    await daemon.close();
    tempDirs.removeAll();
    await bootDaemon('observe');
    const team = await bootTeam();

    expect(await runGhPrCreate(team.runnerId, team.devDirectory)).toEqual({});
  });
});
