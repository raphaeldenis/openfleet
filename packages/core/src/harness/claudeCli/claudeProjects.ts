import { existsSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const CONVERSATION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// The daemon's own env is what the harness passes through to the CLI child (childEnvironment.ts keeps
// CLAUDE_CONFIG_DIR — it's user configuration, not a session marker), so it is also the daemon's own
// source of truth for where that CLI writes transcripts.
export function claudeProjectsDir(): string {
  const configDir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
  return join(configDir, 'projects');
}

// The CLI names a project's directory after its cwd with every non-alphanumeric character turned into '-'.
// ponytail: that naming is a CLI internal; when a transcript is not under the name derived here,
// hasConversationTranscript scans every project directory. Upgrade path: none needed while the scan stays a fallback.
function projectDirectoryNameOf(directory: string): string {
  const resolvedDirectory = existsSync(directory) ? realpathSync(directory) : directory;
  return resolvedDirectory.replace(/[^a-zA-Z0-9]/g, '-');
}

function isReadableFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function listProjectDirectoryNames(projectsDir: string): string[] {
  try {
    return readdirSync(projectsDir);
  } catch {
    return [];
  }
}

// True when `<projects>/<project>/<cliSessionId>.jsonl` is a file. The project of the session's own directory
// is tried first; the scan of every project runs only when that exact path holds nothing.
export function hasConversationTranscript(conversation: { cliSessionId: string; directory: string }): boolean {
  if (!CONVERSATION_ID_PATTERN.test(conversation.cliSessionId)) return false;
  const transcriptName = `${conversation.cliSessionId.toLowerCase()}.jsonl`;
  const projectsDir = claudeProjectsDir();
  if (isReadableFile(join(projectsDir, projectDirectoryNameOf(conversation.directory), transcriptName))) return true;
  return listProjectDirectoryNames(projectsDir).some((projectName) => isReadableFile(join(projectsDir, projectName, transcriptName)));
}
