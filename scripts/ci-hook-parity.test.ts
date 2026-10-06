import { spawnSync } from 'node:child_process';
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

const tauriManifestPath = 'apps/desktop/src-tauri/Cargo.toml';
const tauriRustVersion = readRepoFile(tauriManifestPath).match(/^rust-version = "([^"]+)"/m)?.[1];

const ciCargoCommands = (): string[] => {
  const workflowLines = readRepoFile('.github/workflows/ci.yml').split('\n');
  const cargoCommands = workflowLines.flatMap((line) => {
    const command = line.match(/^\s*(?:- )?run: (?:sh scripts\/cargo-clippy.sh )?(cargo .+)$/)?.[1];
    return command ? [command.trim()] : [];
  });
  return cargoCommands;
};

const hookCargoCommands = (): string[] => {
  const hookLines = readRepoFile('scripts/pre-push.sh').split('\n');
  const cargoCommands = hookLines.flatMap((line) => {
    const command = line.match(/run_(?:advisory_)?step "cargo [^"]+" (?:sh scripts\/cargo-clippy.sh )?(cargo .+)$/)?.[1];
    return command ? [command] : [];
  });
  return cargoCommands.map((command) => {
    const commandWithToolchain = command.replace('+"$TAURI_RUST_VERSION"', `+${tauriRustVersion}`);
    return commandWithToolchain.replace('"$TAURI_MANIFEST"', tauriManifestPath);
  });
};

describe('CI and pre-push hook parity', () => {
  it('tests the Tauri library with the declared Rust version and lints all targets on stable', () => {
    expect(tauriRustVersion).toBeDefined();
    expect(ciCargoCommands()).toEqual([
      `cargo +${tauriRustVersion} test --locked --manifest-path ${tauriManifestPath} --lib`,
      `cargo +stable clippy --locked --manifest-path ${tauriManifestPath} --all-targets`,
    ]);
  });

  it('keeps Rust tests blocking and Clippy advisory in both CI and the hook', () => {
    const workflowSteps = readRepoFile('.github/workflows/ci.yml').split(/^ {6}- /m);
    const testStep = workflowSteps.find((step) => step.startsWith('name: Test Tauri library with the declared minimum Rust version\n'));
    const clippyStep = workflowSteps.find((step) => step.startsWith('name: Lint all Tauri targets with stable Clippy\n'));
    const hookSource = readRepoFile('scripts/pre-push.sh');

    expect(testStep).toBeDefined();
    expect(testStep).not.toContain('continue-on-error:');
    expect(testStep).not.toMatch(/\|\||\bexit 0\b/);
    expect(clippyStep).toContain('continue-on-error: true');
    expect(clippyStep).toContain('run: sh scripts/cargo-clippy.sh cargo +stable clippy');
    expect(hookSource).toContain('run_step "cargo test" cargo +"$TAURI_RUST_VERSION"');
    expect(hookSource).toContain('run_advisory_step "cargo clippy" sh scripts/cargo-clippy.sh cargo +stable clippy');
  });

  it('reports Clippy warnings without counting target summaries as diagnostics', () => {
    const fakeClippy = "printf '%s\\n' 'warning: first lint' 'warning: second lint' 'warning: `app` (lib) generated 2 warnings'; exit 1";

    const result = spawnSync('sh', ['scripts/cargo-clippy.sh', 'sh', '-c', fakeClippy], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      env: { ...process.env, GITHUB_STEP_SUMMARY: '' },
    });

    expect(result.status).toBe(1);
    expect(result.stdout).toContain('Clippy advisory: 2 warning diagnostics; exit code 1');
  });

  it('continues after a failing advisory hook step', () => {
    const hookSource = readRepoFile('scripts/pre-push.sh');
    const advisoryFunction = hookSource.match(/^run_advisory_step\(\) \{[\s\S]*?^\}/m)?.[0];
    expect(advisoryFunction).toBeDefined();

    const result = spawnSync('sh', ['-c', `${advisoryFunction}\nrun_advisory_step "cargo clippy" false`], {
      encoding: 'utf8',
      env: { ...process.env, OPENFLEET_PREPUSH_DRYRUN: '0' },
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('advisory; push continues');
  });

  it('runs every CI cargo command in the hook with the same toolchains and arguments', () => {
    const hookCommands = hookCargoCommands();
    const missingCommands = ciCargoCommands().filter((command) => !hookCommands.includes(command));

    expect(missingCommands).toEqual([]);
    expect(readRepoFile('scripts/pre-push.sh')).toContain(`TAURI_RUST_VERSION=$(awk -F '"' '/^rust-version = / { print $2 }' "$TAURI_MANIFEST")`);
  });

  it('uses the same bundle-free Tauri configuration in CI and the hook', () => {
    const bundleFreeConfiguration = JSON.stringify({ bundle: { externalBin: [], resources: [] } });

    expect(readRepoFile('.github/workflows/ci.yml')).toContain(`TAURI_CONFIG: '${bundleFreeConfiguration}'`);
    expect(readRepoFile('scripts/pre-push.sh')).toContain(`export TAURI_CONFIG='${bundleFreeConfiguration}'`);
  });

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
