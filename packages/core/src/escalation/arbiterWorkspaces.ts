import { chmodSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

const WORKSPACE_PREFIX = 'arbiter-';
const OWNER_ONLY = 0o700;

/** The empty working directories the arbiters start in, so no instruction file of a repository is read as project instructions. */
export interface ArbiterWorkspaces {
  /** Creates an empty directory only its owner can use and answers its real path. */
  create(): string;
  /** Removes a workspace of the root; any other path is left alone. */
  remove(path: string): void;
  /** Removes every workspace of the root that is not in `keep`. */
  removeAllExcept(keep: ReadonlySet<string>): void;
}

const realPathOrUndefined = (path: string): string | undefined => {
  try {
    return realpathSync.native(path);
  } catch {
    return undefined;
  }
};

export function createArbiterWorkspaces(root: string): ArbiterWorkspaces {
  const isWorkspaceOfRoot = (path: string): boolean => {
    const realRoot = realPathOrUndefined(root);
    const realParent = realPathOrUndefined(dirname(path));
    const isDirectChildOfRoot = realRoot !== undefined && realParent === realRoot;
    const isNamedLikeAWorkspace = basename(path).startsWith(WORKSPACE_PREFIX);
    return isDirectChildOfRoot && isNamedLikeAWorkspace;
  };

  const remove = (path: string): void => {
    if (!isWorkspaceOfRoot(path)) return;
    rmSync(path, { recursive: true, force: true });
  };

  return {
    create() {
      mkdirSync(root, { recursive: true, mode: OWNER_ONLY });
      const workspace = mkdtempSync(join(root, WORKSPACE_PREFIX));
      chmodSync(workspace, OWNER_ONLY);
      return realpathSync.native(workspace);
    },
    remove,
    removeAllExcept(keep) {
      const realRoot = realPathOrUndefined(root);
      if (realRoot === undefined) return;
      for (const entry of readdirSync(realRoot)) {
        const path = join(realRoot, entry);
        if (!keep.has(path)) remove(path);
      }
    },
  };
}
