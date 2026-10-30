import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';

const E2E_SEEDED_ENV = 'OPENFLEET_E2E_SEEDED';
const repoRoot = resolve(__dirname, '../..');
const seedWriterPath = join(__dirname, 'writeE2eSeed.ts');

/**
 * Seeds the e2e home once per run, before the daemon boots: the env var carries "already seeded" to the later config evaluations
 * (Playwright evaluates the config again in every worker, while the daemon already holds the database).
 * The writer runs under tsx in its own process because the Playwright config is CommonJS and core is ESM.
 */
export function ensureE2eSeed(home: string): void {
  if (process.env[E2E_SEEDED_ENV]) return;
  execFileSync('pnpm', ['--filter', '@openfleet/core', 'exec', 'tsx', seedWriterPath, home], { cwd: repoRoot, stdio: 'inherit' });
  process.env[E2E_SEEDED_ENV] = '1';
}
