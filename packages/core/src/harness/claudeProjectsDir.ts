import { homedir } from 'node:os';
import { join } from 'node:path';

// The daemon's own env is what the harness passes through to the CLI child (childEnvironment.ts keeps
// CLAUDE_CONFIG_DIR — it's user configuration, not a session marker), so it is also the daemon's own
// source of truth for where that CLI writes transcripts.
export function claudeProjectsDir(): string {
  const configDir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
  return join(configDir, 'projects');
}
