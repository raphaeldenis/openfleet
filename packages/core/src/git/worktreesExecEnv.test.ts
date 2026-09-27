import { describe, expect, it, vi } from 'vitest';

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
});
