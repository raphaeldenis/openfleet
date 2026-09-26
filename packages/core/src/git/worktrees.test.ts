import { execFileSync } from 'node:child_process';
import { mkdtempSync, existsSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createWorktree, isPathWithin, sameGitRepository, WorktreeError } from './worktrees.js';

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'of-repo-'));
  execFileSync('git', ['init', '-b', 'main'], { cwd: dir });
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '--allow-empty', '-m', 'init'], { cwd: dir });
  return dir;
}

describe('createWorktree', () => {
  it('creates a worktree on a new branch under worktreesRoot', async () => {
    const repoPath = makeRepo();
    const worktreesRoot = mkdtempSync(join(tmpdir(), 'of-wt-'));
    const result = await createWorktree({ repoPath, branchName: 'task/CCM-1', worktreesRoot });
    expect(result.path).toBe(join(worktreesRoot, 'task-CCM-1'));
    expect(existsSync(join(result.path, '.git'))).toBe(true);
  });

  it('rejects an invalid branch name without creating anything', async () => {
    const repoPath = makeRepo();
    const worktreesRoot = mkdtempSync(join(tmpdir(), 'of-wt-'));
    await expect(createWorktree({ repoPath, branchName: 'bad name', worktreesRoot })).rejects.toMatchObject({ code: 'invalid_branch' });
    expect(existsSync(join(worktreesRoot, 'bad-name'))).toBe(false);
  });

  it('fails with exists when the worktree path is already taken', async () => {
    const repoPath = makeRepo();
    const worktreesRoot = mkdtempSync(join(tmpdir(), 'of-wt-'));
    await createWorktree({ repoPath, branchName: 'x', worktreesRoot });
    await expect(createWorktree({ repoPath, branchName: 'x', worktreesRoot })).rejects.toBeInstanceOf(WorktreeError);
  });

  it('rejects a branch name starting with a dash instead of passing it to git as a flag', async () => {
    const repoPath = makeRepo();
    const worktreesRoot = mkdtempSync(join(tmpdir(), 'of-wt-'));
    await expect(createWorktree({ repoPath, branchName: '--upload-pack', worktreesRoot })).rejects.toMatchObject({ code: 'invalid_branch' });
  });
});

describe('sameGitRepository', () => {
  it('is true for two directories inside the same repository', async () => {
    const repoPath = makeRepo();
    const subdir = join(repoPath, 'sub');
    execFileSync('mkdir', [subdir]);
    await expect(sameGitRepository(repoPath, subdir)).resolves.toBe(true);
  });

  it('is false for two unrelated repositories', async () => {
    const repoA = makeRepo();
    const repoB = makeRepo();
    await expect(sameGitRepository(repoA, repoB)).resolves.toBe(false);
  });

  it('is false when either path is not a git repository', async () => {
    const repoPath = makeRepo();
    const notARepo = mkdtempSync(join(tmpdir(), 'of-not-a-repo-'));
    await expect(sameGitRepository(repoPath, notARepo)).resolves.toBe(false);
  });
});

describe('isPathWithin', () => {
  it('is true for a direct child path', () => {
    expect(isPathWithin('/tmp/of-wt/task-1', '/tmp/of-wt')).toBe(true);
  });

  it('is false for the root itself', () => {
    expect(isPathWithin('/tmp/of-wt', '/tmp/of-wt')).toBe(false);
  });

  it('is false for a sibling directory whose name merely starts with the root\'s name', () => {
    expect(isPathWithin('/tmp/of-wt-evil/task-1', '/tmp/of-wt')).toBe(false);
  });

  it('is false for a parent directory', () => {
    expect(isPathWithin('/tmp', '/tmp/of-wt')).toBe(false);
  });

  it('is false for a symlink inside the root whose target actually resolves outside it', () => {
    const root = mkdtempSync(join(tmpdir(), 'of-wt-'));
    const outside = mkdtempSync(join(tmpdir(), 'of-outside-'));
    const escapeLink = join(root, 'escape');
    symlinkSync(outside, escapeLink);
    expect(isPathWithin(escapeLink, root)).toBe(false);
  });

  it('is true for a trailing-slash child path', () => {
    expect(isPathWithin('/tmp/of-wt/task-1/', '/tmp/of-wt')).toBe(true);
  });

  it('resolves a relative candidate against the current working directory, not silently accepting it', () => {
    expect(isPathWithin('some/relative/path', '/definitely/not/cwd')).toBe(false);
  });
});
