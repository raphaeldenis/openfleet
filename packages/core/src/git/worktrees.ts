import { execFile } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
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

export async function sameGitRepository(pathA: string, pathB: string): Promise<boolean> {
  const [commonDirA, commonDirB] = await Promise.all([gitCommonDir(pathA), gitCommonDir(pathB)]);
  return commonDirA !== undefined && commonDirA === commonDirB;
}

async function gitCommonDir(cwd: string): Promise<string | undefined> {
  try {
    const { stdout } = await run('git', ['rev-parse', '--git-common-dir'], { cwd });
    // realpathSync canonicalizes the result so two spellings of the same cwd (e.g. a raw session
    // directory vs. its realpath'd form) still compare equal — otherwise a caller stored with one
    // spelling could never match a repo_path/directory given with the other.
    return realpathSync(resolve(cwd, stdout.trim()));
  } catch {
    return undefined;
  }
}

// Both paths must exist: fs.realpathSync.native resolves symlinks and ".." components as the OS does, in
// the order they appear, which a lexical path.resolve() cannot — a resolve() placed in front of it would
// lexically collapse a candidate like "root/link/.." back inside root before the symlink is ever followed,
// silently undoing the whole guard. Node's own (non-native) realpathSync reimplementation has the same
// blind spot for some inputs, so both paths go through the native binding with nothing lexical first.
export function isPathWithin(candidate: string, root: string): boolean {
  try {
    const realRoot = realpathSync.native(root);
    const realCandidate = realpathSync.native(candidate);
    const relativePath = relative(realRoot, realCandidate);
    return relativePath === '' || (relativePath !== '..' && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath));
  } catch {
    return false;
  }
}
