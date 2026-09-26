import { beforeEach, describe, expect, it, vi } from 'vitest';

const spawn = vi.fn((_command: string, _args: string[], _options: { env: Record<string, string> }) => ({
  onData: () => ({ dispose: () => undefined }),
  onExit: () => ({ dispose: () => undefined }),
  write: () => undefined,
  resize: () => undefined,
  kill: () => undefined,
}));

vi.mock('node-pty', () => ({ spawn }));
vi.mock('./trustDirectory.js', () => ({ markDirectoryTrusted: vi.fn() }));

const launch = {
  sessionId: '11111111-1111-4111-8111-111111111111',
  directory: '/tmp/wt',
  model: 'claude-sonnet-5',
  hookUrl: 'http://127.0.0.1:7331/hooks/tok-hook',
  mcpUrl: 'http://127.0.0.1:7331/mcp',
  mcpToken: 'tok-mcp',
  displayName: '⚔️ Gimli - CCM-1',
};

describe('ClaudeCliHarness', () => {
  beforeEach(() => {
    spawn.mockClear();
  });

  it('spawns the CLI without any inherited Claude Code session markers', async () => {
    const parentSnapshot = { ...process.env };
    Object.assign(process.env, {
      CLAUDECODE: '1',
      CLAUDE_CODE_CHILD_SESSION: '1',
      CLAUDE_CODE_SESSION_ID: 'x',
      CLAUDE_PID: '1',
    });

    try {
      const { ClaudeCliHarness } = await import('./claudeCliHarness.js');
      new ClaudeCliHarness().start(launch);

      const [, , options] = spawn.mock.calls[0]!;
      const childEnv = options.env as Record<string, string>;

      expect(childEnv.PATH).toBe(process.env.PATH);
      expect(childEnv.TERM).toBe('xterm-256color');
      expect(childEnv.CLAUDECODE).toBeUndefined();
      expect(childEnv.CLAUDE_CODE_CHILD_SESSION).toBeUndefined();
      expect(childEnv.CLAUDE_CODE_SESSION_ID).toBeUndefined();
      expect(childEnv.CLAUDE_PID).toBeUndefined();
    } finally {
      process.env = parentSnapshot;
    }
  });
});
