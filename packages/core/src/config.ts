import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { E2E_FLAG_ENV, E2E_FLAG_ON } from '@openfleet/shared';
import { newToken } from './ids.js';

export interface Config { host: '127.0.0.1'; port: number; home: string; dbPath: string; worktreesRoot: string; sessionsRoot: string; stateRoot: string; adminToken: string; e2eEnabled: boolean }

export const resolveHome = (env: NodeJS.ProcessEnv = process.env): string => env.OPENFLEET_HOME ?? join(homedir(), '.openfleet');

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const home = resolveHome(env);
  mkdirSync(home, { recursive: true });
  // mkdirSync's mode option is ignored on a directory that already exists, so a home that predates this
  // check (or was loosened by something else) is tightened here every load, not just at creation (MAJ-02).
  chmodSync(home, 0o700);
  const worktreesRoot = join(home, 'worktrees');
  mkdirSync(worktreesRoot, { recursive: true });
  // Same rationale as home above: mkdirSync's mode is ignored on an existing directory, so tighten on every load.
  chmodSync(worktreesRoot, 0o700);
  const sessionsRoot = join(home, 'sessions');
  mkdirSync(sessionsRoot, { recursive: true });
  // Same rationale as home above: mkdirSync's mode is ignored on an existing directory, so tighten on every load (AUD-11).
  chmodSync(sessionsRoot, 0o700);
  return {
    stateRoot: join(home, 'state'),
    host: '127.0.0.1',
    port: Number(env.OPENFLEET_PORT ?? 7331),
    home,
    dbPath: join(home, 'openfleet.db'),
    worktreesRoot,
    sessionsRoot,
    e2eEnabled: env[E2E_FLAG_ENV] === E2E_FLAG_ON,
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
