import { isAbsolute, relative } from 'node:path';

// Lexical on purpose: the directories are already resolved, and a project session directory may no longer exist on disk.
const isInsideOrEqual = (candidate: string, root: string): boolean => {
  const fromRoot = relative(root, candidate);
  return fromRoot === '' || (!fromRoot.startsWith('..') && !isAbsolute(fromRoot));
};

// Each check runs git: a project with many session directories is not walked in full.
export const MAX_REPOSITORY_CHECKS = 10;

export interface ProjectMembershipQuery {
  realDirectory: string;
  /** The directories of the sessions that belong to the project. */
  projectDirectories: string[];
  docsFolderPath: string | null;
  sameGitRepository: (knownDirectory: string, candidate: string) => Promise<boolean>;
}

/**
 * A directory belongs to a project when it is, contains or lies inside one of the project's session directories or its docs
 * folder, or when it is a worktree of the git repository of one of its session directories.
 */
export async function isDirectoryInProject({ realDirectory, projectDirectories, docsFolderPath, sameGitRepository }: ProjectMembershipQuery): Promise<boolean> {
  const knownDirectories = [...new Set(projectDirectories)];
  const folders = docsFolderPath === null ? knownDirectories : [...knownDirectories, docsFolderPath];
  const isRelatedByPath = folders.some((folder) => isInsideOrEqual(realDirectory, folder) || isInsideOrEqual(folder, realDirectory));
  if (isRelatedByPath) return true;
  for (const known of knownDirectories.slice(0, MAX_REPOSITORY_CHECKS)) {
    if (await sameGitRepository(known, realDirectory)) return true;
  }
  return false;
}
