import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createTempDirTracker } from '../tempDirTracker.js';
import { makeRepo } from './testRepo.js';
import { SETUP_SCRIPT_RELATIVE_PATH } from './worktreeSetupScript.js';
import { createWorktreeWithHook } from './worktreeCreation.js';

const tempDirs = createTempDirTracker();
const repos: string[] = [];

afterEach(() => {
  tempDirs.removeAll();
  for (const repo of repos.splice(0)) rmSync(repo, { recursive: true, force: true });
});

function aRepoWithSetupScript(body?: string): string {
  const repo = realpathSync(makeRepo());
  repos.push(repo);
  if (body === undefined) return repo;
  const script = join(repo, SETUP_SCRIPT_RELATIVE_PATH);
  mkdirSync(join(repo, 'scripts'), { recursive: true });
  writeFileSync(script, `#!/bin/sh\n${body}\n`);
  chmodSync(script, 0o755);
  return repo;
}

const createIn = (repoPath: string, branchName: string, extra: { setupTimeoutMs?: number } = {}) =>
  createWorktreeWithHook({ repoPath, branchName, worktreesRoot: realpathSync(tempDirs.make('of-setup-wt-')), ...extra });

describe('createWorktreeWithHook runs the setup script of the repository', () => {
  it('runs scripts/worktree-setup.sh with the new worktree as working directory and answers no warning when it succeeds', async () => {
    const repo = aRepoWithSetupScript('echo installed > setup-ran.txt');

    const created = await createIn(repo, 'task/setup-ok');

    expect(readFileSync(join(created.path, 'setup-ran.txt'), 'utf8')).toBe('installed\n');
    expect(created).not.toHaveProperty('warnings');
  });

  it('answers no warning when the repository has no setup script', async () => {
    const repo = aRepoWithSetupScript();

    const created = await createIn(repo, 'task/no-setup');

    expect(created).not.toHaveProperty('warnings');
    expect(existsSync(join(created.path, '.git'))).toBe(true);
  });

  it('still creates the worktree and answers worktree_setup_failed when the script fails', async () => {
    const repo = aRepoWithSetupScript('echo "frozen lockfile mismatch" >&2\nexit 1');

    const created = await createIn(repo, 'task/setup-fails');

    expect(existsSync(join(created.path, '.git'))).toBe(true);
    expect(created.warnings).toEqual([{ type: 'worktree_setup_failed', reason: 'exit_nonzero', exitCode: 1, outputTail: expect.stringContaining('frozen lockfile mismatch') }]);
  });

  it('still creates the worktree and answers a timeout warning when the script runs too long', async () => {
    const repo = aRepoWithSetupScript('sleep 30');

    const created = await createIn(repo, 'task/setup-slow', { setupTimeoutMs: 300 });

    expect(existsSync(join(created.path, '.git'))).toBe(true);
    expect(created.warnings).toEqual([expect.objectContaining({ type: 'worktree_setup_failed', reason: 'timeout' })]);
  });

  it('runs no script when the worktree cannot be created', async () => {
    const witness = join(tempDirs.make('of-setup-out-'), 'ran.txt');
    const repo = aRepoWithSetupScript(`touch "${witness}"`);

    await expect(createIn(repo, 'task/bad..name')).rejects.toThrow();

    expect(existsSync(witness)).toBe(false);
  });
});
