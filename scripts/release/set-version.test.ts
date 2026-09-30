import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'set-version.mjs');

const TAURI_CONF = '{\n  "productName": "openfleet",\n  "version": "0.1.0",\n  "identifier": "dev.openfleet.desktop"\n}\n';
const CARGO_TOML = '[package]\nname = "app"\nversion = "0.1.0"\nauthors = ["you"]\nedition = "2021"\n\n[dependencies]\nserde = { version = "1.0" }\n';
const CRLF_CARGO_TOML = CARGO_TOML.replace(/\n/g, '\r\n');
const CARGO_LOCK ='# lock\nversion = 3\n\n[[package]]\nname = "adler2"\nversion = "2.0.1"\n\n[[package]]\nname = "app"\nversion = "0.1.0"\ndependencies = [\n "adler2",\n]\n\n[[package]]\nname = "app-extras"\nversion = "9.9.9"\n';
const packageJson = (name: string, version: string) => `{\n  "name": "${name}",\n  "version": "${version}",\n  "license": "Apache-2.0",\n  "dependencies": {\n    "left-pad": "^1.0.0"\n  }\n}\n`;

const FILES = {
  tauriConf: 'apps/desktop/src-tauri/tauri.conf.json',
  cargoToml: 'apps/desktop/src-tauri/Cargo.toml',
  cargoLock: 'apps/desktop/src-tauri/Cargo.lock',
  core: 'packages/core/package.json',
  shared: 'packages/shared/package.json',
  desktop: 'apps/desktop/package.json',
} as const;

let root: string;

const write = (relativePath: string, content: string) => {
  mkdirSync(dirname(join(root, relativePath)), { recursive: true });
  writeFileSync(join(root, relativePath), content);
};
const read = (relativePath: string) => readFileSync(join(root, relativePath), 'utf8');
const readAll = () => Object.values(FILES).map(read);
const listTree = () => readdirSync(root, { recursive: true }).map(String).sort();
const runSetVersion = (version: string, { extraArguments = [] }: { extraArguments?: string[] } = {}) => spawnSync('node', [SCRIPT, version, ...extraArguments, '--root', root], { encoding: 'utf8' });
const isCargoAvailable = () => spawnSync('cargo', ['--version']).status === 0;
const INVALID_VERSION = 'not-a-version';

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'of-set-version-'));
  write(FILES.tauriConf, TAURI_CONF);
  write(FILES.cargoToml, CARGO_TOML);
  write(FILES.cargoLock, CARGO_LOCK);
  write(FILES.core, packageJson('@openfleet/core', '0.1.0'));
  write(FILES.shared, packageJson('@openfleet/shared', '0.1.0'));
  write(FILES.desktop, packageJson('@openfleet/desktop', '0.0.0'));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('set-version', () => {
  it('writes the version in tauri.conf.json, Cargo.toml, Cargo.lock and the three package.json files', () => {
    const result = runSetVersion('0.2.0-beta.1');

    expect(result.status).toBe(0);
    expect(read(FILES.tauriConf)).toBe(TAURI_CONF.replace('"version": "0.1.0"', '"version": "0.2.0-beta.1"'));
    expect(read(FILES.cargoToml)).toBe(CARGO_TOML.replace('version = "0.1.0"', 'version = "0.2.0-beta.1"'));
    expect(read(FILES.cargoLock)).toBe(CARGO_LOCK.replace('name = "app"\nversion = "0.1.0"', 'name = "app"\nversion = "0.2.0-beta.1"'));
    expect(JSON.parse(read(FILES.core))).toMatchObject({ name: '@openfleet/core', version: '0.2.0-beta.1', license: 'Apache-2.0', dependencies: { 'left-pad': '^1.0.0' } });
    expect(JSON.parse(read(FILES.shared)).version).toBe('0.2.0-beta.1');
    expect(JSON.parse(read(FILES.desktop)).version).toBe('0.2.0-beta.1');
  });

  it('prints a summary naming the version and every file it touched', () => {
    const result = runSetVersion('0.2.0');

    expect(result.stdout).toContain('0.2.0');
    for (const file of Object.values(FILES)) expect(result.stdout).toContain(file);
  });

  it('leaves the files byte-identical when run twice with the same version', () => {
    runSetVersion('0.2.0');
    const afterFirstRun = readAll();

    const secondRun = runSetVersion('0.2.0');

    expect(secondRun.status).toBe(0);
    expect(readAll()).toEqual(afterFirstRun);
  });

  it.each(['garbage', '1.2', 'v1.2.3', '01.2.3', '1.2.3-', '1.2.3+', '1.2.3 ; rm -rf', ''])('refuses "%s" and writes nothing', (invalidVersion) => {
    const before = readAll();

    const result = runSetVersion(invalidVersion);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('SemVer');
    expect(readAll()).toEqual(before);
  });

  it('refuses without writing anything when one file has no version to replace', () => {
    write(FILES.shared, '{\n  "name": "@openfleet/shared"\n}\n');
    const before = readAll();

    const result = runSetVersion('0.2.0');

    expect(result.status).not.toBe(0);
    expect(readAll()).toEqual(before);
  });

  it.each(['1.0.0+abc', '1.0.0-beta.1', '1.0.0-rc.1+build.5', '0.0.0'])('accepts "%s" and leaves every file parseable', (validVersion) => {
    const result = runSetVersion(validVersion);

    expect(result.status).toBe(0);
    for (const jsonFile of [FILES.tauriConf, FILES.core, FILES.shared, FILES.desktop]) expect(JSON.parse(read(jsonFile)).version).toBe(validVersion);
    expect(read(FILES.cargoToml)).toContain(`version = "${validVersion}"`);
    expect(read(FILES.cargoLock)).toContain(`name = "app"\nversion = "${validVersion}"`);
  });

  it.each(['1.2.3\n', '1.2.3\n"evil": 1', '1.2.3"\nname = "x', '١.٢.٣', '1.2.3-١', '../../etc/passwd', '$1', '$&', ' 1.2.3', '1.2.3 '])('refuses the hostile version %j and writes nothing', (hostileVersion) => {
    const before = readAll();

    const result = runSetVersion(hostileVersion);

    expect(result.status).not.toBe(0);
    expect(readAll()).toEqual(before);
  });

  it('refuses without writing anything when a file is missing', () => {
    rmSync(join(root, FILES.cargoLock));
    const before = [FILES.tauriConf, FILES.cargoToml, FILES.core, FILES.shared, FILES.desktop].map(read);

    const result = runSetVersion('0.2.0');

    expect(result.status).not.toBe(0);
    expect([FILES.tauriConf, FILES.cargoToml, FILES.core, FILES.shared, FILES.desktop].map(read)).toEqual(before);
  });

  it('refuses without writing anything when Cargo.toml has a dependency version but no package version', () => {
    write(FILES.cargoToml, '[package]\nname = "app"\nedition = "2021"\n\n[dependencies.serde]\nversion = "1.0"\n');
    const before = readAll();

    const result = runSetVersion('0.2.0');

    expect(result.status).not.toBe(0);
    expect(readAll()).toEqual(before);
  });

  it('changes only the top-level version of a package.json that also has a nested version', () => {
    const nested = '{\n  "name": "@openfleet/core",\n  "pnpm": {\n    "version": "9.9.9"\n  },\n  "version": "0.1.0"\n}\n';
    write(FILES.core, nested);

    runSetVersion('0.2.0');

    expect(JSON.parse(read(FILES.core))).toEqual({ name: '@openfleet/core', pnpm: { version: '9.9.9' }, version: '0.2.0' });
  });

  it('does not touch the lockfile entry of a crate whose name merely starts with the app crate name', () => {
    runSetVersion('0.2.0');

    expect(read(FILES.cargoLock)).toContain('name = "app-extras"\nversion = "9.9.9"');
  });

  it('follows the crate name declared in Cargo.toml when updating Cargo.lock', () => {
    write(FILES.cargoToml, CARGO_TOML.replace('name = "app"', 'name = "fleet-desktop"'));
    write(FILES.cargoLock, `${CARGO_LOCK}\n[[package]]\nname = "fleet-desktop"\nversion = "0.1.0"\n`);

    runSetVersion('0.2.0');

    expect(read(FILES.cargoLock)).toContain('name = "fleet-desktop"\nversion = "0.2.0"');
    expect(read(FILES.cargoLock)).toContain('name = "app"\nversion = "0.1.0"');
  });

  it('leaves every file untouched, with a one-line error and no temp file, when the last file cannot be written', () => {
    const before = readAll();
    chmodSync(join(root, FILES.cargoLock), 0o444);
    const directoriesBefore = listTree();

    const result = runSetVersion('0.2.0');

    expect(result.status).not.toBe(0);
    expect(result.stderr.trim().split('\n')).toHaveLength(1);
    expect(result.stderr).toContain('set-version:');
    expect(readAll()).toEqual(before);
    expect(listTree()).toEqual(directoriesBefore);
  });

  it('keeps the file modes of the files it rewrites', () => {
    chmodSync(join(root, FILES.cargoToml), 0o755);

    runSetVersion('0.2.0');

    expect(statSync(join(root, FILES.cargoToml)).mode & 0o777).toBe(0o755);
  });

  it('names the missing file in a one-line error instead of a stack trace', () => {
    rmSync(join(root, FILES.cargoLock));

    const result = runSetVersion('0.2.0');

    expect(result.stderr.trim().split('\n')).toHaveLength(1);
    expect(result.stderr).toContain(FILES.cargoLock);
  });

  it('refuses a --root flag that has no value', () => {
    // An invalid version: if the argument check ever regressed, the run would fall back to the real repo root and still write nothing.
    const result = spawnSync('node', [SCRIPT, INVALID_VERSION, '--root'], { encoding: 'utf8' });

    expect(result.status).not.toBe(0);
    expect(result.stderr.trim().split('\n')).toHaveLength(1);
    expect(result.stderr).toContain('--root');
  });

  it('passes an explicit --root or an invalid version in every invocation of the script in this file', () => {
    const source = readFileSync(fileURLToPath(import.meta.url), 'utf8');
    const invocationLines = source.split('\n').filter((line) => line.includes('spawnSync(') && line.includes('SCRIPT,') && !line.includes('invocationLines'));

    expect(invocationLines.length).toBeGreaterThan(0);
    for (const line of invocationLines) expect(line).toMatch(/'--root'|INVALID_VERSION/);
  });

  it.each([0o664, 0o600, 0o755])('keeps the file mode %o of a rewritten Cargo.toml whatever the umask', (mode) => {
    chmodSync(join(root, FILES.cargoToml), mode);

    runSetVersion('0.2.0');

    expect(statSync(join(root, FILES.cargoToml)).mode & 0o777).toBe(mode);
  });

  it('refuses an extra positional argument with a one-line error and writes nothing', () => {
    const before = readAll();

    const result = runSetVersion('0.3.0', { extraArguments: ['9.9.9'] });

    expect(result.status).not.toBe(0);
    expect(result.stderr.trim().split('\n')).toHaveLength(1);
    expect(result.stderr).toContain('9.9.9');
    expect(readAll()).toEqual(before);
  });

  it.each(['18446744073709551616.0.0', '0.18446744073709551616.0', '0.0.18446744073709551616', '99999999999999999999.0.0-beta'])('refuses "%s", whose numeric component cargo cannot parse, and writes nothing', (tooLargeVersion) => {
    const before = readAll();

    const result = runSetVersion(tooLargeVersion);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('SemVer');
    expect(readAll()).toEqual(before);
  });

  it('accepts the largest numeric component cargo can parse', () => {
    const result = runSetVersion('18446744073709551615.0.0');

    expect(result.status).toBe(0);
    expect(read(FILES.cargoToml)).toContain('version = "18446744073709551615.0.0"');
  });

  it('refuses a prerelease longer than 256 characters and writes nothing', () => {
    const before = readAll();

    const result = runSetVersion(`1.0.0-${'a'.repeat(300)}`);

    expect(result.status).not.toBe(0);
    expect(readAll()).toEqual(before);
  });

  it('keeps a trailing comment on the Cargo.toml version line', () => {
    write(FILES.cargoToml, CARGO_TOML.replace('version = "0.1.0"', 'version = "0.1.0" # bumped by set-version'));

    runSetVersion('0.2.0');

    expect(read(FILES.cargoToml)).toContain('version = "0.2.0" # bumped by set-version\n');
  });

  it('keeps the CRLF line endings of Cargo.toml', () => {
    write(FILES.cargoToml, CRLF_CARGO_TOML);

    const result = runSetVersion('0.2.0');

    expect(result.status).toBe(0);
    expect(read(FILES.cargoToml)).toBe(CRLF_CARGO_TOML.replace('version = "0.1.0"', 'version = "0.2.0"'));
  });

  it('refuses a symlinked version file with a one-line error, leaves the link and its target alone, and writes nothing', () => {
    const realCore = join(root, 'core-package.json');
    writeFileSync(realCore, packageJson('@openfleet/core', '0.1.0'));
    rmSync(join(root, FILES.core));
    symlinkSync(realCore, join(root, FILES.core));
    const before = [FILES.tauriConf, FILES.cargoToml, FILES.cargoLock, FILES.shared, FILES.desktop].map(read);

    const result = runSetVersion('0.2.0');

    expect(result.status).not.toBe(0);
    expect(result.stderr.trim().split('\n')).toHaveLength(1);
    expect(result.stderr).toContain('symlink');
    expect(lstatSync(join(root, FILES.core)).isSymbolicLink()).toBe(true);
    expect(readFileSync(realCore, 'utf8')).toContain('"version": "0.1.0"');
    expect([FILES.tauriConf, FILES.cargoToml, FILES.cargoLock, FILES.shared, FILES.desktop].map(read)).toEqual(before);
  });

  it('completes a half-bumped tree when the same version is run again', () => {
    write(FILES.tauriConf, TAURI_CONF.replace('"version": "0.1.0"', '"version": "0.2.0"'));
    write(FILES.core, packageJson('@openfleet/core', '0.2.0'));

    const result = runSetVersion('0.2.0');

    expect(result.status).toBe(0);
    expect(JSON.parse(read(FILES.shared)).version).toBe('0.2.0');
    expect(JSON.parse(read(FILES.desktop)).version).toBe('0.2.0');
    expect(read(FILES.cargoToml)).toContain('version = "0.2.0"');
    expect(read(FILES.cargoLock)).toContain('name = "app"\nversion = "0.2.0"');
  });

  it('sweeps stale temp files left by a dead process and keeps the temp files of a living one', () => {
    const staleTemp = join(root, `${FILES.core}.set-version-999999999.tmp`);
    const livingTemp = join(root, `${FILES.core}.set-version-${process.pid}.tmp`);
    writeFileSync(staleTemp, 'stale');
    writeFileSync(livingTemp, 'living');

    runSetVersion('0.2.0');

    expect(existsSync(staleTemp)).toBe(false);
    expect(existsSync(livingTemp)).toBe(true);
  });

  it.runIf(isCargoAvailable())('leaves a crate that cargo still accepts with --locked --offline', () => {
    write(FILES.cargoToml, '[package]\nname = "app"\nversion = "0.1.0"\nedition = "2021"\n');
    write('apps/desktop/src-tauri/src/main.rs', 'fn main() {}\n');
    write(FILES.cargoLock, '# This file is automatically @generated by Cargo.\n# It is not intended for manual editing.\nversion = 4\n\n[[package]]\nname = "app"\nversion = "0.1.0"\n');

    const bump = runSetVersion('0.2.0');
    const metadata = spawnSync('cargo', ['metadata', '--locked', '--offline', '--format-version', '1', '--manifest-path', join(root, FILES.cargoToml)], { encoding: 'utf8' });

    expect(bump.status).toBe(0);
    expect(metadata.stderr).toBe('');
    expect(metadata.status).toBe(0);
    expect(JSON.parse(metadata.stdout).packages[0].version).toBe('0.2.0');
  });
});
