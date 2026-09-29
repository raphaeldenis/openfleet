import { randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface TokenFilePaths { settingsPath: string; mcpConfigPath: string }

// A fresh, randomized directory per launch — not just per session — means a file a daemon restart lost
// track of (an orphaned pty from a crash mid-session, still able to touch disk until it actually exits)
// never collides with the file this launch is about to write, even though both share the session id.
export function tokenFilesDirFor(sessionsRoot: string, sessionId: string): string {
  return join(sessionsRoot, sessionId, randomUUID());
}

export function pathsIn(dir: string): TokenFilePaths {
  return { settingsPath: join(dir, 'settings.json'), mcpConfigPath: join(dir, 'mcp-config.json') };
}

// 'wx' (O_CREAT|O_EXCL) refuses to write over an existing file, on top of the random directory above —
// belt-and-braces against the CLI ever reading a stale or attacker-planted file at these paths.
export function writeTokenFiles(dir: string, settings: unknown, mcpConfig: unknown): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  // mkdirSync's mode is ignored on a directory that already exists (same reasoning as config.ts's home dir).
  chmodSync(dir, 0o700);
  const { settingsPath, mcpConfigPath } = pathsIn(dir);
  writeFileSync(settingsPath, JSON.stringify(settings), { flag: 'wx', mode: 0o600 });
  writeFileSync(mcpConfigPath, JSON.stringify(mcpConfig), { flag: 'wx', mode: 0o600 });
}

export function deleteTokenFiles(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}
