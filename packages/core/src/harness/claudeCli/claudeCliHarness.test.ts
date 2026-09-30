import { existsSync, mkdtempSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { markDirectoryTrusted } from './trustDirectory.js';

type ExitListener = (event: { exitCode: number; signal?: number }) => void;

const spawn = vi.fn((_command: string, _args: string[], _options: { env: Record<string, string> }) => {
  const exitListeners: ExitListener[] = [];
  return {
    onData: () => ({ dispose: () => undefined }),
    onExit: (listener: ExitListener) => {
      exitListeners.push(listener);
      return { dispose: () => undefined };
    },
    write: vi.fn(),
    resize: () => undefined,
    kill: () => undefined,
    // Test-only: simulates the pty actually exiting, so tests can assert on the harness's own
    // internal onExit-triggered cleanup, not just the onExit forwarded out through HarnessHandle.
    emitExit: (exitCode = 0, signal?: number) => exitListeners.forEach((listener) => listener({ exitCode, signal })),
  };
});

vi.mock('node-pty', () => ({ spawn }));
vi.mock('./trustDirectory.js', () => ({ markDirectoryTrusted: vi.fn() }));
// These tests cover the spawn itself, not whether claude exists on the machine running them (claudeCliHarness.notFound.test.ts does).
vi.mock('../../process/executableOnPath.js', async (importOriginal) => ({ ...(await importOriginal<object>()), findExecutable: () => '/mocked/bin/claude' }));

const launch = {
  sessionId: '11111111-1111-4111-8111-111111111111',
  directory: '/tmp/wt',
  model: 'claude-sonnet-5',
  hookUrl: 'http://127.0.0.1:7331/hooks/tok-hook',
  mcpUrl: 'http://127.0.0.1:7331/mcp',
  mcpToken: 'tok-mcp',
  displayName: '⚔️ Gimli - CCM-1',
};

const modeOf = (path: string): number => statSync(path).mode & 0o777;

describe('ClaudeCliHarness', () => {
  let sessionsRoot: string;

  beforeEach(() => {
    spawn.mockClear();
    sessionsRoot = mkdtempSync(join(tmpdir(), 'of-sessions-'));
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
      new ClaudeCliHarness(sessionsRoot).start(launch);

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
      new ClaudeCliHarness(sessionsRoot).start(launch);

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
      new ClaudeCliHarness(sessionsRoot).start(launch);

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
      new ClaudeCliHarness(sessionsRoot).start(launch);

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
    const handle = new ClaudeCliHarness(sessionsRoot).start(launch);
    const ptyWrite = spawn.mock.results[0]!.value.write;

    handle.typeMessage('line one\nline two\x1b[201~ embedded escape');

    expect(ptyWrite).toHaveBeenCalledExactlyOnceWith('\x1b[200~line one\nline two[201~ embedded escape\x1b[201~');
  });

  it('write sends raw bytes unframed, exactly as given — the interrupt Escape and terminal-view keystrokes must never be wrapped', async () => {
    const { ClaudeCliHarness } = await import('./claudeCliHarness.js');
    const handle = new ClaudeCliHarness(sessionsRoot).start(launch);
    const ptyWrite = spawn.mock.results[0]!.value.write;

    handle.write('\x1b');
    handle.write('\r');

    expect(ptyWrite).toHaveBeenNthCalledWith(1, '\x1b');
    expect(ptyWrite).toHaveBeenNthCalledWith(2, '\r');
  });

  it('passes the CLI only settings/mcp-config file paths in argv — never the hook token or the mcp bearer token', async () => {
    const { ClaudeCliHarness } = await import('./claudeCliHarness.js');
    new ClaudeCliHarness(sessionsRoot).start(launch);

    const [, args] = spawn.mock.calls[0]!;
    const argvBlob = (args as string[]).join(' ');

    expect(argvBlob).not.toContain('tok-hook');
    expect(argvBlob).not.toContain('tok-mcp');
    const settingsFlagIndex = (args as string[]).indexOf('--settings');
    const mcpConfigFlagIndex = (args as string[]).indexOf('--mcp-config');
    expect(existsSync((args as string[])[settingsFlagIndex + 1]!)).toBe(true);
    expect(existsSync((args as string[])[mcpConfigFlagIndex + 1]!)).toBe(true);
  });

  it('writes the settings file at 0600 inside a 0700 per-session directory, carrying the hook token', async () => {
    const { ClaudeCliHarness } = await import('./claudeCliHarness.js');
    new ClaudeCliHarness(sessionsRoot).start(launch);

    const [, args] = spawn.mock.calls[0]!;
    const settingsPath = (args as string[])[(args as string[]).indexOf('--settings') + 1]!;

    expect(modeOf(settingsPath)).toBe(0o600);
    expect(modeOf(join(settingsPath, '..'))).toBe(0o700);
    const settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
    expect(JSON.stringify(settings)).toContain('tok-hook');
  });

  it('never lets the SessionStart command string carry the hook token — only a 0600 curl config file next to settings.json does, invisible to `ps`', async () => {
    const { ClaudeCliHarness } = await import('./claudeCliHarness.js');
    new ClaudeCliHarness(sessionsRoot).start(launch);

    const [, args] = spawn.mock.calls[0]!;
    const settingsPath = (args as string[])[(args as string[]).indexOf('--settings') + 1]!;
    const settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
    const sessionStartCommand = settings.hooks.SessionStart[0].hooks[0].command as string;
    expect(sessionStartCommand).not.toContain('tok-hook');

    const hookCurlConfigPath = join(settingsPath, '..', 'hook-curl.conf');
    expect(modeOf(hookCurlConfigPath)).toBe(0o600);
    expect(readFileSync(hookCurlConfigPath, 'utf8')).toBe(`url = "${launch.hookUrl}"`);
  });

  it('writes the mcp-config file at 0600, carrying the bearer token', async () => {
    const { ClaudeCliHarness } = await import('./claudeCliHarness.js');
    new ClaudeCliHarness(sessionsRoot).start(launch);

    const [, args] = spawn.mock.calls[0]!;
    const mcpConfigPath = (args as string[])[(args as string[]).indexOf('--mcp-config') + 1]!;

    expect(modeOf(mcpConfigPath)).toBe(0o600);
    const mcpConfig = JSON.parse(readFileSync(mcpConfigPath, 'utf8'));
    expect(mcpConfig.mcpServers.openfleet.headers.Authorization).toBe('Bearer tok-mcp');
  });

  it('deletes the settings and mcp-config files once the CLI process exits', async () => {
    const { ClaudeCliHarness } = await import('./claudeCliHarness.js');
    new ClaudeCliHarness(sessionsRoot).start(launch);

    const [, args] = spawn.mock.calls[0]!;
    const settingsPath = (args as string[])[(args as string[]).indexOf('--settings') + 1]!;
    const mcpConfigPath = (args as string[])[(args as string[]).indexOf('--mcp-config') + 1]!;
    expect(existsSync(settingsPath)).toBe(true);

    spawn.mock.results[0]!.value.emitExit(0);

    expect(existsSync(settingsPath)).toBe(false);
    expect(existsSync(mcpConfigPath)).toBe(false);
  });

  it.each([
    { label: 'a SIGKILL that node-pty reports as exit code 0', exit: { exitCode: 0, signal: 9 }, reported: 137 },
    { label: 'a SIGTERM', exit: { exitCode: 0, signal: 15 }, reported: 143 },
    { label: 'a SIGHUP', exit: { exitCode: 0, signal: 1 }, reported: 129 },
    { label: 'a clean exit with signal 0', exit: { exitCode: 0, signal: 0 }, reported: 0 },
    { label: 'a clean exit with no signal', exit: { exitCode: 0, signal: undefined }, reported: 0 },
    { label: 'a failing exit code with no signal', exit: { exitCode: 1, signal: undefined }, reported: 1 },
  ])('reports $label as exit code $reported to the exit listener', async ({ exit, reported }) => {
    const { ClaudeCliHarness } = await import('./claudeCliHarness.js');
    const handle = new ClaudeCliHarness(sessionsRoot).start(launch);
    const reportedExitCodes: number[] = [];
    handle.onExit((exitCode) => reportedExitCodes.push(exitCode));

    spawn.mock.results[0]!.value.emitExit(exit.exitCode, exit.signal);

    expect(reportedExitCodes).toEqual([reported]);
  });

  it('removes every token file it just wrote, not just some, when pty.spawn throws right after they land on disk', async () => {
    const { ClaudeCliHarness } = await import('./claudeCliHarness.js');
    spawn.mockImplementationOnce(() => {
      throw new Error('boom: pty spawn failed');
    });

    expect(() => new ClaudeCliHarness(sessionsRoot).start(launch)).toThrow('boom: pty spawn failed');

    const sessionDir = join(sessionsRoot, launch.sessionId);
    expect(existsSync(sessionDir) ? readdirSync(sessionDir) : []).toEqual([]);
  });

  it('writes fresh token files carrying the rotated tokens on a resume launch, without touching the closed launch\'s own files', async () => {
    const { ClaudeCliHarness } = await import('./claudeCliHarness.js');
    const harness = new ClaudeCliHarness(sessionsRoot);
    harness.start(launch);
    const [, firstArgs] = spawn.mock.calls[0]!;
    const firstSettingsPath = (firstArgs as string[])[(firstArgs as string[]).indexOf('--settings') + 1]!;
    spawn.mock.results[0]!.value.emitExit(0); // the real daemon always kills/awaits-exit before resuming

    harness.start({ ...launch, resuming: true, hookUrl: 'http://127.0.0.1:7331/hooks/tok-hook-rotated', mcpToken: 'tok-mcp-rotated' });
    const [, secondArgs] = spawn.mock.calls[1]!;
    const secondSettingsPath = (secondArgs as string[])[(secondArgs as string[]).indexOf('--settings') + 1]!;
    const secondMcpConfigPath = (secondArgs as string[])[(secondArgs as string[]).indexOf('--mcp-config') + 1]!;

    expect(secondSettingsPath).not.toBe(firstSettingsPath);
    expect(existsSync(firstSettingsPath)).toBe(false); // deleted when the first launch's process exited
    const rotatedSettings = JSON.stringify(JSON.parse(readFileSync(secondSettingsPath, 'utf8')));
    expect(rotatedSettings).toContain('tok-hook-rotated');
    const rotatedMcpConfig = JSON.parse(readFileSync(secondMcpConfigPath, 'utf8'));
    expect(rotatedMcpConfig.mcpServers.openfleet.headers.Authorization).toBe('Bearer tok-mcp-rotated');
  });

  it('keeps the token files of a resume on the OpenFleet session id directory while resuming the CLI session id', async () => {
    const clearedCliSessionId = '22222222-2222-4222-8222-222222222222';
    const { ClaudeCliHarness } = await import('./claudeCliHarness.js');

    new ClaudeCliHarness(sessionsRoot).start({ ...launch, resuming: true, cliSessionId: clearedCliSessionId });

    const [, args] = spawn.mock.calls[0]!;
    const argv = args as string[];
    const settingsPath = argv[argv.indexOf('--settings') + 1]!;
    expect(argv.slice(0, 2)).toEqual(['--resume', clearedCliSessionId]);
    expect(settingsPath.startsWith(join(sessionsRoot, launch.sessionId))).toBe(true);
    expect(settingsPath).not.toContain(clearedCliSessionId);
  });

  it('never reuses a token file path across two launches of the same session, even when the earlier launch\'s files were never cleaned up', async () => {
    const { ClaudeCliHarness } = await import('./claudeCliHarness.js');
    const harness = new ClaudeCliHarness(sessionsRoot);

    harness.start(launch); // no emitExit: simulates an orphaned pty a daemon restart lost track of
    harness.start({ ...launch, resuming: true });

    const [, firstArgs] = spawn.mock.calls[0]!;
    const [, secondArgs] = spawn.mock.calls[1]!;
    const firstDir = join((firstArgs as string[])[(firstArgs as string[]).indexOf('--settings') + 1]!, '..');
    const secondDir = join((secondArgs as string[])[(secondArgs as string[]).indexOf('--settings') + 1]!, '..');

    expect(secondDir).not.toBe(firstDir);
    expect(existsSync(firstDir)).toBe(true); // untouched: nothing signalled that launch's process as exited
    expect(existsSync(secondDir)).toBe(true);
  });

  it('never reuses a token file path across two different sessions', async () => {
    const { ClaudeCliHarness } = await import('./claudeCliHarness.js');
    const harness = new ClaudeCliHarness(sessionsRoot);
    const otherLaunch = { ...launch, sessionId: '22222222-2222-4222-8222-222222222222' };

    harness.start(launch);
    harness.start(otherLaunch);

    const [, firstArgs] = spawn.mock.calls[0]!;
    const [, secondArgs] = spawn.mock.calls[1]!;
    const firstSettingsPath = (firstArgs as string[])[(firstArgs as string[]).indexOf('--settings') + 1]!;
    const secondSettingsPath = (secondArgs as string[])[(secondArgs as string[]).indexOf('--settings') + 1]!;

    expect(secondSettingsPath).not.toBe(firstSettingsPath);
  });

  it('keeps every session\'s files under its own subdirectory of the sessions root, nothing loose at the top level', async () => {
    const { ClaudeCliHarness } = await import('./claudeCliHarness.js');
    new ClaudeCliHarness(sessionsRoot).start(launch);

    const topLevelEntries = readdirSync(sessionsRoot);
    expect(topLevelEntries).toEqual([launch.sessionId]);
  });
});

describe('ClaudeCliHarness folder trust', () => {
  const sessionsRoot = mkdtempSync(join(tmpdir(), 'of-sessions-'));

  beforeEach(() => {
    vi.mocked(markDirectoryTrusted).mockClear();
  });

  it('marks the launch directory trusted in the configured Claude config file', async () => {
    const claudeConfigPath = join(mkdtempSync(join(tmpdir(), 'of-claude-config-')), '.claude.json');
    const { ClaudeCliHarness } = await import('./claudeCliHarness.js');

    new ClaudeCliHarness(sessionsRoot, process.env, claudeConfigPath).start(launch);

    expect(markDirectoryTrusted).toHaveBeenCalledWith(claudeConfigPath, launch.directory);
  });

  it('defaults to the .claude.json of the home directory', async () => {
    const { ClaudeCliHarness } = await import('./claudeCliHarness.js');

    new ClaudeCliHarness(sessionsRoot).start(launch);

    expect(markDirectoryTrusted).toHaveBeenCalledWith(join(homedir(), '.claude.json'), launch.directory);
  });
});
