import { cpSync, existsSync, lstatSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import type { HooksPathMissingWarning } from '@openfleet/shared';
import { isPathWithin, run } from './worktrees.js';

const PATH_SEPARATORS = /[\\/]/;
const PARENT_SEGMENT = '..';

async function hooksPathOf(repoPath: string, env?: NodeJS.ProcessEnv): Promise<string | undefined> {
  try {
    const { stdout } = await run(['config', '--local', '--get', 'core.hooksPath'], { cwd: repoPath, env });
    return stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

const isRelativeWithoutParentSegment = (path: string): boolean => !isAbsolute(path) && !path.split(PATH_SEPARATORS).includes(PARENT_SEGMENT);
const isSymbolicLink = (path: string): boolean => lstatSync(path).isSymbolicLink();

function isPlainDirectoryWithin(directory: string, root: string): boolean {
  const isPlainDirectory = !isSymbolicLink(directory) && statSync(directory).isDirectory();
  return isPlainDirectory && isPathWithin(directory, root);
}

/**
 * Copies the hooks directory the repository configures (`core.hooksPath`, relative to the repository) into the new worktree, where git
 * looks for it. A husky `.husky/_` is generated and untracked, so a fresh worktree has none and git then runs no hook at all.
 * An absolute or `..` hooks path, a symbolic-link directory and a directory leaving the repository are left alone; symbolic links
 * inside the directory are not copied. Answers the warning to report when the repository configures a hooks directory that could not be provided.
 */
export async function provideHooksDirectory(input: { repoPath: string; worktreePath: string; env?: NodeJS.ProcessEnv }): Promise<HooksPathMissingWarning | undefined> {
  const hooksPath = await hooksPathOf(input.repoPath, input.env);
  if (hooksPath === undefined || !isRelativeWithoutParentSegment(hooksPath)) return undefined;

  const missingHooks: HooksPathMissingWarning = { type: 'hooks_path_missing', hooksPath };
  const source = join(input.repoPath, hooksPath);
  const destination = join(input.worktreePath, hooksPath);
  if (!existsSync(source)) return missingHooks;
  if (!isPlainDirectoryWithin(source, input.repoPath)) return undefined;
  if (existsSync(destination)) return undefined;

  try {
    mkdirSync(dirname(destination), { recursive: true });
    if (!isPathWithin(dirname(destination), input.worktreePath)) return undefined;
    cpSync(source, destination, { recursive: true, filter: (entry) => !isSymbolicLink(entry) });
    return undefined;
  } catch {
    rmSync(destination, { recursive: true, force: true });
    return missingHooks;
  }
}
