import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
const runSetVersion = (version: string) => spawnSync('node', [SCRIPT, version, '--root', root], { encoding: 'utf8' });

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
});
