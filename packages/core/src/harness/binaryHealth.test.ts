import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OpenFleetError } from '@openfleet/shared';
import { describe, expect, it, vi } from 'vitest';
import { BINARY_HEALTH_CACHE_MS, BinaryHealthCheck, MAX_STDERR_CHARS, runVersionProbe, type VersionProbeResult } from './binaryHealth.js';

const HEALTHY = { exitCode: 0, stdout: '2.1.0 (Claude Code)\n', stderr: '' };
const BROKEN = { exitCode: 1, stdout: '', stderr: 'dyld: Library not loaded' };

const aCheck = (probe: (path: string) => Promise<VersionProbeResult>) => {
  const clock = { now: 1_000 };
  const check = new BinaryHealthCheck({ run: probe, now: () => clock.now });
  return { check, clock };
};

describe('BinaryHealthCheck', () => {
  it('reports the version of a binary that answers --version with exit 0', async () => {
    const { check } = aCheck(vi.fn().mockResolvedValue(HEALTHY));

    const health = await check.check('/bin/claude');

    expect(health).toEqual({ ok: true, path: '/bin/claude', version: '2.1.0 (Claude Code)' });
  });

  it('reports a binary that exits non-zero as broken, with its stderr', async () => {
    const { check } = aCheck(vi.fn().mockResolvedValue(BROKEN));

    const health = await check.check('/bin/claude');

    expect(health).toEqual({ ok: false, path: '/bin/claude', stderr: 'dyld: Library not loaded' });
  });

  it('truncates a long stderr', async () => {
    const { check } = aCheck(vi.fn().mockResolvedValue({ ...BROKEN, stderr: 'x'.repeat(MAX_STDERR_CHARS * 3) }));

    const health = await check.check('/bin/claude');

    expect(health.ok === false && health.stderr.length).toBeLessThanOrEqual(MAX_STDERR_CHARS + 1);
  });

  it('runs the probe once for two checks inside the cache window', async () => {
    const probe = vi.fn().mockResolvedValue(HEALTHY);
    const { check, clock } = aCheck(probe);

    await check.check('/bin/claude');
    clock.now += BINARY_HEALTH_CACHE_MS - 1;
    await check.check('/bin/claude');

    expect(probe).toHaveBeenCalledTimes(1);
  });

  it('runs the probe again once the cache window is over', async () => {
    const probe = vi.fn().mockResolvedValue(HEALTHY);
    const { check, clock } = aCheck(probe);

    await check.check('/bin/claude');
    clock.now += BINARY_HEALTH_CACHE_MS;
    await check.check('/bin/claude');

    expect(probe).toHaveBeenCalledTimes(2);
  });

  it('caches a failure as well, so a broken binary is not probed on every spawn', async () => {
    const probe = vi.fn().mockResolvedValue(BROKEN);
    const { check } = aCheck(probe);

    await check.check('/bin/claude');
    await check.check('/bin/claude');

    expect(probe).toHaveBeenCalledTimes(1);
  });

  it('keeps one cache entry per binary path', async () => {
    const probe = vi.fn().mockResolvedValue(HEALTHY);
    const { check } = aCheck(probe);

    await check.check('/bin/claude');
    await check.check('/other/claude');

    expect(probe).toHaveBeenCalledTimes(2);
  });

  it('treats a probe that throws as a broken binary carrying the error message', async () => {
    const { check } = aCheck(vi.fn().mockRejectedValue(new Error('spawn EACCES')));

    const health = await check.check('/bin/claude');

    expect(health).toEqual({ ok: false, path: '/bin/claude', stderr: 'spawn EACCES' });
  });

  it('throws harness_binary_broken naming the path and the stderr when asked to assert a broken binary', async () => {
    const { check } = aCheck(vi.fn().mockResolvedValue(BROKEN));

    const failure = await check.assertHealthy('/bin/claude').catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(OpenFleetError);
    expect((failure as OpenFleetError).code).toBe('harness_binary_broken');
    expect((failure as OpenFleetError).message).toContain('/bin/claude');
    expect((failure as OpenFleetError).message).toContain('dyld: Library not loaded');
  });

  it('returns the health of a healthy binary when asked to assert it', async () => {
    const { check } = aCheck(vi.fn().mockResolvedValue(HEALTHY));

    await expect(check.assertHealthy('/bin/claude')).resolves.toMatchObject({ ok: true, version: '2.1.0 (Claude Code)' });
  });
});

describe('runVersionProbe', () => {
  const scriptThatExits = (exitCode: number, stderr: string) => {
    const directory = mkdtempSync(join(tmpdir(), 'of-binary-health-'));
    const path = join(directory, 'fake-claude');
    writeFileSync(path, `#!/bin/sh\necho "${stderr}" 1>&2\nexit ${exitCode}\n`);
    chmodSync(path, 0o755);
    return path;
  };

  it('captures the exit code and stderr of a fake binary that exits 1', async () => {
    const result = await runVersionProbe(scriptThatExits(1, 'boom'));

    expect(result).toMatchObject({ exitCode: 1, stderr: 'boom\n' });
  });

  it('captures a zero exit and stdout of a healthy fake binary', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'of-binary-health-'));
    const path = join(directory, 'fake-claude');
    writeFileSync(path, '#!/bin/sh\necho "9.9.9 (Claude Code)"\n');
    chmodSync(path, 0o755);

    const result = await runVersionProbe(path);

    expect(result).toMatchObject({ exitCode: 0, stdout: '9.9.9 (Claude Code)\n' });
  });
});
