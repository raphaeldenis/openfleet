import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const readRepoFile = (path: string) => readFileSync(join(REPO_ROOT, path), 'utf8');

interface CiCommand {
  job: string;
  command: string;
}

/** CI pnpm commands the hook deliberately does not run, each with the reason. */
const EXCEPTIONS: Record<string, string> = {
  'pnpm install --frozen-lockfile': 'the hook runs in an already installed checkout (husky installs on pnpm install)',
  'pnpm --filter @openfleet/desktop exec playwright install --with-deps chromium': 'downloads browsers and system packages (network, sudo); a developer machine installs them once',
};

const ciPnpmCommands = (): CiCommand[] => {
  const commands: CiCommand[] = [];
  let currentJob = '';
  for (const line of readRepoFile('.github/workflows/ci.yml').split('\n')) {
    const jobName = line.match(/^ {2}([\w-]+):\s*$/)?.[1];
    if (jobName) currentJob = jobName;
    const pnpmCommand = line.match(/^\s*- run: (pnpm .+?)\s*$/)?.[1];
    if (pnpmCommand) commands.push({ job: currentJob, command: pnpmCommand });
  }
  return commands;
};

const hookPnpmCommands = (): Set<string> => {
  const hookSources = [readRepoFile('scripts/pre-push.sh'), readRepoFile('scripts/pre-push-lib.sh')].join('\n');
  const stepLines = hookSources.split('\n').filter((line) => /\brun_step\b|\brun_without_claude\b/.test(line));
  const commands = stepLines.flatMap((line) => line.match(/pnpm [^&|;"]*/g) ?? []);
  return new Set(commands.map((command) => command.trim()));
};

const describeMissing = (missing: CiCommand[]) =>
  missing.map(({ job, command }) => `CI job "${job}" runs \`${command}\` but scripts/pre-push.sh does not: add it as a run_step or list it in EXCEPTIONS with a reason`).join('\n');

describe('CI and pre-push hook parity', () => {
  it('finds the pnpm commands of every CI job', () => {
    const commands = ciPnpmCommands().map(({ command }) => command);

    expect(commands).toContain('pnpm arch');
    expect(commands).toContain('pnpm e2e');
  });

  it('runs in the hook every CI pnpm command that is not a documented exception', () => {
    const hookCommands = hookPnpmCommands();

    const missing = ciPnpmCommands().filter(({ command }) => !hookCommands.has(command) && !(command in EXCEPTIONS));

    expect(describeMissing(missing)).toBe('');
  });

  it('lists only exceptions that CI still runs', () => {
    const ciCommands = new Set(ciPnpmCommands().map(({ command }) => command));

    const staleExceptions = Object.keys(EXCEPTIONS).filter((command) => !ciCommands.has(command));

    expect(staleExceptions).toEqual([]);
  });
});
