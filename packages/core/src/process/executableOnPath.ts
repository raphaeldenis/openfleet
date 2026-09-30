import { accessSync, constants, statSync } from 'node:fs';
import { delimiter, join } from 'node:path';

export function pathDirectoriesOf(env: NodeJS.ProcessEnv): string[] {
  return (env.PATH ?? '').split(delimiter).filter((directory) => directory !== '');
}

/** The first executable file named `command` in `directories`, as a shell resolves a bare command name. */
export function findExecutable(command: string, directories: string[]): string | undefined {
  return directories.map((directory) => join(directory, command)).find(isExecutableFile);
}

function isExecutableFile(candidate: string): boolean {
  try {
    accessSync(candidate, constants.X_OK);
    return statSync(candidate).isFile();
  } catch {
    return false;
  }
}
