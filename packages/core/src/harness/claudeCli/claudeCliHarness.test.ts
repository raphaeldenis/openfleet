import { beforeEach, describe, expect, it, vi } from 'vitest';

const spawn = vi.fn((_command: string, _args: string[], _options: { env: Record<string, string> }) => ({
  onData: () => ({ dispose: () => undefined }),
  onExit: () => ({ dispose: () => undefined }),
  write: vi.fn(),
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

  it('spawns the CLI without any inherited Scape host-identity markers, alongside Claude Code markers, and still sets TERM', async () => {
    const parentSnapshot = { ...process.env };
    Object.assign(process.env, {
      CLAUDECODE: '1',
      SCAPE_SESSION_UUID: 'session-uuid',
      SCAPE_PARENT_ARGUS_ID: 'argus-id',
      SCAPE_EMBEDDED: '1',
    });

    try {
      const { ClaudeCliHarness } = await import('./claudeCliHarness.js');
      new ClaudeCliHarness().start(launch);

      const [, , options] = spawn.mock.calls[0]!;
      const childEnv = options.env as Record<string, string>;

      expect(childEnv.PATH).toBe(process.env.PATH);
      expect(childEnv.TERM).toBe('xterm-256color');
      expect(childEnv.CLAUDECODE).toBeUndefined();
      expect(childEnv.SCAPE_SESSION_UUID).toBeUndefined();
      expect(childEnv.SCAPE_PARENT_ARGUS_ID).toBeUndefined();
      expect(childEnv.SCAPE_EMBEDDED).toBeUndefined();
    } finally {
      process.env = parentSnapshot;
    }
  });

  it('overrides an inherited TERM and keeps CLAUDE_CONFIG_DIR, which is not a session marker', async () => {
    const parentSnapshot = { ...process.env };
    Object.assign(process.env, { TERM: 'dumb', CLAUDE_CONFIG_DIR: '/home/user/.claude' });

    try {
      const { ClaudeCliHarness } = await import('./claudeCliHarness.js');
      new ClaudeCliHarness().start(launch);

      const [, , options] = spawn.mock.calls[0]!;
      const childEnv = options.env as Record<string, string>;

      expect(childEnv.TERM).toBe('xterm-256color');
      expect(childEnv.CLAUDE_CONFIG_DIR).toBe('/home/user/.claude');
    } finally {
      process.env = parentSnapshot;
    }
  });

  it('keeps the user\'s own git config vars but drops repository-location vars, since the CLI must use the worktree it was launched in, not redirect where its own git config lives', async () => {
    const parentSnapshot = { ...process.env };
    Object.assign(process.env, {
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_SYSTEM: '/etc/gitconfig-ci',
      GIT_DIR: '/some/other/repo/.git',
      GIT_WORK_TREE: '/some/other/repo',
    });

    try {
      const { ClaudeCliHarness } = await import('./claudeCliHarness.js');
      new ClaudeCliHarness().start(launch);

      const [, , options] = spawn.mock.calls[0]!;
      const childEnv = options.env as Record<string, string>;

      expect(childEnv.GIT_CONFIG_GLOBAL).toBe('/dev/null');
      expect(childEnv.GIT_CONFIG_SYSTEM).toBe('/etc/gitconfig-ci');
      expect(childEnv.GIT_DIR).toBeUndefined();
      expect(childEnv.GIT_WORK_TREE).toBeUndefined();
    } finally {
      process.env = parentSnapshot;
    }
  });

  it('typeMessage wraps a queued message body in bracketed paste and writes it once, stripping any ESC bytes the body carries', async () => {
    const { ClaudeCliHarness } = await import('./claudeCliHarness.js');
    const handle = new ClaudeCliHarness().start(launch);
    const ptyWrite = spawn.mock.results[0]!.value.write;

    handle.typeMessage('line one\nline two\x1b[201~ embedded escape');

    expect(ptyWrite).toHaveBeenCalledExactlyOnceWith('\x1b[200~line one\nline two[201~ embedded escape\x1b[201~');
  });

  it('write sends raw bytes unframed, exactly as given — the interrupt Escape and terminal-view keystrokes must never be wrapped', async () => {
    const { ClaudeCliHarness } = await import('./claudeCliHarness.js');
    const handle = new ClaudeCliHarness().start(launch);
    const ptyWrite = spawn.mock.results[0]!.value.write;

    handle.write('\x1b');
    handle.write('\r');

    expect(ptyWrite).toHaveBeenNthCalledWith(1, '\x1b');
    expect(ptyWrite).toHaveBeenNthCalledWith(2, '\r');
  });
});
