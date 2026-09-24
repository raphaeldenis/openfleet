import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

export class WorktreeError extends Error {
  constructor(public readonly code: 'invalid_branch' | 'exists' | 'git_failed', message: string) {
    super(message);
  }
}

const SAFE_BRANCH = /^[A-Za-z0-9._][A-Za-z0-9._\/-]*$/;

export async function createWorktree(input: { repoPath: string; branchName: string; worktreesRoot: string }): Promise<{ path: string; branch: string }> {
  const isValidBranch = SAFE_BRANCH.test(input.branchName) && !input.branchName.includes('..');
  if (!isValidBranch) throw new WorktreeError('invalid_branch', `invalid branch name: ${input.branchName}`);

  const worktreePath = join(input.worktreesRoot, input.branchName.replaceAll('/', '-'));
  if (existsSync(worktreePath)) throw new WorktreeError('exists', `worktree already exists: ${worktreePath}`);

  const branchExists = await gitSucceeds(input.repoPath, ['rev-parse', '--verify', `refs/heads/${input.branchName}`]);
  const args = branchExists
    ? ['worktree', 'add', '--', worktreePath, input.branchName]
    : ['worktree', 'add', '-b', input.branchName, '--', worktreePath];
  try {
    await run('git', args, { cwd: input.repoPath });
  } catch (error) {
    throw new WorktreeError('git_failed', (error as Error).message);
  }
  return { path: worktreePath, branch: input.branchName };
}

async function gitSucceeds(cwd: string, args: string[]): Promise<boolean> {
  try {
    await run('git', args, { cwd });
    return true;
  } catch {
    return false;
  }
}
