import { lstatSync, mkdirSync, realpathSync, rmdirSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { ScapeImportError } from './scapeImportError.js';

const PRIVATE_FOLDER_MODE = 0o700;

export interface PreparedManagerFolders {
  /** Removes the folders this preparation created, innermost first, and only while they are empty. */
  rollback(): void;
}

export interface ManagerFoldersRequest {
  managersRoot: string;
  /** Each a direct child of the managers root. */
  directories: string[];
  /** The Scape source tree: nothing may be created inside it, whatever links lead there. */
  forbiddenRoot: string;
}

const refuse = (message: string, cause?: unknown) => new ScapeImportError({ code: 'IMPORT_WRITE_FAILED', message, cause });

const isInside = (path: string, root: string) => path === root || path.startsWith(`${root}${sep}`);

const NOTHING_TO_ROLL_BACK: PreparedManagerFolders = { rollback: () => {} };

/** The folders of the path that do not exist yet, outermost first. */
function missingFoldersOf(path: string): string[] {
  const missing: string[] = [];
  for (let current = path; lstatSync(current, { throwIfNoEntry: false }) === undefined; current = dirname(current)) missing.unshift(current);
  return missing;
}

function realPathOfManagersRoot(managersRoot: string, missingFolders: string[]): string {
  const deepestExistingFolder = missingFolders.length === 0 ? managersRoot : dirname(missingFolders[0]!);
  if (!statSync(deepestExistingFolder).isDirectory()) throw refuse(`${deepestExistingFolder} is not a folder`);
  return join(realpathSync(deepestExistingFolder), ...missingFolders.map((folder) => basename(folder)));
}

/** A manager folder that exists must be a real folder: a link would send the manager's working directory elsewhere. Returns whether it has to be created. */
function needsCreation(directory: string, managersRoot: string): boolean {
  const isDirectChild = dirname(directory) === managersRoot;
  if (!isDirectChild) throw refuse(`${directory} is not a direct child of the managers folder`);
  const stored = lstatSync(directory, { throwIfNoEntry: false });
  if (stored === undefined) return true;
  if (stored.isSymbolicLink()) throw refuse(`${directory} is a link: remove it or move the managers folder`);
  if (!stored.isDirectory()) throw refuse(`${directory} exists and is not a folder`);
  return false;
}

/**
 * Creates the managers folder and the manager folders that do not exist, after checking that all of them really live
 * outside the Scape source. Whatever fails undoes what this call created, so a failed import leaves no folder behind.
 */
export function prepareManagerFolders(request: ManagerFoldersRequest): PreparedManagerFolders {
  if (request.directories.length === 0) return NOTHING_TO_ROLL_BACK;

  const managersRoot = resolve(request.managersRoot);
  const missingRootFolders = missingFoldersOf(managersRoot);
  const created: string[] = [];
  const rollback = () => [...created].reverse().forEach((folder) => { try { rmdirSync(folder); } catch { /* not empty or already gone: left as it is */ } });
  try {
    const realRoot = realPathOfManagersRoot(managersRoot, missingRootFolders);
    if (isInside(realRoot, realpathSync(request.forbiddenRoot))) throw refuse(`the managers folder ${request.managersRoot} resolves inside the Scape source`);
    const directoriesToCreate = request.directories.map((directory) => resolve(directory)).filter((directory) => needsCreation(directory, managersRoot));

    for (const folder of [...missingRootFolders, ...directoriesToCreate]) {
      mkdirSync(folder, { mode: PRIVATE_FOLDER_MODE });
      created.push(folder);
    }
    const escapedFolder = directoriesToCreate.find((directory) => !isInside(realpathSync(directory), realRoot));
    if (escapedFolder !== undefined) throw refuse(`${escapedFolder} resolves outside the managers folder`);
  } catch (cause) {
    rollback();
    throw cause instanceof ScapeImportError ? cause : refuse(`the manager folders cannot be created: ${(cause as Error).message}`, cause);
  }
  return { rollback };
}
