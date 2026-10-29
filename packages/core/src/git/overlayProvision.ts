import { appendFileSync, chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, symlinkSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { OverlayUnavailableWarning } from '@openfleet/shared';
import { run } from './worktrees.js';

export const OVERLAY_LINK_NAME = '.openfleet-overlay';

const BLOCK_START = '# >>> openfleet overlay (managed)';
const BLOCK_END = '# <<< openfleet overlay';
const EXCLUDE_BLOCK = `${BLOCK_START}\n/${OVERLAY_LINK_NAME}\n${BLOCK_END}\n`;

const OVERLAY_DIRECTORY_MODE = 0o700;

/** True when something sits at the path, a dangling symbolic link included. */
function isPresent(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

function pointsToOverlay(link: string, overlayDirectory: string): boolean {
  try {
    return resolve(dirname(link), readlinkSync(link)) === resolve(overlayDirectory);
  } catch {
    return false;
  }
}

async function commonExcludeFileOf(worktreePath: string, env?: NodeJS.ProcessEnv): Promise<string> {
  const { stdout } = await run(['rev-parse', '--path-format=absolute', '--git-path', 'info/exclude'], { cwd: worktreePath, env });
  return stdout.trim();
}

/** Appends the marked block to the exclude file of the common git directory unless it is already there; every other line stays as it is. */
function addExcludeBlock(excludeFile: string): void {
  const current = existsSync(excludeFile) ? readFileSync(excludeFile, 'utf8') : '';
  if (current.includes(BLOCK_START)) return;
  const separator = current === '' || current.endsWith('\n') ? '' : '\n';
  mkdirSync(dirname(excludeFile), { recursive: true });
  appendFileSync(excludeFile, `${separator}${EXCLUDE_BLOCK}`);
}

/**
 * Gives a worktree of a shared repository the fleet's overlay directory, linked as `.openfleet-overlay` and excluded from git, so the fleet's
 * own tooling never shows up in `git status` and is never committed. The exclude file is the one of the common git directory, shared by every worktree
 * of the repository. Answers the warning to report when the overlay could not be provided, including when `.openfleet-overlay` already exists and does not point to the overlay; the directory is created (owner only) before anything else is written.
 */
export async function provideOverlay(input: { overlayDirectory: string; worktreePath: string; env?: NodeJS.ProcessEnv }): Promise<OverlayUnavailableWarning | undefined> {
  try {
    mkdirSync(input.overlayDirectory, { recursive: true, mode: OVERLAY_DIRECTORY_MODE });
    chmodSync(input.overlayDirectory, OVERLAY_DIRECTORY_MODE);
    addExcludeBlock(await commonExcludeFileOf(input.worktreePath, input.env));
    const link = join(input.worktreePath, OVERLAY_LINK_NAME);
    if (!isPresent(link)) symlinkSync(input.overlayDirectory, link, 'dir');
    return pointsToOverlay(link, input.overlayDirectory) ? undefined : { type: 'overlay_unavailable' };
  } catch {
    return { type: 'overlay_unavailable' };
  }
}
