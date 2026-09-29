import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface TokenFilePaths { settingsPath: string; mcpConfigPath: string; hookCurlConfigPath: string }

// A fresh, randomized directory per launch — not just per session — means a file a daemon restart lost
// track of (an orphaned pty from a crash mid-session, still able to touch disk until it actually exits)
// never collides with the file this launch is about to write, even though both share the session id.
export function tokenFilesDirFor(sessionsRoot: string, sessionId: string): string {
  return join(sessionsRoot, sessionId, randomUUID());
}

export function pathsIn(dir: string): TokenFilePaths {
  return {
    settingsPath: join(dir, 'settings.json'),
    mcpConfigPath: join(dir, 'mcp-config.json'),
    hookCurlConfigPath: join(dir, 'hook-curl.conf'),
  };
}

// 'wx' (O_CREAT|O_EXCL) refuses to write over an existing file, on top of the random directory above —
// belt-and-braces against the CLI ever reading a stale or attacker-planted file at these paths.
export function writeTokenFiles(dir: string, settings: unknown, mcpConfig: unknown, hookCurlConfig: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  // mkdirSync's mode is ignored on a directory that already exists (same reasoning as config.ts's home dir).
  chmodSync(dir, 0o700);
  const { settingsPath, mcpConfigPath, hookCurlConfigPath } = pathsIn(dir);
  try {
    writeFileSync(settingsPath, JSON.stringify(settings), { flag: 'wx', mode: 0o600 });
    writeFileSync(mcpConfigPath, JSON.stringify(mcpConfig), { flag: 'wx', mode: 0o600 });
    writeFileSync(hookCurlConfigPath, hookCurlConfig, { flag: 'wx', mode: 0o600 });
  } catch (err) {
    // A file already written by this same call must not survive as an orphan carrying a live token.
    rmSync(dir, { recursive: true, force: true });
    throw err;
  }
}

export function deleteTokenFiles(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

// Every launch dir a resume would touch gets rewritten with fresh, rotated tokens anyway, so nothing
// here is worth preserving across a restart — a crash-orphaned launch dir just sits there as a stale
// live token otherwise, unbounded, until someone thinks to look.
export function sweepStaleSessions(sessionsRoot: string): void {
  if (!existsSync(sessionsRoot)) return;
  for (const sessionId of readdirSync(sessionsRoot)) {
    rmSync(join(sessionsRoot, sessionId), { recursive: true, force: true });
  }
}
