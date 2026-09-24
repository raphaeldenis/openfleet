import * as pty from 'node-pty';
import type { Harness, HarnessHandle, HarnessLaunch } from '../harness.js';
import { buildClaudeLaunchConfig } from './launchConfig.js';

export class ClaudeCliHarness implements Harness {
  readonly id = 'claude-cli' as const;

  start(launch: HarnessLaunch): HarnessHandle {
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
