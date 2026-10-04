import { lstatSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { ScapeImportError } from './scapeImportError.js';

const refused = (message: string) => new ScapeImportError({ code: 'INVALID_ARGUMENTS', message });

export interface StateFolderInput {
  stateDir: string;
  /** The folder the state folder must be inside, with no link on the way down from it; defaults to the parent of the state folder, so that only the folder itself is checked. */
  stateRoot: string | undefined;
}

/**
 * Returns the real path of the state folder, or undefined when there is no such folder. The folder must be inside its allowed root and
 * no component of the path below the root may be a link: a state folder reached through a link could read files from anywhere.
 */
export function resolveStateFolder(input: StateFolderInput): string | undefined {
  const stateDir = resolve(input.stateDir);
  const stateRoot = resolve(input.stateRoot ?? dirname(stateDir));
  const pathBelowRoot = relative(stateRoot, stateDir);
  const isOutsideRoot = pathBelowRoot === '' || pathBelowRoot.startsWith('..') || isAbsolute(pathBelowRoot);
  if (isOutsideRoot) throw refused(`the state folder ${stateDir} is not inside its allowed root ${stateRoot}`);

  let current: string;
  try {
    current = realpathSync(stateRoot);
  } catch {
    return undefined;
  }
  for (const component of pathBelowRoot.split(sep)) {
    current = join(current, component);
    let stats;
    try {
      stats = lstatSync(current);
    } catch {
      return undefined;
    }
    if (stats.isSymbolicLink()) throw refused(`the state folder ${stateDir} is reached through a link (${component}): give the real folder`);
  }
  return lstatSync(current).isDirectory() ? current : undefined;
}
