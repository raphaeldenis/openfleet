import { execFile } from 'node:child_process';
import { existsSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { childEnvironmentForGit } from '../process/childEnvironment.js';

const runExecFile = promisify(execFile);

// Every hook git triggers (post-checkout, post-commit, …) inherits this env, so a raw
// process.env pass-through would hand a hook planted in the caller's own repo the daemon's
// host-identity markers (SCAPE_EDIT_CAP, session ids, …) on the next worktree operation.
export interface GitRunOptions { cwd: string; env?: NodeJS.ProcessEnv; timeoutMs?: number; maxBufferBytes?: number }

export async function run(args: string[], options: GitRunOptions): Promise<{ stdout: string; stderr: string }> {
  try {
    return await runExecFile('git', args, {
      cwd: options.cwd, env: childEnvironmentForGit(options.env ?? process.env), timeout: options.timeoutMs, maxBuffer: options.maxBufferBytes, killSignal: 'SIGKILL',
    });
  } catch (error) {
    // The caller checked the cwd exists, so a spawn ENOENT means the git binary itself is not on the PATH.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new WorktreeError('git_unavailable', 'git is not available to the daemon.');
    throw error;
  }
}

export class WorktreeError extends Error {
  constructor(public readonly code: 'invalid_branch' | 'exists' | 'git_failed' | 'directory_missing' | 'git_unavailable', message: string) {
    super(message);
  }
}

const SAFE_BRANCH = /^[A-Za-z0-9._][A-Za-z0-9._\/-]*$/;
// git writes refs/heads/<name>.lock, and that file name hits the 255-character filename limit past 250.
const MAX_BRANCH_NAME_CHARS = 250;
const LOCK_SUFFIX = '.lock';

/** Mirrors the `git check-ref-format` rules that the safe character set does not already rule out. */
export function isValidBranchName(branchName: string): boolean {
  const isWithinLengthCap = branchName.length <= MAX_BRANCH_NAME_CHARS;
  if (!isWithinLengthCap || !SAFE_BRANCH.test(branchName)) return false;
  const hasConsecutiveDots = branchName.includes('..');
  const endsWithDot = branchName.endsWith('.');
  const hasRefusedComponent = branchName.split('/').some((component) => component === '' || component.startsWith('.') || component.endsWith(LOCK_SUFFIX));
  return !hasConsecutiveDots && !endsWithDot && !hasRefusedComponent;
}

const isDirectory = (path: string): boolean => existsSync(path) && statSync(path).isDirectory();

export async function createWorktree(input: { repoPath: string; branchName: string; worktreesRoot: string; env?: NodeJS.ProcessEnv }): Promise<{ path: string; branch: string }> {
  if (!isValidBranchName(input.branchName)) throw new WorktreeError('invalid_branch', `invalid branch name: ${input.branchName}`);
  if (!isDirectory(input.repoPath)) throw new WorktreeError('directory_missing', 'the repository directory does not exist.');

  const worktreePath = join(input.worktreesRoot, input.branchName.replaceAll('/', '-'));
  if (existsSync(worktreePath)) throw new WorktreeError('exists', `worktree already exists: ${worktreePath}`);

  const branchExists = await gitSucceeds(input.repoPath, ['rev-parse', '--verify', `refs/heads/${input.branchName}`], input.env);
  const args = branchExists
    ? ['worktree', 'add', '--', worktreePath, input.branchName]
    : ['worktree', 'add', '-b', input.branchName, '--', worktreePath];
  try {
    await run(args, { cwd: input.repoPath, env: input.env });
  } catch (error) {
    if (error instanceof WorktreeError) throw error;
    throw new WorktreeError('git_failed', (error as Error).message);
  }
  return { path: worktreePath, branch: input.branchName };
}

async function gitSucceeds(cwd: string, args: string[], env?: NodeJS.ProcessEnv): Promise<boolean> {
  try {
    await run(args, { cwd, env });
    return true;
  } catch (error) {
    if (error instanceof WorktreeError) throw error;
    return false;
  }
}

export async function sameGitRepository(pathA: string, pathB: string): Promise<boolean> {
  const [commonDirA, commonDirB] = await Promise.all([gitCommonDir(pathA), gitCommonDir(pathB)]);
  return commonDirA !== undefined && commonDirA === commonDirB;
}

async function gitCommonDir(cwd: string): Promise<string | undefined> {
  try {
    const { stdout } = await run(['rev-parse', '--git-common-dir'], { cwd });
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
