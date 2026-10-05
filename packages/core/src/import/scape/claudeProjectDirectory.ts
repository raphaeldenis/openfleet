import { join } from 'node:path';

const NON_ALPHANUMERIC_CHARACTER = /[^A-Za-z0-9]/g;

/** The Claude CLI hashes a project folder name longer than this, so the importer cannot compute it. */
export const MAX_CLAUDE_PROJECT_FOLDER_NAME_LENGTH = 200;

/** The name of the folder under `<claude dir>/projects` that the Claude CLI keeps for sessions started in a working directory. */
export const claudeProjectFolderNameOf = (workingDirectory: string): string => workingDirectory.replace(NON_ALPHANUMERIC_CHARACTER, '-');

/** The folder of the Claude auto-memory of a working directory. */
export const claudeMemoryFolderOf = (input: { claudeDir: string; workingDirectory: string }): string =>
  join(input.claudeDir, 'projects', claudeProjectFolderNameOf(input.workingDirectory), 'memory');
