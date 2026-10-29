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
import { ProjectRepository } from '../projects/projectRepository.js';
import { childEnvironmentForGit } from '../process/childEnvironment.js';
import { createTempDirTracker } from '../tempDirTracker.js';

const tempDirs = createTempDirTracker();
let daemon: Daemon;
let config: Config;

const adminApi = (path: string, init: RequestInit = {}) => fetch(`${daemon.server.url}${path}`, { ...init, headers: { 'content-type': 'application/json', authorization: `Bearer ${config.adminToken}` } });
const mcpTokenOf = (sessionId: string) => (daemon.db.prepare('SELECT mcp_token FROM sessions WHERE id = ?').get(sessionId) as { mcp_token: string }).mcp_token;
const parsed = (result: unknown) => JSON.parse((result as { content: { text: string }[] }).content[0]!.text);

async function connectAs(sessionId: string): Promise<Client> {
  const client = new Client({ name: 'qe', version: '0.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${daemon.server.url}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${mcpTokenOf(sessionId)}` } } }));
  return client;
}

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd, env: childEnvironmentForGit(process.env), encoding: 'utf8' }).trim();

async function bootTeam(branch = 'CCM-321-items') {
  const projectRepository = makeRepo();
  const created = (await (await adminApi('/api/sessions', { method: 'POST', body: JSON.stringify({ directory: projectRepository, name: 'Root', harness: 'fake', emoji: '🧭' }) })).json()) as { id: string };
  new ProjectRepository(daemon.db).insert({ id: 'p1', name: 'One', docsFolderPath: null, createdAt: 't0' });
  daemon.db.prepare('UPDATE sessions SET project_id = ? WHERE id = ?').run('p1', created.id);
  const leadDirectory = join(config.worktreesRoot, 'lead');
  mkdirSync(config.worktreesRoot, { recursive: true });
  git(projectRepository, 'worktree', 'add', '-b', 'lead', leadDirectory);
  const lead = parsed(await (await connectAs(created.id)).callTool({ name: 'create_session', arguments: { directory: leadDirectory, name: 'Lead', manager: { pulse_seconds: 3600, children_cap: 8, mission: 'm' } } }));
  const leadClient = await connectAs(lead.id);
  await leadClient.callTool({ name: 'get_manager_base', arguments: {} });
  const devDirectory = join(config.worktreesRoot, branch);
  git(projectRepository, 'worktree', 'add', '-b', branch, devDirectory);
  const spawn = async (role: string) => {
    const child = parsed(await leadClient.callTool({ name: 'create_session', arguments: { directory: devDirectory, name: role, role, allow_duplicate: true } }));
    return { id: child.id as string, client: await connectAs(child.id) };
  };
  return { devDirectory, spawn, headSha: git(devDirectory, 'rev-parse', 'HEAD') };
}

const readInCode = (claim: string) => ({ claim, status: 'not_reproduced' });
const reportStep = (client: Client, report: { step: string; severity: string; claims: unknown[]; sha: string }) => client.callTool({ name: 'report_step_finding', arguments: report });
const listedItems = async (ticket: string) => ((await (await adminApi(`/api/review-findings/items?ticket=${ticket}`)).json()) as { items: { reportId: string; position: number; step: string; severity: string; claim: string }[] }).items;

beforeEach(async () => {
  config = loadConfig({ OPENFLEET_HOME: tempDirs.make('of-finding-items-'), OPENFLEET_PORT: '0', [E2E_FLAG_ENV]: E2E_FLAG_ON });
  daemon = await startDaemon(config);
});
afterEach(async () => { await daemon.close(); tempDirs.removeAll(); });

describe('QE — structured reports create one finding row each', () => {
  it('a qe report with 2 findings creates 2 rows, listed by REST under the admin token', async () => {
    const { spawn, headSha } = await bootTeam();
    const qe = await spawn('qe');

    await reportStep(qe.client, { step: 'qe', severity: 'findings', claims: [readInCode('the filter is missing'), readInCode('a 500 on the stream')], sha: headSha });

    const items = await listedItems('CCM-321');
    expect(items.map((item) => [item.position, item.step, item.severity, item.claim])).toEqual([[0, 'qe', 'no-go', 'the filter is missing'], [1, 'qe', 'no-go', 'a 500 on the stream']]);
    expect(items[0]!.reportId).toBe(items[1]!.reportId);
  });

  it('the same report replayed creates no 2 rows more', async () => {
    const { spawn, headSha } = await bootTeam();
    const qe = await spawn('qe');
    const report = { step: 'qe', severity: 'findings', claims: [readInCode('the filter is missing'), readInCode('a 500 on the stream')], sha: headSha };

    await reportStep(qe.client, report);
    await reportStep(qe.client, report);

    expect(await listedItems('CCM-321')).toHaveLength(2);
  });

  it('a clean qa report creates one item per verified claim, with its run', async () => {
    const { spawn, headSha } = await bootTeam();
    const qa = await spawn('qa');

    await reportStep(qa.client, { step: 'qa', severity: 'clean', claims: [{ claim: 'qa: the page renders', status: 'proven', command: 'pnpm test', output: '12 passed' }], sha: headSha });

    expect(await listedItems('CCM-321')).toMatchObject([{ step: 'qa', severity: 'clean', claim: 'qa: the page renders', repro: { status: 'proven', command: 'pnpm test', output: '12 passed' } }]);
  });

  it('a reviewer verdict with reasons creates one adversarial row per reason', async () => {
    const { spawn, headSha } = await bootTeam();
    const reviewer = await spawn('reviewer');

    await reviewer.client.callTool({ name: 'report_ship_verdict', arguments: { verdict: 'no-go', reasons: [readInCode('a race'), readInCode('a leak')], sha: headSha } });

    expect((await listedItems('CCM-321')).map((item) => [item.step, item.claim])).toEqual([['adversarial', 'a race'], ['adversarial', 'a leak']]);
  });

  it('the listing needs the admin token', async () => {
    const withoutToken = await fetch(`${daemon.server.url}/api/review-findings/items?ticket=CCM-321`);

    expect(withoutToken.status).toBe(401);
  });
});
