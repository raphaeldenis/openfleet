import { existsSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import type { WorktreeSetupWarning } from '@openfleet/shared';
import { basicEnvironment, runScript, unstartableReasonOf } from './scriptProcess.js';
import { isPathWithin } from './worktrees.js';

export const SETUP_SCRIPT_RELATIVE_PATH = join('scripts', 'worktree-setup.sh');
export const DEFAULT_SETUP_TIMEOUT_MS = 300_000;
const MAX_OUTPUT_TAIL_BYTES = 16 * 1024;

export interface WorktreeSetupInput {
  repoPath: string;
  worktreePath: string;
  branch: string;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
}

function setupEnvironment(input: WorktreeSetupInput): NodeJS.ProcessEnv {
  return {
    ...basicEnvironment(input.env ?? process.env),
    OPENFLEET_WORKTREE_PATH: input.worktreePath,
    OPENFLEET_BRANCH: input.branch,
    OPENFLEET_REPO_PATH: input.repoPath,
  };
}

const failure = (reason: WorktreeSetupWarning['reason']): WorktreeSetupWarning => ({ type: 'worktree_setup_failed', reason });

/**
 * Runs `scripts/worktree-setup.sh` of the repository in the new worktree, so a fresh worktree gets what `pnpm install` generates (husky hooks).
 * Answers the warning to report, or undefined when the script succeeded or the repository has none. The script is resolved through its
 * real path and must stay inside the repository; it runs with no shell, no argument, the daemon's basic environment and a hard timeout.
 * It never throws, so the worktree exists whatever the script does.
 */
export async function runWorktreeSetupScript(input: WorktreeSetupInput): Promise<WorktreeSetupWarning | undefined> {
  const script = join(input.repoPath, SETUP_SCRIPT_RELATIVE_PATH);
  const hasNoSetupScript = !existsSync(script);
  if (hasNoSetupScript) return undefined;

  const realScript = realpathOrUndefined(script);
  if (realScript === undefined) return failure('not_found');
  const isOutsideRepository = !isPathWithin(realScript, input.repoPath);
  if (isOutsideRepository) return failure('outside_repository');

  const unstartableReason = unstartableReasonOf(realScript);
  if (unstartableReason) return failure(unstartableReason);

  const scriptFailure = await runScript({
    script: realScript, workingDirectory: input.worktreePath, env: setupEnvironment(input), timeoutMs: input.timeoutMs ?? DEFAULT_SETUP_TIMEOUT_MS, maxOutputTailBytes: MAX_OUTPUT_TAIL_BYTES,
  });
  return scriptFailure && { type: 'worktree_setup_failed', ...scriptFailure };
}

function realpathOrUndefined(path: string): string | undefined {
  try {
    return realpathSync(path);
  } catch {
    return undefined;
  }
}
