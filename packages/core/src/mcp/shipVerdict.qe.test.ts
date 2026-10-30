import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { E2E_FLAG_ENV, E2E_FLAG_ON, REPRO_CLAIM_EXAMPLE, SHAPE_MESSAGE } from '@openfleet/shared';
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
const rawText = (result: unknown) => (result as { content: { text: string }[] }).content[0]!.text;
const parsed = (result: unknown) => JSON.parse(rawText(result));

let connectedClients: Client[] = [];

async function connectAs(sessionId: string): Promise<Client> {
  const client = new Client({ name: 'qe', version: '0.0.0' });
  connectedClients.push(client);
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

/** The DEV's worktree: a branch named after its ticket, checked out under the worktrees root. */
const worktreeOnBranch = (branch: string) => {
  const repo = makeRepo();
  const directory = join(config.worktreesRoot, branch);
  git(repo, 'worktree', 'add', '-b', branch, directory);
  return directory;
};

const headOf = (directory: string) => git(directory, 'rev-parse', 'HEAD');
const commitIn = (directory: string) => git(directory, 'commit', '--allow-empty', '-m', 'next');

async function bootRootSession() {
  // The project root works in the worktrees root, so every child directory made below it belongs to the project.
  mkdirSync(config.worktreesRoot, { recursive: true });
  const created = (await (await adminApi('/api/sessions', { method: 'POST', body: JSON.stringify({ directory: config.worktreesRoot, name: 'Root', harness: 'fake', emoji: '🧭' }) })).json()) as { id: string };
  new ProjectRepository(daemon.db).insert({ id: 'p1', name: 'One', docsFolderPath: null, createdAt: 't0' });
  daemon.db.prepare('UPDATE sessions SET project_id = ? WHERE id = ?').run('p1', created.id);
  return created.id;
}

async function bootLead() {
  const rootId = await bootRootSession();
  const root = await connectAs(rootId);
  const lead = parsed(await root.callTool({ name: 'create_session', arguments: { directory: emptyDirectory('lead'), name: 'Lead', manager: { pulse_seconds: 3600, children_cap: 4, mission: 'm' } } }));
  const leadClient = await connectAs(lead.id);
  await leadClient.callTool({ name: 'get_manager_base', arguments: {} });
  return { root, lead, leadClient };
}

/** A reviewer the lead spawns inside the DEV's worktree, the normal case. */
async function bootReviewerInDevWorktree(branch = 'CCM-123-verdict') {
  const { root, lead, leadClient } = await bootLead();
  const devDirectory = worktreeOnBranch(branch);
  const reviewer = parsed(await leadClient.callTool({ name: 'create_session', arguments: { directory: devDirectory, name: 'Reviewer', role: 'reviewer' } }));
  return { root, lead, leadClient, devDirectory, reviewer, reviewerClient: await connectAs(reviewer.id) };
}

const readInCode = (claim: string) => ({ claim, status: 'not_reproduced' });
const provenClaim = (claim: string) => ({ claim, status: 'proven', command: 'pnpm vitest run migrate.test.ts', output: 'FAIL down migration\nexpected the table back' });
const verifiedRun = { claim: 'adversarial: no blocking defect found', status: 'proven', command: 'pnpm test', output: '321 passed' };
const fakeToken =['gh', 'p_'].join('') + 'abcdefghijklmnopqrstuvwxyz0123456789';
const storedRepros = () => daemon.db.prepare('SELECT step, claim, repro_status AS status, repro_command AS command, repro_output AS output FROM review_finding_items ORDER BY id').all() as Record<string, unknown>[];
const reportVerdict = (client: Client, verdict: { verdict: string; reasons: unknown[]; sha: string }) => client.callTool({ name: 'report_ship_verdict', arguments: verdict });
const findingRows = () => daemon.db.prepare('SELECT ticket, step, severity, claim, sha, author_session_id AS authorSessionId, manager_session_id AS managerSessionId FROM review_findings ORDER BY id').all() as Record<string, unknown>[];
const messagesQueuedFor = (sessionId: string) => (daemon.db.prepare("SELECT body, from_session_id AS fromSessionId FROM message_queue WHERE session_id = ? AND body LIKE '%[verdict]%'").all(sessionId) as { body: string; fromSessionId: string | null }[]);
const verdictLinesOf = (body: string) => body.split('\n').filter((line) => line.startsWith('[verdict]'));
const toolNamesOf = async (client: Client) => (await client.listTools()).tools.map((tool) => tool.name).sort();

beforeEach(async () => {
  const home = tempDirs.make('of-ship-verdict-');
  config = loadConfig({ OPENFLEET_HOME: home, OPENFLEET_PORT: '0', [E2E_FLAG_ENV]: E2E_FLAG_ON });
  const settings = defaultCommandPolicySettings();
  daemon = await startDaemon(config, { commandPolicy: { settings: { ...settings, unattended: { ...settings.unattended, askBecomesDeny: false } } } });
});
/** Closing the MCP clients before the daemon leaves no pooled keep-alive socket for a later daemon on a reused ephemeral port to meet. */
const closeConnectedClients = async () => {
  const clientsToClose = connectedClients;
  connectedClients = [];
  await Promise.allSettled(clientsToClose.map((client) => client.close()));
};

afterEach(async () => { await closeConnectedClients(); await daemon.close(); tempDirs.removeAll(); });

describe('QE — report_ship_verdict on a booted daemon', () => {
  it('a reviewer launched in the DEV worktree records a go at the head: the daemon writes the line, the gate reads open', async () => {
    const { reviewer, reviewerClient, lead, devDirectory } = await bootReviewerInDevWorktree();
    const head = headOf(devDirectory);

    const result = await reportVerdict(reviewerClient, { verdict: 'go', reasons: [verifiedRun], sha: head });

    expect(result.isError).toBeFalsy();
    expect(parsed(result)).toEqual({ recorded: true, gate: 'open' });
    expect(findingRows()).toEqual([{ ticket: 'CCM-123', step: 'adversarial', severity: 'go', claim: 'adversarial: no blocking defect found', sha: head, authorSessionId: reviewer.id, managerSessionId: lead.id }]);
    expect(messagesQueuedFor(lead.id)).toEqual([]);
  });

  it('a no-go records its reasons, closes the gate, tells the manager every reason and lists the ticket in get_argus_status', async () => {
    const { leadClient, lead, reviewer, reviewerClient, devDirectory } = await bootReviewerInDevWorktree();
    const head = headOf(devDirectory);

    const result = await reportVerdict(reviewerClient, { verdict: 'no-go', reasons: [provenClaim('migration 033 cannot be rolled back'), readInCode('the new env var is undocumented')], sha: head });

    expect(parsed(result)).toEqual({ recorded: true, gate: 'blocked' });
    expect(findingRows()).toMatchObject([{ ticket: 'CCM-123', severity: 'no-go', claim: 'migration 033 cannot be rolled back; the new env var is undocumented', sha: head }]);
    const [message] = messagesQueuedFor(lead.id);
    expect(verdictLinesOf(message!.body)).toEqual([`[verdict] no-go CCM-123 @ ${head.slice(0, 8)}: migration 033 cannot be rolled back [PROUVÉ]; the new env var is undocumented [NON REPRODUIT]`]);
    expect(message!.body).not.toContain('expected the table back');
    expect(message!.fromSessionId).toBe(reviewer.id);
    const status = parsed(await leadClient.callTool({ name: 'get_argus_status', arguments: {} }));
    expect(status.blockedTickets).toEqual([{ ticket: 'CCM-123', sha: head, reasons: ['migration 033 cannot be rolled back', 'the new env var is undocumented'] }]);
    expect(status.manager).not.toHaveProperty('blockedTickets');
  });

  it('a later go on the new head lifts the ticket from blockedTickets', async () => {
    const { leadClient, reviewerClient, devDirectory } = await bootReviewerInDevWorktree();
    await reportVerdict(reviewerClient, { verdict: 'no-go', reasons: [readInCode('broken')], sha: headOf(devDirectory) });
    commitIn(devDirectory);

    await reportVerdict(reviewerClient, { verdict: 'go', reasons: [verifiedRun], sha: headOf(devDirectory) });

    const status = parsed(await leadClient.callTool({ name: 'get_argus_status', arguments: {} }));
    expect(status.blockedTickets).toEqual([]);
  });

  it('get_argus_status lists no blocked ticket for a manager whose children never reported', async () => {
    const { leadClient } = await bootLead();

    const status = parsed(await leadClient.callTool({ name: 'get_argus_status', arguments: {} }));

    expect(status.blockedTickets).toEqual([]);
  });

  it('a sha that is not the head of the reviewer worktree is refused with verdict_stale and leaves no line and no message', async () => {
    const { lead, reviewerClient, devDirectory } = await bootReviewerInDevWorktree();
    const staleHead = headOf(devDirectory);
    commitIn(devDirectory);

    const result = await reportVerdict(reviewerClient, { verdict: 'no-go', reasons: [readInCode('too late')], sha: staleHead });

    expect(result.isError).toBe(true);
    expect(rawText(result)).toMatch(/^error verdict_stale: .* \(retry: never\)$/);
    expect(findingRows()).toEqual([]);
    expect(messagesQueuedFor(lead.id)).toEqual([]);
  });

  it('a reason with a secret and a line break reaches the manager masked on one line', async () => {
    const { lead, reviewerClient, devDirectory } = await bootReviewerInDevWorktree();

    await reportVerdict(reviewerClient, { verdict: 'no-go', reasons: [readInCode(`token ${fakeToken} leaked\nin the log`)], sha: headOf(devDirectory) });

    const [message] = messagesQueuedFor(lead.id);
    expect(message!.body).not.toContain(fakeToken);
    expect(verdictLinesOf(message!.body)).toHaveLength(1);
    expect(verdictLinesOf(message!.body)[0]).toContain('in the log');
  });

  it.each([
    ['a no-go without reason', { verdict: 'no-go', reasons: [] as unknown[] }],
    ['six reasons', { verdict: 'no-go', reasons: ['a', 'b', 'c', 'd', 'e', 'f'].map(readInCode) }],
    ['a go without claim', { verdict: 'go', reasons: [] as unknown[] }],
    ['a go whose claims were only read in the code', { verdict: 'go', reasons: [readInCode('src/a.ts is fine')] }],
    ['a go whose only claim is made of invisible characters', { verdict: 'go', reasons: [{ ...verifiedRun, claim: '​‮' }] }],
    ['a no-go whose reason is made of invisible characters', { verdict: 'no-go', reasons: [readInCode('﻿⁠')] }],
    ['an unknown verdict', { verdict: 'maybe', reasons: [] as unknown[] }],
    ['a plain text reason', { verdict: 'no-go', reasons: ['broken'] }],
    ['a proven reason without output', { verdict: 'no-go', reasons: [{ claim: 'c', status: 'proven', command: 'pnpm test' }] }],
    ['a reason without status', { verdict: 'no-go', reasons: [{ claim: 'c', command: 'pnpm test', output: 'red' }] }],
  ])('refuses %s with invalid_body and writes nothing', async (_name, shape) => {
    const { lead, reviewerClient, devDirectory } = await bootReviewerInDevWorktree();

    const result = await reportVerdict(reviewerClient, { ...shape, sha: headOf(devDirectory) });

    expect(result.isError).toBe(true);
    expect(rawText(result)).toMatch(/^error invalid_body: /);
    expect(findingRows()).toEqual([]);
    expect(storedRepros()).toEqual([]);
    expect(messagesQueuedFor(lead.id)).toEqual([]);
  });

  it('shows a complete example of the new form to a reviewer that still sends plain text reasons', async () => {
    const { reviewerClient, devDirectory } = await bootReviewerInDevWorktree();

    const result = await reportVerdict(reviewerClient, { verdict: 'no-go', reasons: ['broken'], sha: headOf(devDirectory) });

    expect(rawText(result)).toMatch(/\{ claim: ".*", status: "proven", command: ".*", output: ".*" \}/);
  });

  it('keeps the whole instruction of the new form when three former plain text reasons are refused', async () => {
    const { reviewerClient, devDirectory } = await bootReviewerInDevWorktree();

    const result = await reportVerdict(reviewerClient, { verdict: 'no-go', reasons: ['broken', 'slow', 'leaky'], sha: headOf(devDirectory) });

    expect(rawText(result)).toContain(SHAPE_MESSAGE);
    expect(rawText(result)).toContain(REPRO_CLAIM_EXAMPLE);
    expect(rawText(result)).not.toContain('…');
  });

  it('records the reproduction of each reason next to its adversarial item, masked and without the secret', async () => {
    const { reviewerClient, devDirectory } = await bootReviewerInDevWorktree();
    const leaking = { claim: 'leak', status: 'proven', command: `curl -H "x: ${fakeToken}"`, output: `sent ${fakeToken}\nsecond line` };

    await reportVerdict(reviewerClient, { verdict: 'no-go', reasons: [provenClaim('migration 033 cannot be rolled back'), leaking], sha: headOf(devDirectory) });

    const [first, second] = storedRepros();
    expect(first).toEqual({ step: 'adversarial', claim: 'migration 033 cannot be rolled back', status: 'proven', command: 'pnpm vitest run migrate.test.ts', output: 'FAIL down migration\nexpected the table back' });
    expect(JSON.stringify(second)).not.toContain(fakeToken);
    expect(second!.output).toMatch(/\nsecond line$/);
  });

  it('refuses a sha that is not 40 lowercase hex characters', async () => {
    const { reviewerClient } = await bootReviewerInDevWorktree();

    const result = await reportVerdict(reviewerClient, { verdict: 'go', reasons: [verifiedRun], sha: 'abc1234' });

    expect(result.isError).toBe(true);
    expect(findingRows()).toEqual([]);
  });

  it('refuses a worktree whose branch names no ticket and tells how to name it', async () => {
    const { reviewerClient, devDirectory } = await bootReviewerInDevWorktree('cleanup-without-ticket');

    const result = await reportVerdict(reviewerClient, { verdict: 'go', reasons: [verifiedRun], sha: headOf(devDirectory) });

    expect(rawText(result)).toMatch(/^error invalid_body: .*ticket/i);
    expect(findingRows()).toEqual([]);
  });

  it('refuses a plain worker that is not a reviewer with not_a_manager', async () => {
    const { leadClient, devDirectory } = await bootReviewerInDevWorktree();
    const worker = parsed(await leadClient.callTool({ name: 'create_session', arguments: { directory: emptyDirectory('worker'), name: 'Worker' } }));
    const workerClient = await connectAs(worker.id);

    const result = await reportVerdict(workerClient, { verdict: 'go', reasons: [verifiedRun], sha: headOf(devDirectory) });

    expect(rawText(result)).toMatch(/^error not_a_manager: /);
    expect(findingRows()).toEqual([]);
  });

  it('refuses a child that declares the reviewer role under a parent that is not a manager', async () => {
    const { leadClient } = await bootLead();
    const worker = parsed(await leadClient.callTool({ name: 'create_session', arguments: { directory: emptyDirectory('worker'), name: 'Worker' } }));
    const workerClient = await connectAs(worker.id);
    const devDirectory = worktreeOnBranch('CCM-777-impostor');
    const impostor = parsed(await workerClient.callTool({ name: 'create_session', arguments: { directory: devDirectory, name: 'Impostor', role: 'reviewer' } }));
    const impostorClient = await connectAs(impostor.id);

    const result = await reportVerdict(impostorClient, { verdict: 'go', reasons: [verifiedRun], sha: headOf(devDirectory) });

    expect(rawText(result)).toMatch(/^error not_a_manager: /);
    expect(findingRows()).toEqual([]);
  });
});

describe('QE — the reviewer tool profile', () => {
  it('a reviewer sees report_ship_verdict and message_parent and nothing else', async () => {
    const { reviewerClient } = await bootReviewerInDevWorktree();

    const toolNames = await toolNamesOf(reviewerClient);

    expect(toolNames).toEqual(['message_parent', 'report_ship_verdict']);
  });

  it('a reviewer cannot write a table, a note or spawn a session', async () => {
    const { reviewerClient } = await bootReviewerInDevWorktree();

    const attempts = await Promise.all([
      reviewerClient.callTool({ name: 'insert_data_store_rows', arguments: { store: 's', rows: [{}] } }),
      reviewerClient.callTool({ name: 'create_note', arguments: { title: 'N', body_md: 'x' } }),
      reviewerClient.callTool({ name: 'create_session', arguments: { directory: emptyDirectory('x'), name: 'X' } }),
    ]);

    for (const attempt of attempts) expect(attempt.isError).toBe(true);
  });

  it('a reviewer can still message its manager', async () => {
    const { reviewerClient, lead } = await bootReviewerInDevWorktree();

    const result = await reviewerClient.callTool({ name: 'message_parent', arguments: { body: 'done' } });

    expect(result.isError).toBeFalsy();
    expect(daemon.db.prepare('SELECT COUNT(*) AS n FROM message_queue WHERE session_id = ?').get(lead.id)).toMatchObject({ n: expect.any(Number) });
  });

  it('any other role keeps its whole registry: tables, notes, sessions and the verdict tool', async () => {
    const { leadClient, root } = await bootReviewerInDevWorktree();
    const worker = parsed(await leadClient.callTool({ name: 'create_session', arguments: { directory: emptyDirectory('w'), name: 'W', role: 'dev' } }));
    const workerClient = await connectAs(worker.id);

    const workerTools = await toolNamesOf(workerClient);
    const leadTools = await toolNamesOf(leadClient);
    const rootTools = await toolNamesOf(root);

    for (const tools of [workerTools, leadTools, rootTools]) {
      expect(tools).toEqual(expect.arrayContaining(['insert_data_store_rows', 'create_note', 'create_session', 'get_argus_status', 'message_parent', 'report_ship_verdict']));
    }
    expect(workerTools).toEqual(rootTools);
  });
});
