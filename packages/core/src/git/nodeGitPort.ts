import { execFileSync } from 'node:child_process';
import { statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import type { GitPort } from '../notes/handoffService.js';

const GIT_TIMEOUT_MS = 2_000;
const MAX_OUTPUT_BYTES = 256 * 1024;
const OUTPUT_OVERFLOW_CODE = 'ENOBUFS';

/** Neutralises what a repository's own config or the user's global config could make git do: spawn a monitor, page, colour, or run an external diff. */
const NON_INTERACTIVE_CONFIG = ['-c', 'core.fsmonitor=false', '-c', 'core.pager=cat', '-c', 'color.ui=never'];

export interface NodeGitPortOptions {
  timeoutMs?: number;
  maxBufferBytes?: number;
  gitExecutable?: string;
}

/**
 * Read-only git access through `execFile` (argv array, never a shell), safe to call while an agent works in the same repository.
 *
 * - git gets only PATH, HOME and non-interactive flags: the daemon's secrets and GIT_DIR/GIT_WORK_TREE never reach it.
 * - `GIT_OPTIONAL_LOCKS=0` keeps `status` from taking the index lock the agent may need.
 * - Throws when git cannot answer (relative or missing directory, not a repository, git missing, timeout).
 * - Output beyond the buffer cap is cut after its last complete line instead of failing.
 */
export function createNodeGitPort(options: NodeGitPortOptions = {}): GitPort {
  const { timeoutMs = GIT_TIMEOUT_MS, maxBufferBytes = MAX_OUTPUT_BYTES, gitExecutable = 'git' } = options;

  const runGit = (directory: string, subcommand: string[]): string => {
    assertExistingAbsoluteDirectory(directory);
    try {
      return execFileSync(gitExecutable, [...NON_INTERACTIVE_CONFIG, ...subcommand], {
        cwd: directory,
        env: minimalGitEnvironment(),
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: timeoutMs,
        killSignal: 'SIGKILL',
        maxBuffer: maxBufferBytes,
      });
    } catch (error) {
      const outputOverflowed = (error as NodeJS.ErrnoException).code === OUTPUT_OVERFLOW_CODE;
      const partialOutput = (error as { stdout?: unknown }).stdout;
      if (outputOverflowed && typeof partialOutput === 'string') return keepCompleteLines(partialOutput);
      throw error;
    }
  };

  return {
    statusShort: (directory) => runGit(directory, ['status', '--short']),
    diffStatOf: (directory) => runGit(directory, ['diff', '--stat', '--no-ext-diff', '--no-textconv']),
  };
}

function minimalGitEnvironment(): NodeJS.ProcessEnv {
  const { PATH, HOME } = process.env;
  return {
    ...(PATH === undefined ? {} : { PATH }),
    ...(HOME === undefined ? {} : { HOME }),
    GIT_TERMINAL_PROMPT: '0',
    GIT_OPTIONAL_LOCKS: '0',
    GIT_PAGER: 'cat',
  };
}

function assertExistingAbsoluteDirectory(directory: string): void {
  if (!isAbsolute(directory)) throw new Error('git directory must be an absolute path');
  const stats = statSync(directory, { throwIfNoEntry: false });
  if (!stats) throw new Error('git directory does not exist');
  if (!stats.isDirectory()) throw new Error('git directory is not a directory');
}

function keepCompleteLines(output: string): string {
  const endOfLastCompleteLine = output.lastIndexOf('\n');
  return endOfLastCompleteLine === -1 ? '' : output.slice(0, endOfLastCompleteLine + 1);
}
