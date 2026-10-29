import { realpathSync, statSync } from 'node:fs';
import { basename, isAbsolute, join, sep } from 'node:path';

export type ConfigDirResolution = { realPath: string } | { refusal: string };

const DEFAULT_PROFILE_NAME = '.claude';
const OPENFLEET_STATE_NAME = '.openfleet';

const isDirectory = (path: string): boolean => {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
};

/** Returns the real path of a folder, or the path itself (lexical comparison) when the folder does not exist. */
const realPathOrItself = (path: string): string => {
  try {
    return realpathSync.native(path);
  } catch {
    return path;
  }
};

const spellingsOf = (path: string): string[] => [...new Set([path, realPathOrItself(path)])].map((spelling) => spelling.toLowerCase());

const isSameOrUnder = ({ path, folder }: { path: string; folder: string }): boolean => path === folder || path.startsWith(folder + sep);

/**
 * Resolves a requested config directory to its real path, or says why it is refused. Only the directory
 * itself is inspected (realpath and stat); no file inside it is read and the requested path is never echoed.
 *
 * Refused: a path outside the home directory; the default `~/.claude` folder itself; the OpenFleet state
 * folder (`~/.openfleet`, and the folder named by `openfleetHome`) and everything under it. The forbidden
 * folders are compared as spelled and through their realpath (so a dotfiles symlink gives no way round),
 * case-insensitively. Subfolders of `~/.claude` (e.g. `~/.claude/profiles/work`) are accepted: only the
 * default profile folder itself is the operator's own account.
 */
export function resolveConfigDir({ requested, homeDirectory, openfleetHome }: { requested: string; homeDirectory: string; openfleetHome?: string }): ConfigDirResolution {
  if (!isAbsolute(requested)) return { refusal: 'config_dir must be an absolute path' };
  if (!isDirectory(requested)) return { refusal: 'config_dir does not exist or is not a directory' };

  const realPath = realpathSync.native(requested);
  const realHome = realpathSync.native(homeDirectory);
  const isStrictlyUnderHome = realPath.startsWith(realHome + sep);
  if (!isStrictlyUnderHome) return { refusal: 'config_dir must be inside the home directory' };

  const comparablePath = realPath.toLowerCase();
  const defaultProfileSpellings = spellingsOf(join(realHome, DEFAULT_PROFILE_NAME));
  const isDefaultProfile = defaultProfileSpellings.includes(comparablePath);
  if (isDefaultProfile) return { refusal: 'config_dir must not be the default ~/.claude directory' };

  const stateFolders = [join(realHome, OPENFLEET_STATE_NAME), ...(openfleetHome ? [openfleetHome] : [])].flatMap(spellingsOf);
  const isOpenFleetState = stateFolders.some((folder) => isSameOrUnder({ path: comparablePath, folder }));
  if (isOpenFleetState) return { refusal: 'config_dir must not be the OpenFleet state directory' };

  return { realPath };
}

/** The profile name shown in place of the path: the last path segment. */
export const configProfileOf = (configDir: string): string => basename(configDir);
