import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
vi.mock('../../process/executableOnPath.js', async (importOriginal) => ({ ...(await importOriginal<object>()), findExecutable: () => '/mocked/bin/claude' }));

const launch = {
  sessionId: '11111111-1111-4111-8111-111111111111',
  directory: '/tmp/arbiter-cwd',
  hookUrl: 'http://127.0.0.1:7331/hooks/tok-hook',
  mcpUrl: 'http://127.0.0.1:7331/mcp',
  mcpToken: 'tok-mcp',
  displayName: '⚖️ Arbiter',
};
const ticketWorktree = '/work/ticket';
const CLAUDE_MD_OF_ADDED_DIRECTORIES = 'CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD';

describe('ClaudeCliHarness with read directories', () => {
  let sessionsRoot: string;

  beforeEach(() => {
    spawn.mockClear();
    sessionsRoot = mkdtempSync(join(tmpdir(), 'of-sessions-'));
  });

  it.each(['1', 'true', '0'])('turns off the CLAUDE.md of added directories when the daemon environment sets it to %s', async (daemonValue) => {
    const { ClaudeCliHarness } = await import('./claudeCliHarness.js');

    new ClaudeCliHarness(sessionsRoot, { PATH: '/bin', [CLAUDE_MD_OF_ADDED_DIRECTORIES]: daemonValue }).start({ ...launch, readDirectories: [ticketWorktree] });

    const [, , options] = spawn.mock.calls[0]!;
    expect(options.env[CLAUDE_MD_OF_ADDED_DIRECTORIES]).toBe('0');
  });

  it('turns off the CLAUDE.md of added directories when the daemon environment does not mention it', async () => {
    const { ClaudeCliHarness } = await import('./claudeCliHarness.js');

    new ClaudeCliHarness(sessionsRoot, { PATH: '/bin' }).start({ ...launch, readDirectories: [ticketWorktree] });

    const [, , options] = spawn.mock.calls[0]!;
    expect(options.env[CLAUDE_MD_OF_ADDED_DIRECTORIES]).toBe('0');
  });

  it('passes the daemon value through untouched when the launch has no read directories', async () => {
    const { ClaudeCliHarness } = await import('./claudeCliHarness.js');

    new ClaudeCliHarness(sessionsRoot, { PATH: '/bin', [CLAUDE_MD_OF_ADDED_DIRECTORIES]: '1' }).start(launch);

    const [, , options] = spawn.mock.calls[0]!;
    expect(options.env[CLAUDE_MD_OF_ADDED_DIRECTORIES]).toBe('1');
  });

  it('does not set the variable when the launch has an empty list of read directories and the daemon has none', async () => {
    const { ClaudeCliHarness } = await import('./claudeCliHarness.js');

    new ClaudeCliHarness(sessionsRoot, { PATH: '/bin' }).start({ ...launch, readDirectories: [] });

    const [, , options] = spawn.mock.calls[0]!;
    expect(options.env).not.toHaveProperty(CLAUDE_MD_OF_ADDED_DIRECTORIES);
  });
});
