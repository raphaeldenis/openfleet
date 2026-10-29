import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { E2E_FLAG_ENV, E2E_FLAG_ON } from '@openfleet/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig, type Config } from '../config.js';
import { startDaemon, type Daemon, type DaemonOptions } from '../daemon.js';
import { makeRepo } from '../git/testRepo.js';
import { ManagerRepository } from '../managers/managerRepository.js';
import { FINDINGS_GATE_ENFORCEMENT } from './findingsGate.js';
import { FINDINGS_GATE_RULE_ID } from '../policy/defaultCommandPolicy.js';
import { defaultCommandPolicySettings } from '../policy/commandPolicySettings.js';
import { childEnvironmentForGit } from '../process/childEnvironment.js';
import { createTempDirTracker } from '../tempDirTracker.js';
import { ReviewFindingsRepository, type FindingSeverity, type FindingStep } from './reviewFindingsRepository.js';

const tempDirs = createTempDirTracker();
let daemon: Daemon | undefined;
let config: Config;

interface HookAnswer { hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string } }

async function bootDaemon({ enforcement, configJson }: { enforcement?: 'observe' | 'enforce'; configJson?: unknown } = {}) {
  const home = tempDirs.make('of-findings-gate-');
  if (configJson !== undefined) writeFileSync(join(home, 'config.json'), JSON.stringify(configJson));
  config = loadConfig({ OPENFLEET_HOME: home, OPENFLEET_PORT: '0', [E2E_FLAG_ENV]: E2E_FLAG_ON });
  const options: DaemonOptions = { commandPolicy: { settings: defaultCommandPolicySettings() }, ...(enforcement === undefined ? {} : { findingsGateEnforcement: enforcement }) };
  daemon = await startDaemon(config, options);
}
afterEach(async () => { await daemon?.close(); daemon = undefined; tempDirs.removeAll(); });

const adminApi = (path: string, init: RequestInit = {}) => fetch(`${daemon!.server.url}${path}`, { ...init, headers: { 'content-type': 'application/json', authorization: `Bearer ${config.adminToken}`, ...(init.headers ?? {}) } });
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd, env: childEnvironmentForGit(process.env), encoding: 'utf8' }).trim();
const worktreeOnBranch = (branch: string) => {
  const directory = join(config.worktreesRoot, branch);
  git(makeRepo(), 'worktree', 'add', '-b', branch, directory);
  return directory;
};
const headOf = (directory: string) => git(directory, 'rev-parse', 'HEAD');
const commitIn = (directory: string) => git(directory, 'commit', '--allow-empty', '-m', 'next');

const bootChildIn = async (directory: string, { parentIsManager = true }: { parentIsManager?: boolean } = {}) => {
  const parent = (await (await adminApi('/api/sessions', { method: 'POST', body: JSON.stringify({ directory: '/tmp', name: 'Boss', harness: 'fake', emoji: '🤖' }) })).json()) as { id: string };
  if (parentIsManager) new ManagerRepository(daemon!.db).insert({ sessionId: parent.id, pulseSeconds: 3600, childrenCap: 8, missionText: 'm', createdAt: '2026-10-19T10:00:00.000Z' });
  const child = (await (await adminApi('/api/sessions', { method: 'POST', body: JSON.stringify({ directory, name: 'Worker', harness: 'fake', emoji: '🤖', parentId: parent.id, role: 'DEV' }) })).json()) as { id: string };
  return child.id;
};
const bootRootIn = async (directory: string) => {
  const root = (await (await adminApi('/api/sessions', { method: 'POST', body: JSON.stringify({ directory, name: 'Solo', harness: 'fake', emoji: '🤖' }) })).json()) as { id: string };
  return root.id;
};
const hookTokenOf =(sessionId: string) => (daemon!.db.prepare('SELECT hook_token FROM sessions WHERE id = ?').get(sessionId) as { hook_token: string }).hook_token;
const runCommand = async (sessionId: string, directory: string, command: string) =>
  (await (await fetch(`${daemon!.server.url}/hooks/${hookTokenOf(sessionId)}`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ hook_event_name: 'PreToolUse', session_id: 'cli-1', cwd: directory, tool_name: 'Bash', tool_input: { command } }),
  })).json()) as HookAnswer;
const openPullRequest = (sessionId: string, directory: string) => runCommand(sessionId, directory, 'gh pr create --fill');

const line = (ticket: string, step: FindingStep, severity: FindingSeverity, sha: string) => new ReviewFindingsRepository(daemon!.db)
  .record({ ticket, step, severity, claim: '', reasons: [], sha, authorSessionId: 'reviewer', managerSessionId: null, createdAt: '2026-10-17T10:00:00.000Z' });
const journalRows = () => daemon!.db.prepare('SELECT rule_id AS ruleId, outcome FROM denied_commands ORDER BY rowid').all() as { ruleId: string; outcome: string }[];
const JOURNALING_AFTER_THE_ANSWER_MS = 100;
/** The hook answers first and journals on the next turn of the event loop. */
const journaledGateRows = async () => {
  await new Promise((resolve) => setTimeout(resolve, JOURNALING_AFTER_THE_ANSWER_MS));
  return journalRows().filter((row) => row.ruleId === FINDINGS_GATE_RULE_ID);
};
const skip = (body: unknown) => adminApi('/api/review-findings/skips', { method: 'POST', body: JSON.stringify(body) });

const allStepsOpenAt = (ticket: string, sha: string) => {
  line(ticket, 'qe', 'clean', sha);
  line(ticket, 'qa', 'clean', sha);
  line(ticket, 'ponytail', 'clean', sha);
  line(ticket, 'adversarial', 'go', sha);
};

const bootInEnforce = async (branch = 'CCM-7-gate') => {
  await bootDaemon({ enforcement: 'enforce' });
  const directory = worktreeOnBranch(branch);
  return { directory, sessionId: await bootChildIn(directory) };
};

describe('QE — the findings gate on gh pr create, enforcing', () => {
  it('refuses a ticket without findings with findings_required, the ticket and where to log', async () => {
    const { directory, sessionId } = await bootInEnforce();

    const answer = await openPullRequest(sessionId, directory);

    expect(answer.hookSpecificOutput?.permissionDecision).toBe('deny');
    expect(answer.hookSpecificOutput?.permissionDecisionReason).toContain('findings_required');
    expect(answer.hookSpecificOutput?.permissionDecisionReason).toContain('CCM-7');
    expect(answer.hookSpecificOutput?.permissionDecisionReason).toContain('/api/review-findings/skips');
    expect(await journaledGateRows()).toEqual([{ ruleId: FINDINGS_GATE_RULE_ID, outcome: 'denied' }]);
  });

  it('opens when qe, qa and adversarial go sit at the head and ponytail somewhere on the branch', async () => {
    const { directory, sessionId } = await bootInEnforce();
    line('CCM-7', 'ponytail', 'clean', 'b'.repeat(40));
    line('CCM-7', 'qe', 'clean', headOf(directory));
    line('CCM-7', 'qa', 'clean', headOf(directory));
    line('CCM-7', 'adversarial', 'go', headOf(directory));

    const answer = await openPullRequest(sessionId, directory);

    expect(answer).toEqual({});
    expect(await journaledGateRows()).toEqual([]);
  });

  it('opens through a pipeline or an && chain the same way it refuses one', async () => {
    const { directory, sessionId } = await bootInEnforce();

    const refused = await runCommand(sessionId, directory, 'git push -u origin HEAD && gh pr create --fill');
    allStepsOpenAt('CCM-7', headOf(directory));
    const opened = await runCommand(sessionId, directory, 'git push -u origin HEAD && gh pr create --fill');

    expect(refused.hookSpecificOutput?.permissionDecision).toBe('deny');
    expect(opened).toEqual({});
  });

  it('refuses a no-go', async () => {
    const { directory, sessionId } = await bootInEnforce();
    allStepsOpenAt('CCM-7', headOf(directory));
    line('CCM-7', 'adversarial', 'no-go', headOf(directory));

    const answer = await openPullRequest(sessionId, directory);

    expect(answer.hookSpecificOutput?.permissionDecision).toBe('deny');
  });

  it('refuses when the adversarial line is missing', async () => {
    const { directory, sessionId } = await bootInEnforce();
    line('CCM-7', 'qe', 'clean', headOf(directory));
    line('CCM-7', 'qa', 'clean', headOf(directory));
    line('CCM-7', 'ponytail', 'clean', headOf(directory));

    const answer = await openPullRequest(sessionId, directory);

    expect(answer.hookSpecificOutput?.permissionDecisionReason).toContain('adversarial');
  });

  it('refuses when ponytail is missing', async () => {
    const { directory, sessionId } = await bootInEnforce();
    line('CCM-7', 'qe', 'clean', headOf(directory));
    line('CCM-7', 'qa', 'clean', headOf(directory));
    line('CCM-7', 'adversarial', 'go', headOf(directory));

    const answer = await openPullRequest(sessionId, directory);

    expect(answer.hookSpecificOutput?.permissionDecisionReason).toContain('ponytail');
  });

  it('refuses again after a new commit: the strict lines belonged to the previous head', async () => {
    const { directory, sessionId } = await bootInEnforce();
    allStepsOpenAt('CCM-7', headOf(directory));
    expect(await openPullRequest(sessionId, directory)).toEqual({});

    commitIn(directory);
    const answer = await openPullRequest(sessionId, directory);

    expect(answer.hookSpecificOutput?.permissionDecision).toBe('deny');
  });

  it('refuses a qe line recorded for another sha even when the others are at the head', async () => {
    const { directory, sessionId } = await bootInEnforce();
    line('CCM-7', 'qe', 'clean', 'c'.repeat(40));
    line('CCM-7', 'qa', 'clean', headOf(directory));
    line('CCM-7', 'ponytail', 'clean', headOf(directory));
    line('CCM-7', 'adversarial', 'go', headOf(directory));

    const answer = await openPullRequest(sessionId, directory);

    expect(answer.hookSpecificOutput?.permissionDecisionReason).toContain('qe');
  });

  it('lets a later go replace an earlier no-go at the same head', async () => {
    const { directory, sessionId } = await bootInEnforce();
    allStepsOpenAt('CCM-7', headOf(directory));
    line('CCM-7', 'adversarial', 'no-go', headOf(directory));
    line('CCM-7', 'adversarial', 'go', headOf(directory));

    expect(await openPullRequest(sessionId, directory)).toEqual({});
  });

  it('refuses a branch that names no ticket and says to name it with the ticket', async () => {
    const { directory, sessionId } = await bootInEnforce('plain-branch');

    const answer = await openPullRequest(sessionId, directory);

    expect(answer.hookSpecificOutput?.permissionDecision).toBe('deny');
    expect(answer.hookSpecificOutput?.permissionDecisionReason).toContain('findings_required');
    expect(answer.hookSpecificOutput?.permissionDecisionReason).toContain('ticket');
  });

  it('judges the ticket of the branch: the findings of another ticket do not open it', async () => {
    const { directory, sessionId } = await bootInEnforce();
    allStepsOpenAt('CCM-999', headOf(directory));

    const answer = await openPullRequest(sessionId, directory);

    expect(answer.hookSpecificOutput?.permissionDecision).toBe('deny');
  });

  it('does not touch commands that are not gh pr create', async () => {
    const { directory, sessionId } = await bootInEnforce();

    expect(await runCommand(sessionId, directory, 'gh pr list')).toEqual({});
    expect(await runCommand(sessionId, directory, 'git status')).toEqual({});
    expect(await journaledGateRows()).toEqual([]);
  });

  it.each([
    'gh api repos/o/r/pulls -X POST -f title=t -f head=CCM-7-gate -f base=main',
    'gh api repos/o/r/pulls --method=post -f title=t -f head=o:CCM-7-gate',
    'gh api repos/o/r/pulls -f title=t -F base=main',
    'glab mr create --fill',
    'glab mr create --source-branch CCM-7-gate --target-branch main',
  ])('refuses a child opening a request without findings through %s, with the same actionable message', async (command) => {
    const { directory, sessionId } = await bootInEnforce();

    const answer = await runCommand(sessionId, directory, command);

    const reason = answer.hookSpecificOutput?.permissionDecisionReason ?? '';
    expect(answer.hookSpecificOutput?.permissionDecision).toBe('deny');
    expect(reason).toContain('CCM-7');
    expect(reason).toContain('report_step_finding(');
    expect(reason).toContain('/api/review-findings/skips');
  });

  it.each([
    'gh api repos/o/r/pulls',
    'gh api repos/o/r/pulls -X GET -f state=open',
    'gh api repos/o/r/pulls/12/comments -f body=x',
    'gh api repos/o/r/issues -f title=t',
    'gh api -X POST repos/o/r/issues/1/comments -f body=x',
    'glab mr list',
    'glab mr view 3',
  ])('never blocks %s: only a request creation is judged', async (command) => {
    const { directory, sessionId } = await bootInEnforce();

    expect(await runCommand(sessionId, directory, command)).toEqual({});
    expect(await journaledGateRows()).toEqual([]);
  });

  it('opens gh api and glab creations once the ticket has its findings', async () => {
    const { directory, sessionId } = await bootInEnforce();
    allStepsOpenAt('CCM-7', headOf(directory));

    expect(await runCommand(sessionId, directory, 'gh api repos/o/r/pulls -f title=t -f head=CCM-7-gate')).toEqual({});
    expect(await runCommand(sessionId, directory, 'glab mr create --fill')).toEqual({});
  });

  it('writes no review table: the child that runs gh pr create leaves every table as it was', async () => {
    const { directory, sessionId } = await bootInEnforce();
    const count = () => daemon!.db.prepare('SELECT (SELECT COUNT(*) FROM review_findings) AS findings, (SELECT COUNT(*) FROM review_step_skips) AS skips').get();
    const before = count();

    await openPullRequest(sessionId, directory);

    expect(count()).toEqual(before);
  });
});

describe('QE — the findings gate, enforcing (the shipped mode)', () => {
  it('ships enforcing', () => {
    expect(FINDINGS_GATE_ENFORCEMENT).toBe('enforce');
  });

  it('refuses with the ticket, the missing steps and the endpoint, journals denied and blocks the command, with no option and no setting', async () => {
    await bootDaemon();
    const directory = worktreeOnBranch('CCM-7-gate');
    const sessionId = await bootChildIn(directory);

    const answer = await openPullRequest(sessionId, directory);

    expect(answer.hookSpecificOutput?.permissionDecision).toBe('deny');
    expect(answer.hookSpecificOutput?.permissionDecisionReason).toContain('findings_required');
    expect(answer.hookSpecificOutput?.permissionDecisionReason).toContain('CCM-7');
    expect(answer.hookSpecificOutput?.permissionDecisionReason).toContain('qe, qa, ponytail, adversarial go');
    expect(answer.hookSpecificOutput?.permissionDecisionReason).toContain('/api/review-findings/skips');
    expect(await journaledGateRows()).toEqual([{ ruleId: FINDINGS_GATE_RULE_ID, outcome: 'denied' }]);
  });

  it('tells a child the exact report tools and the token-free skip command for the missing steps', async () => {
    await bootDaemon();
    const directory = worktreeOnBranch('CCM-7-gate');
    const sessionId = await bootChildIn(directory);

    const answer = await openPullRequest(sessionId, directory);

    const reason = answer.hookSpecificOutput?.permissionDecisionReason ?? '';
    expect(reason).toContain('CCM-7');
    expect(reason).toContain('qe, qa, ponytail, adversarial go');
    expect(reason).toContain(`report_step_finding({ step: "qe" | "qa" | "ponytail", severity, claims: [...], sha: "${headOf(directory)}" })`);
    expect(reason).toContain(`report_ship_verdict({ verdict: "go", reasons: [...], sha: "${headOf(directory)}" })`);
    expect(reason).toContain('curl -X POST <daemon-url>/api/review-findings/skips');
    expect(reason).toContain('with the admin token');
    expect(reason).not.toContain(config.adminToken);
  });

  it('refuses a branch without ticket for a session run by a manager', async () => {
    await bootDaemon();
    const directory = worktreeOnBranch('plain-branch');
    const sessionId = await bootChildIn(directory);

    const answer = await openPullRequest(sessionId, directory);

    expect(answer.hookSpecificOutput?.permissionDecisionReason).toContain('names no ticket');
  });

  it('does not judge a session without parent: the command passes and nothing is journaled', async () => {
    await bootDaemon();
    const directory = worktreeOnBranch('plain-branch');
    const sessionId = await bootRootIn(directory);

    expect(await openPullRequest(sessionId, directory)).toEqual({});
    expect(await journaledGateRows()).toEqual([]);
  });

  it('does not judge a session whose parent is not a manager', async () => {
    await bootDaemon();
    const directory = worktreeOnBranch('CCM-7-gate');
    const sessionId = await bootChildIn(directory, { parentIsManager: false });

    expect(await openPullRequest(sessionId, directory)).toEqual({});
    expect(await journaledGateRows()).toEqual([]);
  });

  it('opens by default once the steps are reported at the head', async () => {
    await bootDaemon();
    const directory = worktreeOnBranch('CCM-7-gate');
    const sessionId = await bootChildIn(directory);
    allStepsOpenAt('CCM-7', headOf(directory));

    expect(await openPullRequest(sessionId, directory)).toEqual({});
    expect(await journaledGateRows()).toEqual([]);
  });
});

describe('QE — the findings gate, observing (by option or by setting)', () => {
  it('lets the command pass and journals the would-be refusal as observed', async () => {
    await bootDaemon({ enforcement: 'observe' });
    const directory = worktreeOnBranch('CCM-7-gate');
    const sessionId = await bootChildIn(directory);

    const answer = await openPullRequest(sessionId, directory);

    expect(answer).toEqual({});
    expect(await journaledGateRows()).toEqual([{ ruleId: FINDINGS_GATE_RULE_ID, outcome: 'observed' }]);
  });

  it('journals nothing when the gate is open', async () => {
    await bootDaemon({ enforcement: 'observe' });
    const directory = worktreeOnBranch('CCM-7-gate');
    const sessionId = await bootChildIn(directory);
    allStepsOpenAt('CCM-7', headOf(directory));

    expect(await openPullRequest(sessionId, directory)).toEqual({});
    expect(await journaledGateRows()).toEqual([]);
  });

  it('also observes a branch without ticket', async () => {
    await bootDaemon({ enforcement: 'observe' });
    const directory = worktreeOnBranch('plain-branch');
    const sessionId = await bootChildIn(directory);

    expect(await openPullRequest(sessionId, directory)).toEqual({});
    expect(await journaledGateRows()).toEqual([{ ruleId: FINDINGS_GATE_RULE_ID, outcome: 'observed' }]);
  });

  it('is switched to observe by the findingsGate.enforcement setting', async () => {
    await bootDaemon({ configJson: { findingsGate: { enforcement: 'observe' } } });
    const directory = worktreeOnBranch('CCM-7-gate');
    const sessionId = await bootChildIn(directory);

    expect(await openPullRequest(sessionId, directory)).toEqual({});
    expect(await journaledGateRows()).toEqual([{ ruleId: FINDINGS_GATE_RULE_ID, outcome: 'observed' }]);
  });

  it('lets the daemon option enforce over a setting that observes', async () => {
    await bootDaemon({ enforcement: 'enforce', configJson: { findingsGate: { enforcement: 'observe' } } });
    const directory = worktreeOnBranch('CCM-7-gate');
    const sessionId = await bootChildIn(directory);

    expect((await openPullRequest(sessionId, directory)).hookSpecificOutput?.permissionDecision).toBe('deny');
  });
});

describe('QE — step_skipped, a human act', () => {
  it('opens the gate for a skipped qa and traces the skip with its reason', async () => {
    const { directory, sessionId } = await bootInEnforce();
    line('CCM-7', 'qe', 'clean', headOf(directory));
    line('CCM-7', 'ponytail', 'clean', headOf(directory));
    line('CCM-7', 'adversarial', 'go', headOf(directory));
    expect((await openPullRequest(sessionId, directory)).hookSpecificOutput?.permissionDecision).toBe('deny');

    const created = await skip({ ticket: 'CCM-7', step: 'qa', reason: 'no browser on this project' });
    const listed = (await (await adminApi('/api/review-findings/skips?ticket=CCM-7')).json()) as { items: { ticket: string; step: string; reason: string; createdAt: string }[] };

    expect(created.status).toBe(201);
    expect(listed.items).toEqual([expect.objectContaining({ ticket: 'CCM-7', step: 'qa', reason: 'no browser on this project', createdAt: expect.any(String) })]);
    expect(await openPullRequest(sessionId, directory)).toEqual({});
  });

  it('traces a skip with its author and the head it applies to, and the gate behaves as before', async () => {
    const { directory, sessionId } = await bootInEnforce();
    line('CCM-7', 'qe', 'clean', headOf(directory));
    line('CCM-7', 'ponytail', 'clean', headOf(directory));
    line('CCM-7', 'adversarial', 'go', headOf(directory));

    const created = await skip({ ticket: 'CCM-7', step: 'qa', reason: 'no browser on this project', sha: headOf(directory) });
    const listed = (await (await adminApi('/api/review-findings/skips?ticket=CCM-7')).json()) as { items: unknown[] };

    expect(created.status).toBe(201);
    expect(listed.items).toEqual([expect.objectContaining({ ticket: 'CCM-7', step: 'qa', author: 'human', headSha: headOf(directory) })]);
    expect(daemon!.db.prepare('SELECT author, head_sha AS headSha FROM review_step_skips').all()).toEqual([{ author: 'human', headSha: headOf(directory) }]);
    expect(await openPullRequest(sessionId, directory)).toEqual({});
  });

  it('keeps a skip without sha valid: no head recorded, the author still human', async () => {
    await bootInEnforce();

    const created = await skip({ ticket: 'CCM-7', step: 'qa', reason: 'no browser' });

    expect(created.status).toBe(201);
    expect(daemon!.db.prepare('SELECT author, head_sha AS headSha FROM review_step_skips').all()).toEqual([{ author: 'human', headSha: null }]);
  });

  it('opens qe, qa and ponytail by skips alone but still asks for the adversarial go', async () => {
    const { directory, sessionId } = await bootInEnforce();
    await skip({ ticket: 'CCM-7', step: 'qe', reason: 'no suite' });
    await skip({ ticket: 'CCM-7', step: 'qa', reason: 'no browser' });
    await skip({ ticket: 'CCM-7', step: 'ponytail', reason: 'trivial' });

    const closed = await openPullRequest(sessionId, directory);
    line('CCM-7', 'adversarial', 'go', headOf(directory));
    const opened = await openPullRequest(sessionId, directory);

    expect(closed.hookSpecificOutput?.permissionDecisionReason).toContain('lacks adversarial go.');
    expect(opened).toEqual({});
  });

  it('never skips the adversarial review', async () => {
    await bootDaemon();

    const response = await skip({ ticket: 'CCM-7', step: 'adversarial', reason: 'in a hurry' });

    expect(response.status).toBe(400);
  });

  it('refuses a skip without a reason', async () => {
    await bootDaemon();

    expect((await skip({ ticket: 'CCM-7', step: 'qa', reason: '  ' })).status).toBe(400);
    expect((await skip({ ticket: 'CCM-7', step: 'qa' })).status).toBe(400);
  });

  it('is out of reach of a session: the mcp token gets 401 and no tool creates a skip', async () => {
    await bootDaemon();
    const directory = worktreeOnBranch('CCM-7-gate');
    const sessionId = await bootChildIn(directory);
    const mcpToken = (daemon!.db.prepare('SELECT mcp_token FROM sessions WHERE id = ?').get(sessionId) as { mcp_token: string }).mcp_token;

    const withSessionToken = await fetch(`${daemon!.server.url}/api/review-findings/skips`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${mcpToken}` }, body: JSON.stringify({ ticket: 'CCM-7', step: 'qa', reason: 'sneaky' }) });
    const asMcpRoute = await fetch(`${daemon!.server.url}/mcp/api/review-findings/skips`, { method: 'POST', headers: { authorization: `Bearer ${mcpToken}` } });

    expect(withSessionToken.status).toBe(401);
    expect(asMcpRoute.status).not.toBe(201);
    expect(daemon!.db.prepare('SELECT COUNT(*) AS n FROM review_step_skips').get()).toEqual({ n: 0 });
  });
});

describe('QE — findingsGate.ticketPattern', () => {
  it('reads the ticket of a branch with the configured pattern', async () => {
    await bootDaemon({ enforcement: 'enforce', configJson: { findingsGate: { ticketPattern: 'OF[0-9]+' } } });
    const directory = worktreeOnBranch('OF42-gate');
    const sessionId = await bootChildIn(directory);
    allStepsOpenAt('OF42', headOf(directory));

    expect(await openPullRequest(sessionId, directory)).toEqual({});
  });

  it('refuses a pattern that is not a valid regular expression at boot', async () => {
    await expect(bootDaemon({ configJson: { findingsGate: { ticketPattern: '(' } } })).rejects.toThrow(/ticketPattern/);
  });
});
