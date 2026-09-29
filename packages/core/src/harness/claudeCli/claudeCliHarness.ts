import { homedir } from 'node:os';
import { join } from 'node:path';
import * as pty from 'node-pty';
import type { Harness, HarnessHandle, HarnessLaunch } from '../harness.js';
import { childEnvironmentForClaudeCli } from '../../process/childEnvironment.js';
import { log } from '../../logger.js';
import { frameForPaste } from './bracketedPaste.js';
import { hasConversationTranscript } from './claudeProjects.js';
import { buildClaudeLaunchConfig } from './launchConfig.js';
import { deleteTokenFiles, pathsIn, tokenFilesDirFor, writeTokenFiles } from './tokenFiles.js';
import { markDirectoryTrusted } from './trustDirectory.js';

export class ClaudeCliHarness implements Harness {
  readonly id = 'claude-cli' as const;

  constructor(private readonly sessionsRoot: string = join(homedir(), '.openfleet', 'sessions')) {}

  conversationExists(conversation: { cliSessionId: string; directory: string }): boolean {
    return hasConversationTranscript(conversation);
  }

  start(launch: HarnessLaunch): HarnessHandle {
    // Every session runs in a directory this daemon itself created (a worktree
    // under OPENFLEET_HOME, or one the operator pointed the daemon at) — Claude
    // Code's first-run folder-trust dialog would otherwise block the PTY
    // forever waiting for a keypress nothing ever sends.
    markDirectoryTrusted(join(homedir(), '.claude.json'), launch.directory);
    // A fresh per-launch directory (not just per-session) so a resume, reopen, or crash-recovery relaunch
    // never collides with a file an earlier, not-yet-cleaned-up launch of the same session left behind.
    const tokenFilesDir = tokenFilesDirFor(this.sessionsRoot, launch.sessionId);
    const config = buildClaudeLaunchConfig(launch, pathsIn(tokenFilesDir));
    writeTokenFiles(tokenFilesDir, config.settings, config.mcpConfig, config.hookCurlConfig);
    let process: pty.IPty;
    try {
      process = pty.spawn(config.command, config.args, {
        name: 'xterm-256color',
        cols: 120,
        rows: 40,
        cwd: launch.directory,
        env: { ...childEnvironmentForClaudeCli(globalThis.process.env), TERM: 'xterm-256color' },
      });
    } catch (err) {
      deleteTokenFiles(tokenFilesDir);
      throw err;
    }
    let cleanedUp = false;
    process.onExit(() => {
      if (cleanedUp) return;
      cleanedUp = true;
      try {
        deleteTokenFiles(tokenFilesDir);
      } catch (err) {
        log('error', `claudeCliHarness: failed to delete session token files at ${tokenFilesDir}`, err);
      }
    });
    return {
      write: (data) => process.write(data),
      typeMessage: (body) => process.write(frameForPaste(body)),
      resize: (cols, rows) => process.resize(cols, rows),
      kill: (options) => process.kill(options?.force ? 'SIGKILL' : 'SIGTERM'),
      onData: (listener) => process.onData(listener).dispose,
      onExit: (listener) => process.onExit(({ exitCode }) => listener(exitCode)).dispose,
    };
  }
}
