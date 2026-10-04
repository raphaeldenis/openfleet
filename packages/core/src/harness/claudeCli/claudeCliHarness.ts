import { homedir } from 'node:os';
import { join } from 'node:path';
import * as pty from 'node-pty';
import { OpenFleetError } from '@openfleet/shared';
import { findExecutable, pathDirectoriesOf } from '../../process/executableOnPath.js';
import type { ConversationPresence, Harness, HarnessHandle, HarnessLaunch } from '../harness.js';
import { childEnvironmentForClaudeCli } from '../../process/childEnvironment.js';
import { log } from '../../logger.js';
import { frameForPaste } from './bracketedPaste.js';
import { conversationPresence } from './claudeProjects.js';
import { buildClaudeLaunchConfig } from './launchConfig.js';
import { findPermissiveSettingsWarning } from './permissiveSettings.js';
import { deleteTokenFiles, pathsIn, tokenFilesDirFor, writeTokenFiles } from './tokenFiles.js';
import { markDirectoryTrusted } from './trustDirectory.js';

export class ClaudeCliHarness implements Harness {
  readonly id = 'claude-cli' as const;

  constructor(
    private readonly sessionsRoot: string = join(homedir(), '.openfleet', 'sessions'),
    private readonly env: NodeJS.ProcessEnv = globalThis.process.env,
    private readonly claudeConfigPath: string = join(homedir(), '.claude.json'),
  ) {}

  conversationExists(conversation: { cliSessionId: string; directory: string }): ConversationPresence {
    return conversationPresence(conversation);
  }

  findProjectSettingsWarning(directory: string): string | undefined {
    return findPermissiveSettingsWarning(directory);
  }

  start(launch: HarnessLaunch): HarnessHandle {
    this.assertClaudeIsOnThePath();
    // Every session runs in a directory this daemon itself created (a worktree
    // under OPENFLEET_HOME, or one the operator pointed the daemon at) — Claude
    // Code's first-run folder-trust dialog would otherwise block the PTY
    // forever waiting for a keypress nothing ever sends.
    markDirectoryTrusted(this.claudeConfigPath, launch.directory);
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
        env: { ...childEnvironmentForClaudeCli(this.env), TERM: 'xterm-256color' },
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
      onExit: (listener) => process.onExit((exit) => listener(exitCodeOf(exit))).dispose,
    };
  }

  // Resolved on the PATH the pty gets. The envelope carries no PATH: the log line names the directories searched.
  private assertClaudeIsOnThePath(): void {
    const searchedDirectories = pathDirectoriesOf(this.env);
    if (findExecutable(CLAUDE_COMMAND, searchedDirectories) !== undefined) return;
    log('warn', 'claude is not executable in any PATH directory of the daemon', undefined, { code: 'claude_not_found', searchedDirectories });
    throw new OpenFleetError('claude_not_found', 'the claude CLI is not on the daemon PATH.', { hint: 'Install Claude Code or start the daemon from a shell where claude runs.' });
  }
}

const CLAUDE_COMMAND = 'claude';
const SIGNAL_EXIT_CODE_BASE = 128;

// node-pty reports a signal death as exitCode 0 plus the signal; the shell convention (128 + signal) keeps it distinguishable from a clean exit.
function exitCodeOf({ exitCode, signal }: { exitCode: number; signal?: number }): number {
  const wasKilledBySignal = signal !== undefined && signal > 0;
  return wasKilledBySignal ? SIGNAL_EXIT_CODE_BASE + signal : exitCode;
}
