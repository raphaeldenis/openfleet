import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, existsSync, symlinkSync } from 'node:fs';
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
    const root = mkdtempSync(join(tmpdir(), 'of-wt-'));
    const child = join(root, 'task-1');
    mkdirSync(child);
    expect(isPathWithin(child, root)).toBe(true);
  });

  // Decision (fix loop 2, finding 1+3+5): create_session now requires the directory to already exist,
  // so "is the root itself within the root" is a legitimate case rather than a rejected edge case.
  it('is true for the root itself', () => {
    const root = mkdtempSync(join(tmpdir(), 'of-wt-'));
    expect(isPathWithin(root, root)).toBe(true);
  });

  it('is false for a sibling directory whose name merely starts with the root\'s name', () => {
    const root = mkdtempSync(join(tmpdir(), 'of-wt-'));
    const sibling = `${root}-evil`;
    mkdirSync(sibling);
    const child = join(sibling, 'task-1');
    mkdirSync(child);
    expect(isPathWithin(child, root)).toBe(false);
  });

  it('is false for a parent directory', () => {
    const root = mkdtempSync(join(tmpdir(), 'of-wt-'));
    const child = join(root, 'task-1');
    mkdirSync(child);
    expect(isPathWithin(root, child)).toBe(false);
  });

  it('is false for a symlink inside the root whose target actually resolves outside it', () => {
    const root = mkdtempSync(join(tmpdir(), 'of-wt-'));
    const outside = mkdtempSync(join(tmpdir(), 'of-outside-'));
    const escapeLink = join(root, 'escape');
    symlinkSync(outside, escapeLink);
    expect(isPathWithin(escapeLink, root)).toBe(false);
  });

  // Finding 1 (BLOCKER): path.resolve() collapses ".." lexically before symlinks are followed, so the
  // literal string "root/link/../target" used to resolve to "root/target" (looks inside) even though the
  // OS actually opens "outside/target" once "link" is followed. fs.realpathSync resolves symlinks and
  // ".." in the order the OS does, closing the escape.
  it('is false when a ".." segment after a symlink would lexically collapse back inside the root', () => {
    const outside = mkdtempSync(join(tmpdir(), 'of-outside-'));
    const deep = join(outside, 'deep');
    mkdirSync(deep);
    const target = join(outside, 'target');
    mkdirSync(target);
    const root = mkdtempSync(join(tmpdir(), 'of-wt-'));
    symlinkSync(deep, join(root, 'link'));
    const escapingCandidate = `${root}/link/../target`;
    expect(isPathWithin(escapingCandidate, root)).toBe(false);
  });

  it('is true for a trailing-slash child path', () => {
    const root = mkdtempSync(join(tmpdir(), 'of-wt-'));
    const child = join(root, 'task-1');
    mkdirSync(child);
    expect(isPathWithin(`${child}/`, root)).toBe(true);
  });

  it('resolves a relative candidate against the current working directory, not silently accepting it', () => {
    expect(isPathWithin('some/relative/path', '/definitely/not/cwd')).toBe(false);
  });

  // Finding 5 (MINOR): relativePath.startsWith('..') used to reject any directory whose name merely
  // starts with two dots, such as "..cache", even though it never leaves the root.
  it('accepts a directory literally named "..cache" inside the root', () => {
    const root = mkdtempSync(join(tmpdir(), 'of-wt-'));
    const dotCache = join(root, '..cache');
    mkdirSync(dotCache);
    expect(isPathWithin(dotCache, root)).toBe(true);
  });

  it('is false for a candidate directory that does not exist', () => {
    const root = mkdtempSync(join(tmpdir(), 'of-wt-'));
    expect(isPathWithin(join(root, 'missing'), root)).toBe(false);
  });
});
