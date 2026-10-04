import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { beforeEach, describe, expect, it } from 'vitest';
import { buildScapeFixture, type ScapeFixture } from './scape/scapeFixture.testkit.js';

describe('the packaged core entry', () => {
  let fixture: ScapeFixture;
  let bundlePath: string;

  beforeEach(async () => {
    fixture = buildScapeFixture();
    bundlePath = join(fixture.workDir, 'daemon.bundle.mjs');
    const coreModules = fileURLToPath(new URL('../../node_modules', import.meta.url));
    symlinkSync(coreModules, join(fixture.workDir, 'node_modules'), 'dir');
    cpSync(fileURLToPath(new URL('../db/migrations', import.meta.url)), join(fixture.workDir, 'migrations'), { recursive: true });
    await build({
      entryPoints: [fileURLToPath(new URL('../main.ts', import.meta.url))],
      outfile: bundlePath,
      bundle: true,
      platform: 'node',
      format: 'esm',
      external: ['node-pty'],
      banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
    });
  });

  const run = (args: string[]) => spawnSync(process.execPath, [bundlePath, 'import', ...args], {
    encoding: 'utf8',
    timeout: 10_000,
    env: { ...process.env, OPENFLEET_HOME: join(fixture.workDir, 'unexpected-daemon-home'), OPENFLEET_PORT: 'invalid' },
  });

  it('prints importer help without starting the daemon', () => {
    const result = run(['scape', '--help']);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('--report-dir');
    expect(result.stderr).not.toContain('refusing to boot');
    expect(existsSync(join(fixture.workDir, 'unexpected-daemon-home'))).toBe(false);
  });

  it('prints importer help without opening a database, binding a port or writing a log', () => {
    const guardPath = join(fixture.workDir, 'daemon-side-effect-guard.mjs');
    writeFileSync(guardPath, `
import net from 'node:net';
import sqlite from 'node:sqlite';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const rejectSideEffect = () => { throw new Error('DAEMON_SIDE_EFFECT'); };
net.Server.prototype.listen = rejectSideEffect;
sqlite.DatabaseSync = rejectSideEffect;
fs.mkdirSync = rejectSideEffect;
fs.writeFileSync = rejectSideEffect;
fs.appendFileSync = rejectSideEffect;
syncBuiltinESMExports();
`);

    const result = spawnSync(process.execPath, ['--import', guardPath, bundlePath, 'import', 'scape', '--help'], {
      encoding: 'utf8', timeout: 10_000,
      env: { ...process.env, OPENFLEET_HOME: join(fixture.workDir, 'unexpected-daemon-home') },
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('--report-dir');
    expect(result.stderr).not.toContain('DAEMON_SIDE_EFFECT');
    expect(existsSync(join(fixture.workDir, 'unexpected-daemon-home'))).toBe(false);
  });

  it('imports a synthetic Scape home through the built entry', () => {
    const home = join(fixture.workDir, 'target');

    const result = run(['scape', '--home', home, '--scape-dir', fixture.scapeDir]);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('Import written. Report:');
    expect(existsSync(join(home, 'openfleet.db'))).toBe(true);
    expect(existsSync(join(fixture.workDir, 'unexpected-daemon-home'))).toBe(false);
  });

  it('rejects another import source with the CLI exit code', () => {
    const result = run(['unknown']);

    expect(result.status, result.stderr).toBe(2);
    expect(result.stdout).toContain('INVALID_ARGUMENTS');
  });

  it.each([{ label: 'no arguments', args: [] }, { label: 'unknown arguments', args: ['unknown-command'] }])(
    'follows the daemon boot path with $label', ({ args }) => {
      const home = join(fixture.workDir, 'daemon-home');
      mkdirSync(home);
      writeFileSync(join(home, 'config.json'), '{ invalid JSON');

      const result = spawnSync(process.execPath, [bundlePath, ...args], {
        encoding: 'utf8', timeout: 10_000, env: { OPENFLEET_HOME: home },
      });

      expect(result.status, result.stderr).toBe(1);
      expect(result.stderr).toContain('refusing to boot (config:');
      expect(result.stdout).not.toContain('INVALID_ARGUMENTS');
      expect(existsSync(join(home, 'openfleet.db'))).toBe(true);
    },
  );
});
