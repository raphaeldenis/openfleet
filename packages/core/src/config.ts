import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { newToken } from './ids.js';

export interface Config { host: '127.0.0.1'; port: number; home: string; dbPath: string; worktreesRoot: string; adminToken: string }

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const home = env.OPENFLEET_HOME ?? join(homedir(), '.openfleet');
  mkdirSync(home, { recursive: true });
  // mkdirSync's mode option is ignored on a directory that already exists, so a home that predates this
  // check (or was loosened by something else) is tightened here every load, not just at creation (MAJ-02).
  chmodSync(home, 0o700);
  const worktreesRoot = join(home, 'worktrees');
  mkdirSync(worktreesRoot, { recursive: true });
  return {
    host: '127.0.0.1',
    port: Number(env.OPENFLEET_PORT ?? 7331),
    home,
    dbPath: join(home, 'openfleet.db'),
    worktreesRoot,
    adminToken: readOrCreateAdminToken(join(home, 'admin.token')),
  };
}

// A token shorter than this is a truncated write (an interrupted disk, a stray echo > admin.token), not a
// usable secret: the daemon must refuse to boot on it rather than quietly running with a weak or empty one.
const MIN_ADMIN_TOKEN_LENGTH = 32;

function readOrCreateAdminToken(path: string): string {
  if (existsSync(path)) {
    const token = readFileSync(path, 'utf8').trim();
    if (token.length < MIN_ADMIN_TOKEN_LENGTH) {
      throw new Error(`admin token at ${path} is ${token.length} characters, need at least ${MIN_ADMIN_TOKEN_LENGTH}; delete it to have OpenFleet generate a fresh one`);
    }
    chmodSync(path, 0o600);
    return token;
  }
  const token = newToken();
  writeFileSync(path, token, { mode: 0o600 });
  return token;
}
