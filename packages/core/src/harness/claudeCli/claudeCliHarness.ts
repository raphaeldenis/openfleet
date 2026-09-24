import { homedir } from 'node:os';
import { join } from 'node:path';
import * as pty from 'node-pty';
import type { Harness, HarnessHandle, HarnessLaunch } from '../harness.js';
import { buildClaudeLaunchConfig } from './launchConfig.js';
import { markDirectoryTrusted } from './trustDirectory.js';

export class ClaudeCliHarness implements Harness {
  readonly id = 'claude-cli' as const;

  start(launch: HarnessLaunch): HarnessHandle {
    // Every session runs in a directory this daemon itself created (a worktree
    // under OPENFLEET_HOME, or one the operator pointed the daemon at) — Claude
    // Code's first-run folder-trust dialog would otherwise block the PTY
    // forever waiting for a keypress nothing ever sends.
    markDirectoryTrusted(join(homedir(), '.claude.json'), launch.directory);
    const config = buildClaudeLaunchConfig(launch);
    const process = pty.spawn(config.command, config.args, {
      name: 'xterm-256color',
      cols: 120,
      rows: 40,
      cwd: launch.directory,
      env: { ...globalThis.process.env, TERM: 'xterm-256color' },
    });
    return {
      write: (data) => process.write(data),
      resize: (cols, rows) => process.resize(cols, rows),
      kill: () => process.kill(),
      onData: (listener) => process.onData(listener).dispose,
      onExit: (listener) => process.onExit(({ exitCode }) => listener(exitCode)).dispose,
    };
  }
}
