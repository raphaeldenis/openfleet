import { writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from './config.js';
import { startDaemon, type Daemon } from './daemon.js';
import { markDirectoryTrusted } from './harness/claudeCli/trustDirectory.js';
import { createTempDirTracker } from './tempDirTracker.js';

// The real ClaudeCliHarness runs here, with its trust write intercepted and no process ever spawned.
vi.mock('node-pty', () => ({ spawn: () => { throw new Error('no process is spawned by this test'); } }));
vi.mock('./harness/claudeCli/trustDirectory.js', () => ({ markDirectoryTrusted: vi.fn() }));
vi.mock('./process/executableOnPath.js', async (importOriginal) => ({ ...(await importOriginal<object>()), findExecutable: () => '/mocked/bin/claude' }));

const tempDirs = createTempDirTracker();
let daemon: Daemon | undefined;

afterEach(async () => {
  vi.restoreAllMocks();
  await daemon?.close();
  daemon = undefined;
  tempDirs.removeAll();
});

describe('the folder trust of a booted daemon', () => {
  it('goes to the Claude config file the daemon is given, never to the real home one', async () => {
    const home = tempDirs.make('of-daemon-claude-config-');
    writeFileSync(join(home, 'config.json'), '{}');
    const claudeConfigPath = join(home, '.claude.json');
    const config = loadConfig({ OPENFLEET_HOME: home, OPENFLEET_PORT: '0' });
    daemon = await startDaemon(config, { claudeConfigPath });
    vi.spyOn(console, 'error').mockImplementation(() => {});

    await fetch(`${daemon.server.url}/api/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${config.adminToken}` },
      body: JSON.stringify({ directory: home, name: 'Boss', harness: 'claude-cli', emoji: '🤖' }),
    });

    const trustedConfigPaths = vi.mocked(markDirectoryTrusted).mock.calls.map(([configPath]) => configPath);
    expect(trustedConfigPaths).toEqual([claudeConfigPath]);
    expect(trustedConfigPaths).not.toContain(join(homedir(), '.claude.json'));
  });
});
