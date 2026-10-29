import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { markDirectoryTrusted } from './trustDirectory.js';

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
  directory: '/tmp/wt',
  hookUrl: 'http://127.0.0.1:7331/hooks/tok-hook',
  mcpUrl: 'http://127.0.0.1:7331/mcp',
  mcpToken: 'tok-mcp',
  displayName: '⚔️ Gimli - CCM-1',
};
const syntheticProfile = '/Users/synthetic/.claude-work';

describe('ClaudeCliHarness with a config dir', () => {
  let sessionsRoot: string;

  beforeEach(() => {
    spawn.mockClear();
    vi.mocked(markDirectoryTrusted).mockClear();
    sessionsRoot = mkdtempSync(join(tmpdir(), 'of-sessions-'));
  });

  it('passes the config dir to the CLI as CLAUDE_CONFIG_DIR', async () => {
    const { ClaudeCliHarness } = await import('./claudeCliHarness.js');

    new ClaudeCliHarness(sessionsRoot, { PATH: '/bin' }).start({ ...launch, configDir: syntheticProfile });

    const [, , options] = spawn.mock.calls[0]!;
    expect(options.env.CLAUDE_CONFIG_DIR).toBe(syntheticProfile);
  });

  it('overrides a CLAUDE_CONFIG_DIR the daemon itself inherited', async () => {
    const { ClaudeCliHarness } = await import('./claudeCliHarness.js');

    new ClaudeCliHarness(sessionsRoot, { PATH: '/bin', CLAUDE_CONFIG_DIR: '/Users/synthetic/.claude-inherited' }).start({ ...launch, configDir: syntheticProfile });

    const [, , options] = spawn.mock.calls[0]!;
    expect(options.env.CLAUDE_CONFIG_DIR).toBe(syntheticProfile);
  });

  it('leaves the inherited environment untouched when no config dir is given', async () => {
    const { ClaudeCliHarness } = await import('./claudeCliHarness.js');

    new ClaudeCliHarness(sessionsRoot, { PATH: '/bin', CLAUDE_CONFIG_DIR: '/Users/synthetic/.claude-inherited' }).start(launch);

    const [, , options] = spawn.mock.calls[0]!;
    expect(options.env.CLAUDE_CONFIG_DIR).toBe('/Users/synthetic/.claude-inherited');
  });

  it('does not set CLAUDE_CONFIG_DIR when neither a config dir nor an inherited value exists', async () => {
    const { ClaudeCliHarness } = await import('./claudeCliHarness.js');

    new ClaudeCliHarness(sessionsRoot, { PATH: '/bin' }).start(launch);

    const [, , options] = spawn.mock.calls[0]!;
    expect(options.env).not.toHaveProperty('CLAUDE_CONFIG_DIR');
  });

  it('does not touch the profile folder to mark the directory trusted', async () => {
    const { ClaudeCliHarness } = await import('./claudeCliHarness.js');

    new ClaudeCliHarness(sessionsRoot, { PATH: '/bin' }).start({ ...launch, configDir: syntheticProfile });

    expect(markDirectoryTrusted).not.toHaveBeenCalled();
  });

  it('still marks the directory trusted in the default config when no config dir is given', async () => {
    const { ClaudeCliHarness } = await import('./claudeCliHarness.js');

    new ClaudeCliHarness(sessionsRoot, { PATH: '/bin' }).start(launch);

    expect(markDirectoryTrusted).toHaveBeenCalledTimes(1);
  });

  it('reports the conversation of a config dir session as unknown, without reading any transcript folder', async () => {
    const { ClaudeCliHarness } = await import('./claudeCliHarness.js');

    const presence = new ClaudeCliHarness(sessionsRoot).conversationExists({ cliSessionId: launch.sessionId, directory: launch.directory, configDir: syntheticProfile });

    expect(presence).toBe('unknown');
  });
});
