import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'set-version.mjs');

const TAURI_CONF = '{\n  "productName": "openfleet",\n  "version": "0.1.0",\n  "identifier": "dev.openfleet.desktop"\n}\n';
const CARGO_TOML = '[package]\nname = "app"\nversion = "0.1.0"\nauthors = ["you"]\nedition = "2021"\n\n[dependencies]\nserde = { version = "1.0" }\n';
const CARGO_LOCK = '# lock\nversion = 3\n\n[[package]]\nname = "adler2"\nversion = "2.0.1"\n\n[[package]]\nname = "app"\nversion = "0.1.0"\ndependencies = [\n "adler2",\n]\n\n[[package]]\nname = "app-extras"\nversion = "9.9.9"\n';
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
const runSetVersion =(version: string) => spawnSync('node', [SCRIPT, version, '--root', root], { encoding: 'utf8' });

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
    const result = spawnSync('node', [SCRIPT, '0.2.0', '--root'], { encoding: 'utf8' });

    expect(result.status).not.toBe(0);
    expect(result.stderr.trim().split('\n')).toHaveLength(1);
    expect(result.stderr).toContain('--root');
  });
});
