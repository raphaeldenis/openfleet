import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, existsSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { childEnvironmentForClaudeCli, childEnvironmentForGit } from '../process/childEnvironment.js';
import { makeRepo } from './testRepo.js';
import { createWorktree, isPathWithin, sameGitRepository, WorktreeError } from './worktrees.js';

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

  it('does not leak Scape host-identity env vars to a post-checkout hook triggered by worktree add', async () => {
    const repoPath = makeRepo();
    const worktreesRoot = mkdtempSync(join(tmpdir(), 'of-wt-'));
    const hookEnvPath = join(worktreesRoot, 'hook-env.txt');
    const hookPath = join(repoPath, '.git', 'hooks', 'post-checkout');
    writeFileSync(hookPath, `#!/bin/sh\nenv > "${hookEnvPath}"\n`);
    chmodSync(hookPath, 0o755);

    process.env.SCAPE_EDIT_CAP = 'leaked-cap-token';
    process.env.CLAUDECODE = '1';
    try {
      await createWorktree({ repoPath, branchName: 'task/hook-check', worktreesRoot });
    } finally {
      delete process.env.SCAPE_EDIT_CAP;
      delete process.env.CLAUDECODE;
    }

    const hookEnv = readFileSync(hookEnvPath, 'utf8');
    expect(hookEnv).not.toContain('SCAPE_EDIT_CAP');
    expect(hookEnv).not.toContain('CLAUDECODE');
    expect(hookEnv).toContain('PATH=');
  });

  it('does not let the caller\'s GIT_CONFIG_COUNT/KEY_0/VALUE_0 inject core.hooksPath and run an attacker hook on worktree add', async () => {
    const repoPath = makeRepo();
    const worktreesRoot = mkdtempSync(join(tmpdir(), 'of-wt-'));
    const attackerHooksDir = mkdtempSync(join(tmpdir(), 'of-attacker-hooks-'));
    const marker = join(attackerHooksDir, 'FIRED');
    writeFileSync(join(attackerHooksDir, 'post-checkout'), `#!/bin/sh\ntouch "${marker}"\n`);
    chmodSync(join(attackerHooksDir, 'post-checkout'), 0o755);

    process.env.GIT_CONFIG_COUNT = '1';
    process.env.GIT_CONFIG_KEY_0 = 'core.hooksPath';
    process.env.GIT_CONFIG_VALUE_0 = attackerHooksDir;
    try {
      await createWorktree({ repoPath, branchName: 'task/config-count', worktreesRoot });
    } finally {
      delete process.env.GIT_CONFIG_COUNT;
      delete process.env.GIT_CONFIG_KEY_0;
      delete process.env.GIT_CONFIG_VALUE_0;
    }

    expect(existsSync(marker)).toBe(false);
  });

  it('does not let the caller\'s GIT_CONFIG_PARAMETERS inject core.hooksPath and run an attacker hook on worktree add', async () => {
    const repoPath = makeRepo();
    const worktreesRoot = mkdtempSync(join(tmpdir(), 'of-wt-'));
    const attackerHooksDir = mkdtempSync(join(tmpdir(), 'of-attacker-hooks-'));
    const marker = join(attackerHooksDir, 'FIRED');
    writeFileSync(join(attackerHooksDir, 'post-checkout'), `#!/bin/sh\ntouch "${marker}"\n`);
    chmodSync(join(attackerHooksDir, 'post-checkout'), 0o755);

    process.env.GIT_CONFIG_PARAMETERS = `'core.hooksPath=${attackerHooksDir}'`;
    try {
      await createWorktree({ repoPath, branchName: 'task/config-params', worktreesRoot });
    } finally {
      delete process.env.GIT_CONFIG_PARAMETERS;
    }

    expect(existsSync(marker)).toBe(false);
  });

  it('does not let the caller\'s GIT_CONFIG_GLOBAL redirect to an attacker file that injects core.hooksPath', async () => {
    const repoPath = makeRepo();
    const worktreesRoot = mkdtempSync(join(tmpdir(), 'of-wt-'));
    const attackerHooksDir = mkdtempSync(join(tmpdir(), 'of-attacker-hooks-'));
    const marker = join(attackerHooksDir, 'FIRED');
    writeFileSync(join(attackerHooksDir, 'post-checkout'), `#!/bin/sh\ntouch "${marker}"\n`);
    chmodSync(join(attackerHooksDir, 'post-checkout'), 0o755);
    const fakeGlobalConfig = join(mkdtempSync(join(tmpdir(), 'of-fake-global-')), '.gitconfig');
    writeFileSync(fakeGlobalConfig, `[core]\n\thooksPath = ${attackerHooksDir}\n`);

    process.env.GIT_CONFIG_GLOBAL = fakeGlobalConfig;
    try {
      await createWorktree({ repoPath, branchName: 'task/config-global', worktreesRoot });
    } finally {
      delete process.env.GIT_CONFIG_GLOBAL;
    }

    expect(existsSync(marker)).toBe(false);
  });

  it('does not let the caller\'s GIT_CONFIG_SYSTEM redirect to an attacker file that injects core.hooksPath', async () => {
    const repoPath = makeRepo();
    const worktreesRoot = mkdtempSync(join(tmpdir(), 'of-wt-'));
    const attackerHooksDir = mkdtempSync(join(tmpdir(), 'of-attacker-hooks-'));
    const marker = join(attackerHooksDir, 'FIRED');
    writeFileSync(join(attackerHooksDir, 'post-checkout'), `#!/bin/sh\ntouch "${marker}"\n`);
    chmodSync(join(attackerHooksDir, 'post-checkout'), 0o755);
    const fakeSystemConfig = join(mkdtempSync(join(tmpdir(), 'of-fake-system-')), 'gitconfig');
    writeFileSync(fakeSystemConfig, `[core]\n\thooksPath = ${attackerHooksDir}\n`);

    process.env.GIT_CONFIG_SYSTEM = fakeSystemConfig;
    try {
      await createWorktree({ repoPath, branchName: 'task/config-system', worktreesRoot });
    } finally {
      delete process.env.GIT_CONFIG_SYSTEM;
    }

    expect(existsSync(marker)).toBe(false);
  });

  // Positive control for the test above: proves the GIT_CONFIG_SYSTEM → core.hooksPath injection
  // is a real attack the guard must stop, not a no-op that would pass even unguarded (e.g. because
  // this git build or environment ignores GIT_CONFIG_SYSTEM). Calls git directly, never through
  // createWorktree/childEnvironmentForGit, with the config-injection vars left in place — only the
  // repository-location vars (GIT_DIR…) are dropped, so a hook-launched run stays on its temp repo.
  it('positive control: an unscrubbed GIT_CONFIG_SYSTEM does inject core.hooksPath and run the attacker hook on worktree add', () => {
    const repoPath = makeRepo();
    const worktreesRoot = mkdtempSync(join(tmpdir(), 'of-wt-'));
    const attackerHooksDir = mkdtempSync(join(tmpdir(), 'of-attacker-hooks-'));
    const marker = join(attackerHooksDir, 'FIRED');
    writeFileSync(join(attackerHooksDir, 'post-checkout'), `#!/bin/sh\ntouch "${marker}"\n`);
    chmodSync(join(attackerHooksDir, 'post-checkout'), 0o755);
    const fakeSystemConfig = join(mkdtempSync(join(tmpdir(), 'of-fake-system-')), 'gitconfig');
    writeFileSync(fakeSystemConfig, `[core]\n\thooksPath = ${attackerHooksDir}\n`);

    execFileSync('git', ['worktree', 'add', '-b', 'task/config-system-control', '--', join(worktreesRoot, 'control')], {
      cwd: repoPath,
      env: { ...childEnvironmentForClaudeCli(process.env), GIT_CONFIG_SYSTEM: fakeSystemConfig },
    });

    expect(existsSync(marker)).toBe(true);
  });

  it('creating a fresh temp repo through the test helper does not redirect a decoy repo named by the caller\'s GIT_DIR/GIT_WORK_TREE', () => {
    const decoyRepo = makeRepo();
    process.env.GIT_DIR = join(decoyRepo, '.git');
    process.env.GIT_WORK_TREE = mkdtempSync(join(tmpdir(), 'of-decoy-worktree-'));
    let targetRepo: string;
    try {
      targetRepo = makeRepo();
    } finally {
      delete process.env.GIT_DIR;
      delete process.env.GIT_WORK_TREE;
    }

    // Asserts the specific "key absent" exit status (1), not any throw: a bare toThrow() would
    // also pass on an unrelated failure (git missing, decoyRepo gone) and prove nothing about
    // whether core.worktree was actually left unset.
    let caughtStatus: number | null = null;
    try {
      execFileSync('git', ['config', '--get', 'core.worktree'], { cwd: decoyRepo, env: childEnvironmentForGit(process.env) });
    } catch (error) {
      caughtStatus = (error as { status: number | null }).status;
    }

    expect(caughtStatus).toBe(1);
    expect(existsSync(join(targetRepo, '.git'))).toBe(true);
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

  // Finding 1 (BLOCKER) / Finding 2 (fix loop 3, MAJOR): path.resolve() collapses ".." lexically before
  // symlinks are followed, so the literal string "root/link/../target" used to resolve to "root/target"
  // even though the OS actually opens "outside/target" once "link" is followed. A decoy "root/target"
  // that genuinely exists is required to expose this: without it, the lexically-collapsed path is missing
  // on disk, realpathSync throws, and the guard fails safe by accident rather than by resolving correctly.
  // fs.realpathSync.native, called with no resolve() in front, resolves symlinks and ".." in the order the
  // OS does, so the candidate lands on "outside/target" and is correctly refused even with the decoy present.
  it('is false when a ".." segment after a symlink would lexically collapse into an existing decoy inside the root', () => {
    const outside = mkdtempSync(join(tmpdir(), 'of-outside-'));
    const deep = join(outside, 'deep');
    mkdirSync(deep);
    const target = join(outside, 'target');
    mkdirSync(target);
    const root = mkdtempSync(join(tmpdir(), 'of-wt-'));
    symlinkSync(deep, join(root, 'link'));
    mkdirSync(join(root, 'target'));
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
