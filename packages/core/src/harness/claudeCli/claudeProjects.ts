import { closeSync, existsSync, fstatSync, openSync, readdirSync, readSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { log } from '../../logger.js';
import type { ConversationPresence } from '../harness.js';

const CONVERSATION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ERRNO_MEANING_NOT_THERE = new Set(['ENOENT', 'ENOTDIR']);
const READ_CHUNK_BYTES = 64 * 1024;
// A transcript this long with no user or assistant line yet is not a title-only stub: it counts as a conversation.
const MAX_BYTES_SCANNED = 4 * 1024 * 1024;
const CONVERSATION_LINE_TYPES = new Set(['user', 'assistant']);

// The daemon's own env is what the harness passes through to the CLI child (childEnvironment.ts keeps
// CLAUDE_CONFIG_DIR — it's user configuration, not a session marker), so it is also the daemon's own
// source of truth for where that CLI writes transcripts.
export function claudeProjectsDir(): string {
  const configDir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
  return join(configDir, 'projects');
}

// The CLI names a project's directory after its cwd with every non-alphanumeric character turned into '-'.
// ponytail: that naming is a CLI internal; when a transcript is not under the name derived here,
// conversationPresence scans every project directory. Upgrade path: none needed while the scan stays a fallback.
function projectDirectoryNameOf(directory: string): string {
  const resolvedDirectory = existsSync(directory) ? realpathSync(directory) : directory;
  return resolvedDirectory.replace(/[^a-zA-Z0-9]/g, '-');
}

function errnoCodeOf(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException).code;
}

function isConversationLine(line: string): boolean {
  try {
    const parsed: unknown = JSON.parse(line);
    const type = typeof parsed === 'object' && parsed !== null ? (parsed as { type?: unknown }).type : undefined;
    return typeof type === 'string' && CONVERSATION_LINE_TYPES.has(type);
  } catch {
    return false;
  }
}

// The CLI writes a title-only line as soon as a conversation opens and the rest of its lines a moment later;
// it refuses to resume the stub. A conversation exists once one user or assistant line is on disk.
function containsConversationLine(fileDescriptor: number): boolean {
  const chunk = Buffer.alloc(READ_CHUNK_BYTES);
  let unfinishedLine = '';
  let bytesScanned = 0;
  while (bytesScanned < MAX_BYTES_SCANNED) {
    const bytesRead = readSync(fileDescriptor, chunk, 0, READ_CHUNK_BYTES, null);
    if (bytesRead === 0) return isConversationLine(unfinishedLine);
    bytesScanned += bytesRead;
    const lines = (unfinishedLine + chunk.toString('utf8', 0, bytesRead)).split('\n');
    unfinishedLine = lines.pop() ?? '';
    if (lines.some(isConversationLine)) return true;
  }
  return true;
}

function transcriptPresence(path: string, cliSessionId: string): ConversationPresence {
  let fileDescriptor: number | undefined;
  try {
    fileDescriptor = openSync(path, 'r');
    if (!fstatSync(fileDescriptor).isFile()) return 'missing';
    return containsConversationLine(fileDescriptor) ? 'present' : 'missing';
  } catch (error) {
    const errorCode = errnoCodeOf(error);
    if (ERRNO_MEANING_NOT_THERE.has(errorCode ?? '')) return 'missing';
    log('warn', `conversation ${cliSessionId}: transcript could not be inspected (${errorCode ?? 'no error code'})`);
    return 'unknown';
  } finally {
    if (fileDescriptor !== undefined) closeSync(fileDescriptor);
  }
}

function projectDirectoryNamesIn(projectsDir: string): string[] | 'unreadable' {
  try {
    return readdirSync(projectsDir);
  } catch (error) {
    return ERRNO_MEANING_NOT_THERE.has(errnoCodeOf(error) ?? '') ? [] : 'unreadable';
  }
}

// Whether `<projects>/<project>/<cliSessionId>.jsonl` holds a conversation. The project of the session's own
// directory is tried first; the scan of every project runs only when that exact path holds none. Only a file
// that is not there means 'missing': any other read error is 'unknown', never a reason to drop the conversation.
export function conversationPresence(conversation: { cliSessionId: string; directory: string }): ConversationPresence {
  if (!CONVERSATION_ID_PATTERN.test(conversation.cliSessionId)) return 'missing';
  const transcriptName = `${conversation.cliSessionId.toLowerCase()}.jsonl`;
  const projectsDir = claudeProjectsDir();
  const presenceIn = (projectName: string) => transcriptPresence(join(projectsDir, projectName, transcriptName), conversation.cliSessionId);
  const ownProjectPresence = presenceIn(projectDirectoryNameOf(conversation.directory));
  if (ownProjectPresence === 'present') return 'present';
  const projectNames = projectDirectoryNamesIn(projectsDir);
  if (projectNames === 'unreadable') return 'unknown';
  const presences = [ownProjectPresence, ...projectNames.map(presenceIn)];
  if (presences.includes('present')) return 'present';
  return presences.includes('unknown') ? 'unknown' : 'missing';
}
