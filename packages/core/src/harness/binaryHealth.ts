import { execFile } from 'node:child_process';
import { OpenFleetError } from '@openfleet/shared';

export const BINARY_HEALTH_CACHE_MS = 60_000;
export const VERSION_PROBE_TIMEOUT_MS = 10_000;
export const MAX_STDERR_CHARS = 300;

export interface VersionProbeResult { exitCode: number; stdout: string; stderr: string }
export type BinaryHealth = { ok: true; path: string; version: string } | { ok: false; path: string; stderr: string };

export interface BinaryHealthDeps {
  run?: (path: string) => Promise<VersionProbeResult>;
  now?: () => number;
}

/** Runs `<path> --version` and returns what it printed; a binary that cannot even start reports its error as stderr. */
export const runVersionProbe = (path: string): Promise<VersionProbeResult> =>
  new Promise((resolve) => {
    execFile(path, ['--version'], { timeout: VERSION_PROBE_TIMEOUT_MS, encoding: 'utf8' }, (error, stdout, stderr) => {
      const exitCode = error === null ? 0 : typeof error.code === 'number' ? error.code : 1;
      const startFailure = error !== null && typeof error.code !== 'number' ? error.message : '';
      resolve({ exitCode, stdout, stderr: stderr || startFailure });
    });
  });

const truncated = (text: string): string => {
  const trimmed = text.trim();
  return trimmed.length > MAX_STDERR_CHARS ? `${trimmed.slice(0, MAX_STDERR_CHARS)}…` : trimmed;
};

export const brokenBinaryError = ({ path, stderr }: { path: string; stderr: string }): OpenFleetError =>
  new OpenFleetError(
    'harness_binary_broken',
    `the agent binary ${path} fails its --version check: ${stderr || 'no error output'}`,
    { hint: 'Reinstall the binary or fix the PATH the daemon runs with, then spawn again.' },
  );

/** Checks that a harness binary answers `--version`; the answer, failure included, is cached per path for BINARY_HEALTH_CACHE_MS. */
export class BinaryHealthCheck {
  private readonly cache = new Map<string, { health: BinaryHealth; checkedAt: number }>();
  private readonly run: (path: string) => Promise<VersionProbeResult>;
  private readonly now: () => number;

  constructor(deps: BinaryHealthDeps = {}) {
    this.run = deps.run ?? runVersionProbe;
    this.now = deps.now ?? Date.now;
  }

  /** The answer still inside its cache window, without probing; undefined when the binary must be probed again. */
  cached(path: string): BinaryHealth | undefined {
    const entry = this.cache.get(path);
    const isCacheFresh = entry !== undefined && this.now() - entry.checkedAt < BINARY_HEALTH_CACHE_MS;
    return isCacheFresh ? entry.health : undefined;
  }

  async check(path: string): Promise<BinaryHealth> {
    const cached = this.cached(path);
    if (cached) return cached;
    const health = await this.probe(path);
    this.cache.set(path, { health, checkedAt: this.now() });
    return health;
  }

  async assertHealthy(path: string): Promise<{ ok: true; path: string; version: string }> {
    const health = await this.check(path);
    if (health.ok) return health;
    throw brokenBinaryError(health);
  }

  private async probe(path: string): Promise<BinaryHealth> {
    try {
      const result = await this.run(path);
      if (result.exitCode === 0) return { ok: true, path, version: result.stdout.trim() };
      return { ok: false, path, stderr: truncated(result.stderr) };
    } catch (error) {
      return { ok: false, path, stderr: truncated(error instanceof Error ? error.message : String(error)) };
    }
  }
}
