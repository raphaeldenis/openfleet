import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { childEnvironmentForGit } from '../process/childEnvironment.js';
import { makeRepo } from './testRepo.js';

const corePackageDir = fileURLToPath(new URL('../..', import.meta.url));
const repositoryRoot = join(corePackageDir, '..', '..');
const scratchDir = join(repositoryRoot, '.scratch');
const vitestBinary = join(repositoryRoot, 'node_modules', '.bin', 'vitest');

function git(args: string[], cwd?: string): string {
  return execFileSync('git', args, { cwd, env: childEnvironmentForGit(process.env), encoding: 'utf8' });
}

function makeBareRepoWithMainBranch(): string {
  mkdirSync(scratchDir, { recursive: true });
  const bareRepoPath = join(mkdtempSync(join(scratchDir, 'host-git-dir-')), 'bare.git');
  git(['clone', '--bare', makeRepo(), bareRepoPath]);
  return bareRepoPath;
}

const bareRepoPaths: string[] = [];

afterEach(() => {
  for (const bareRepoPath of bareRepoPaths.splice(0)) rmSync(join(bareRepoPath, '..'), { recursive: true, force: true });
});

// A git hook exports GIT_DIR to everything it launches. The git-driving specs must keep using
// their own temp repositories instead of the repository that variable names.
describe('git specs launched by a host that exports GIT_DIR', () => {
  it('leave the repository named by GIT_DIR untouched and pass on their own temp repos', () => {
    const hostRepoPath = makeBareRepoWithMainBranch();
    bareRepoPaths.push(hostRepoPath);

    const run = spawnSync(vitestBinary, ['run', 'src/git/worktrees.test.ts'], {
      cwd: corePackageDir,
      env: { ...process.env, GIT_DIR: hostRepoPath },
      encoding: 'utf8',
    });

    const worktreeEntries = git(['--git-dir', hostRepoPath, 'worktree', 'list', '--porcelain']).match(/^worktree /gm) ?? [];
    const branchNames = git(['--git-dir', hostRepoPath, 'for-each-ref', '--format=%(refname:short)', 'refs/heads']).trim().split('\n');

    expect({ status: run.status, worktreeCount: worktreeEntries.length, branchNames }).toEqual({
      status: 0,
      worktreeCount: 1,
      branchNames: ['main'],
    });
  }, 120_000);
});
