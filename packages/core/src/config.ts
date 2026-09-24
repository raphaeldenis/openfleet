import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { newToken } from './ids.js';

export interface Config { host: '127.0.0.1'; port: number; home: string; dbPath: string; worktreesRoot: string; adminToken: string }

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const home = env.OPENFLEET_HOME ?? join(homedir(), '.openfleet');
  mkdirSync(home, { recursive: true });
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

function readOrCreateAdminToken(path: string): string {
  if (existsSync(path)) return readFileSync(path, 'utf8').trim();
  const token = newToken();
  writeFileSync(path, token, { mode: 0o600 });
  return token;
}
