import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { E2E_FLAG_ENV, E2E_FLAG_ON } from '@openfleet/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig, type Config } from '../config.js';
import { startDaemon, type Daemon } from '../daemon.js';
import { makeRepo } from '../git/testRepo.js';
import { ManagerRepository } from '../managers/managerRepository.js';
import { FINDINGS_GATE_RULE_ID } from '../policy/defaultCommandPolicy.js';
import { defaultCommandPolicySettings } from '../policy/commandPolicySettings.js';
import { childEnvironmentForGit } from '../process/childEnvironment.js';
import { createTempDirTracker } from '../tempDirTracker.js';
import { ReviewFindingsRepository, type FindingSeverity, type FindingStep } from './reviewFindingsRepository.js';

const tempDirs = createTempDirTracker();
let daemon: Daemon | undefined;
let config: Config;

interface HookAnswer { hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string } }

const SESSION_BRANCH = 'CCM-7-session';
const HEAD_BRANCH = 'CCM-8-head';

async function bootDaemon(enforcement: 'observe' | 'enforce') {
  const home = tempDirs.make('of-findings-gate-head-');
  config = loadConfig({ OPENFLEET_HOME: home, OPENFLEET_PORT: '0', [E2E_FLAG_ENV]: E2E_FLAG_ON });
  daemon = await startDaemon(config, { commandPolicy: { settings: defaultCommandPolicySettings() }, findingsGateEnforcement: enforcement });
}
afterEach(async () => { await daemon?.close(); daemon = undefined; tempDirs.removeAll(); });

const adminApi = (path: string, init: RequestInit = {}) => fetch(`${daemon!.server.url}${path}`, { ...init, headers: { 'content-type': 'application/json', authorization: `Bearer ${config.adminToken}`, ...(init.headers ?? {}) } });
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd, env: childEnvironmentForGit(process.env), encoding: 'utf8' }).trim();

/** One repository, a worktree on the session branch (where the command runs), and the head branch either checked out elsewhere, only a ref, or absent. */
const repoWithSessionWorktree = ({ headBranch }: { headBranch: 'checked-out' | 'absent' }) => {
  const repo = makeRepo();
  const sessionDirectory = join(config.worktreesRoot, SESSION_BRANCH);
  git(repo, 'worktree', 'add', '-b', SESSION_BRANCH, sessionDirectory);
  if (headBranch === 'checked-out') git(repo, 'worktree', 'add', '-b', HEAD_BRANCH, join(config.worktreesRoot, HEAD_BRANCH));
  return { sessionDirectory, headDirectory: join(config.worktreesRoot, HEAD_BRANCH) };
};
const headOf = (directory: string) => git(directory, 'rev-parse', 'HEAD');

const bootChildIn = async (directory: string) => {
  const parent = (await (await adminApi('/api/sessions', { method: 'POST', body: JSON.stringify({ directory: '/tmp', name: 'Boss', harness: 'fake', emoji: '🤖' }) })).json()) as { id: string };
  new ManagerRepository(daemon!.db).insert({ sessionId: parent.id, pulseSeconds: 3600, childrenCap: 8, missionText: 'm', createdAt: '2026-10-19T10:00:00.000Z' });
  const child = (await (await adminApi('/api/sessions', { method: 'POST', body: JSON.stringify({ directory, name: 'Worker', harness: 'fake', emoji: '🤖', parentId: parent.id, role: 'DEV' }) })).json()) as { id: string };
  return child.id;
};
const hookTokenOf = (sessionId: string) => (daemon!.db.prepare('SELECT hook_token FROM sessions WHERE id = ?').get(sessionId) as { hook_token: string }).hook_token;
const runCommand = async (sessionId: string, directory: string, command: string) =>
  (await (await fetch(`${daemon!.server.url}/hooks/${hookTokenOf(sessionId)}`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ hook_event_name: 'PreToolUse', session_id: 'cli-1', cwd: directory, tool_name: 'Bash', tool_input: { command } }),
  })).json()) as HookAnswer;

const line = (ticket: string, step: FindingStep, severity: FindingSeverity, sha: string) => new ReviewFindingsRepository(daemon!.db)
  .record({ ticket, step, severity, claim: 'ran the checks of the step', reasons: ['ran the checks of the step'], repros: [{ status: 'proven', command: 'pnpm test', output: '321 passed' }], sha, authorSessionId: 'reviewer', managerSessionId: null, createdAt: '2026-10-17T10:00:00.000Z' });
const allStepsOpenAt = (ticket: string, sha: string) => {
  line(ticket, 'qe', 'clean', sha);
  line(ticket, 'qa', 'clean', sha);
  line(ticket, 'ponytail', 'clean', sha);
  line(ticket, 'adversarial', 'go', sha);
};
const JOURNALING_AFTER_THE_ANSWER_MS = 100;
const journaledGateRows = async () => {
  await new Promise((resolve) => setTimeout(resolve, JOURNALING_AFTER_THE_ANSWER_MS));
  return (daemon!.db.prepare('SELECT rule_id AS ruleId, outcome FROM denied_commands ORDER BY rowid').all() as { ruleId: string; outcome: string }[]).filter((row) => row.ruleId === FINDINGS_GATE_RULE_ID);
};

const bootInEnforce = async ({ headBranch = 'checked-out' }: { headBranch?: 'checked-out' | 'absent' } = {}) => {
  await bootDaemon('enforce');
  const worktrees = repoWithSessionWorktree({ headBranch });
  return { ...worktrees, sessionId: await bootChildIn(worktrees.sessionDirectory) };
};

describe('QE — the findings gate judges the branch named by --head', () => {
  it.each([
    ['--head <branch>', `gh pr create --head ${HEAD_BRANCH} --fill`],
    ['--head=<branch>', `gh pr create --head=${HEAD_BRANCH} --fill`],
    ['-H <branch>', `gh pr create -H ${HEAD_BRANCH} --fill`],
    ['--head owner:<branch>', `gh pr create --head octocat:${HEAD_BRANCH} --fill`],
    ['--head before other flags, inside an && chain', `cd /tmp && gh pr create --title t --head ${HEAD_BRANCH}`],
  ])('opens on the findings of the head branch, not of the directory it runs in (%s)', async (_form, command) => {
    const { sessionDirectory, headDirectory, sessionId } = await bootInEnforce();
    allStepsOpenAt('CCM-8', headOf(headDirectory));

    const fromDirectoryWithoutFindings = await runCommand(sessionId, sessionDirectory, command);

    expect(fromDirectoryWithoutFindings).toEqual({});
  });

  it('refuses on the ticket of the head branch even when the directory it runs in has all its findings', async () => {
    const { sessionDirectory, sessionId } = await bootInEnforce();
    allStepsOpenAt('CCM-7', headOf(sessionDirectory));

    const answer = await runCommand(sessionId, sessionDirectory, `gh pr create --head ${HEAD_BRANCH}`);

    expect(answer.hookSpecificOutput?.permissionDecision).toBe('deny');
    expect(answer.hookSpecificOutput?.permissionDecisionReason).toContain('findings_required');
    expect(answer.hookSpecificOutput?.permissionDecisionReason).toContain('CCM-8');
  });

  it('compares the findings with the head commit of the named branch: a later commit on it closes the gate', async () => {
    const { sessionDirectory, headDirectory, sessionId } = await bootInEnforce();
    allStepsOpenAt('CCM-8', headOf(headDirectory));
    git(headDirectory, 'commit', '--allow-empty', '-m', 'next');

    const answer = await runCommand(sessionId, sessionDirectory, `gh pr create --head ${HEAD_BRANCH}`);

    expect(answer.hookSpecificOutput?.permissionDecision).toBe('deny');
  });

  it('refuses a head branch that git cannot read here, and says where to run the command', async () => {
    const { sessionDirectory, sessionId } = await bootInEnforce({ headBranch: 'absent' });
    allStepsOpenAt('CCM-7', headOf(sessionDirectory));

    const answer = await runCommand(sessionId, sessionDirectory, `gh pr create --head ${HEAD_BRANCH}`);

    expect(answer.hookSpecificOutput?.permissionDecision).toBe('deny');
    expect(answer.hookSpecificOutput?.permissionDecisionReason).toContain('findings_required');
    expect(answer.hookSpecificOutput?.permissionDecisionReason).toContain(HEAD_BRANCH);
    expect(answer.hookSpecificOutput?.permissionDecisionReason).toContain('worktree');
  });

  it('does not read a head branch as a git option', async () => {
    const { sessionDirectory, sessionId } = await bootInEnforce();

    const answer = await runCommand(sessionId, sessionDirectory, 'gh pr create --head=--all');

    expect(answer.hookSpecificOutput?.permissionDecision).toBe('deny');
  });

  it('judges every gh pr create of the command: a second one without findings closes it', async () => {
    const { sessionDirectory, headDirectory, sessionId } = await bootInEnforce();
    allStepsOpenAt('CCM-8', headOf(headDirectory));

    const answer = await runCommand(sessionId, sessionDirectory, `gh pr create --head ${HEAD_BRANCH} && gh pr create`);

    expect(answer.hookSpecificOutput?.permissionDecision).toBe('deny');
  });
});

describe('QE — the findings gate and -R/--repo', () => {
  it.each([
    ['after pr create', 'gh pr create -R octocat/repo --fill'],
    ['--repo= after pr create', 'gh pr create --repo=octocat/repo --fill'],
    ['before pr create', 'gh -R octocat/repo pr create --fill'],
    ['--repo= before pr create', 'gh --repo=octocat/repo pr create --fill'],
    ['--repo before pr create', 'gh --repo octocat/repo pr create --fill'],
  ])('keeps judging the directory the command runs in (%s)', async (_form, command) => {
    const { sessionDirectory, sessionId } = await bootInEnforce();

    const refused = await runCommand(sessionId, sessionDirectory, command);
    allStepsOpenAt('CCM-7', headOf(sessionDirectory));
    const opened = await runCommand(sessionId, sessionDirectory, command);

    expect(refused.hookSpecificOutput?.permissionDecision).toBe('deny');
    expect(refused.hookSpecificOutput?.permissionDecisionReason).toContain('CCM-7');
    expect(opened).toEqual({});
  });

  it('still reads --head when -R comes first', async () => {
    const { sessionDirectory, headDirectory, sessionId } = await bootInEnforce();
    const command = `gh -R octocat/repo pr create --head ${HEAD_BRANCH}`;

    const refused = await runCommand(sessionId, sessionDirectory, command);
    allStepsOpenAt('CCM-8', headOf(headDirectory));
    const opened = await runCommand(sessionId, sessionDirectory, command);

    expect(refused.hookSpecificOutput?.permissionDecisionReason).toContain('CCM-8');
    expect(opened).toEqual({});
  });
});

describe('QE — the findings gate on --head, observing', () => {
  it('lets a head branch that git cannot read pass and journals it as observed', async () => {
    await bootDaemon('observe');
    const { sessionDirectory } = repoWithSessionWorktree({ headBranch: 'absent' });
    const sessionId = await bootChildIn(sessionDirectory);

    const answer = await runCommand(sessionId, sessionDirectory, `gh pr create --head ${HEAD_BRANCH}`);

    expect(answer).toEqual({});
    expect(await journaledGateRows()).toEqual([{ ruleId: FINDINGS_GATE_RULE_ID, outcome: 'observed' }]);
  });
});
