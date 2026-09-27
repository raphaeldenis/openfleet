import { beforeEach, describe, expect, it, vi } from 'vitest';

const execFileCalls: Array<{ options: { env?: NodeJS.ProcessEnv; cwd?: string } }> = [];

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    execFile: (_file: string, _args: string[], options: { env?: NodeJS.ProcessEnv; cwd?: string }, callback: (error: unknown, result: { stdout: string; stderr: string }) => void) => {
      execFileCalls.push({ options });
      callback(null, { stdout: '', stderr: '' });
    },
  };
});

const { createWorktree } = await import('./worktrees.js');

describe('git subprocess environment', () => {
  // execFileCalls is module-scoped: without this, a later test's `length > 0` assertion could
  // pass on an earlier test's calls alone even if this test's own createWorktree call made none.
  beforeEach(() => {
    execFileCalls.length = 0;
  });

  it('runs every git subprocess with an env scrubbed of host-identity markers, keeping PATH', async () => {
    process.env.SCAPE_EDIT_CAP = 'cap-token';
    process.env.CLAUDECODE = '1';
    try {
      await createWorktree({ repoPath: '/repo', branchName: 'feature/x', worktreesRoot: '/worktrees-does-not-exist' });
    } finally {
      delete process.env.SCAPE_EDIT_CAP;
      delete process.env.CLAUDECODE;
    }

    expect(execFileCalls.length).toBeGreaterThan(0);
    for (const { options } of execFileCalls) {
      expect(options.env).toBeDefined();
      expect(options.env?.SCAPE_EDIT_CAP).toBeUndefined();
      expect(options.env?.CLAUDECODE).toBeUndefined();
      expect(options.env?.PATH).toBe(process.env.PATH);
    }
  });

  it('runs every git subprocess with an env scrubbed of repository-location vars, keeping PATH', async () => {
    process.env.GIT_DIR = '/decoy/.git';
    process.env.GIT_WORK_TREE = '/decoy';
    try {
      await createWorktree({ repoPath: '/repo', branchName: 'feature/y', worktreesRoot: '/worktrees-does-not-exist' });
    } finally {
      delete process.env.GIT_DIR;
      delete process.env.GIT_WORK_TREE;
    }

    expect(execFileCalls.length).toBeGreaterThan(0);
    for (const { options } of execFileCalls) {
      expect(options.env).toBeDefined();
      expect(options.env?.GIT_DIR).toBeUndefined();
      expect(options.env?.GIT_WORK_TREE).toBeUndefined();
      expect(options.env?.PATH).toBe(process.env.PATH);
    }
  });

  it('runs every git subprocess with an env scrubbed of config-injection and trace-destination vars, keeping PATH', async () => {
    process.env.GIT_CONFIG_GLOBAL = '/decoy.gitconfig';
    process.env.GIT_TRACE = '/decoy-trace.log';
    try {
      await createWorktree({ repoPath: '/repo', branchName: 'feature/z', worktreesRoot: '/worktrees-does-not-exist' });
    } finally {
      delete process.env.GIT_CONFIG_GLOBAL;
      delete process.env.GIT_TRACE;
    }

    expect(execFileCalls.length).toBeGreaterThan(0);
    for (const { options } of execFileCalls) {
      expect(options.env).toBeDefined();
      expect(options.env?.GIT_CONFIG_GLOBAL).toBeUndefined();
      expect(options.env?.GIT_TRACE).toBeUndefined();
      expect(options.env?.PATH).toBe(process.env.PATH);
    }
  });
});
