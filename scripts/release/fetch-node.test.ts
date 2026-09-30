import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fetchNode } from './fetch-node.mjs';

const SCRIPT_FOLDER = dirname(fileURLToPath(import.meta.url));
const VERSION = '26.9.0';
const TARBALL_NAME = `node-v${VERSION}-darwin-arm64.tar.gz`;
const BASE_URL = `https://nodejs.org/dist/v${VERSION}`;
const BINARY_NAME = 'node-aarch64-apple-darwin';
const FAKE_NODE_BODY = '#!/bin/sh\necho fake-node\n';

let workFolder: string;
let binariesFolder: string;

const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

const buildTarball = (): Buffer => {
  const stage = join(workFolder, 'stage');
  const packageFolder = join(stage, `node-v${VERSION}-darwin-arm64`);
  mkdirSync(join(packageFolder, 'bin'), { recursive: true });
  writeFileSync(join(packageFolder, 'bin/node'), FAKE_NODE_BODY);
  writeFileSync(join(packageFolder, 'LICENSE'), 'license');
  const tarball = join(workFolder, TARBALL_NAME);
  spawnSync('tar', ['-czf', tarball, '-C', stage, `node-v${VERSION}-darwin-arm64`]);
  return readFileSync(tarball);
};

const serve = ({ tarball, shasums }: { tarball: Buffer; shasums: string }) => {
  const requestedUrls: string[] = [];
  const fetchBytes = async (url: string) => {
    requestedUrls.push(url);
    if (url === `${BASE_URL}/${TARBALL_NAME}`) return tarball;
    if (url === `${BASE_URL}/SHASUMS256.txt`) return Buffer.from(shasums);
    throw new Error(`unexpected url ${url}`);
  };
  return { fetchBytes, requestedUrls };
};

const shasumsFor = (tarball: Buffer) => `${'a'.repeat(64)}  node-v${VERSION}-linux-x64.tar.gz\n${sha256(tarball)}  ${TARBALL_NAME}\n`;
const neverInstalled = () => undefined;
const installedBinary = () => join(binariesFolder, BINARY_NAME);
const leftovers = () => (existsSync(binariesFolder) ? readdirSync(binariesFolder).filter((name) => name !== BINARY_NAME) : []);

beforeEach(() => {
  workFolder = mkdtempSync(join(tmpdir(), 'of-fetch-node-'));
  binariesFolder = join(workFolder, 'binaries');
});
afterEach(() => rmSync(workFolder, { recursive: true, force: true }));

describe('fetchNode', () => {
  it('downloads the tarball, verifies its checksum and installs bin/node as an executable', async () => {
    const tarball = buildTarball();
    const { fetchBytes } = serve({ tarball, shasums: shasumsFor(tarball) });

    const result = await fetchNode({ version: VERSION, binariesFolder, fetchBytes, installedVersion: neverInstalled });

    expect(result).toEqual({ status: 'installed', path: installedBinary() });
    expect(readFileSync(installedBinary(), 'utf8')).toBe(FAKE_NODE_BODY);
    expect(statSync(installedBinary()).mode & 0o777).toBe(0o755);
    expect(leftovers()).toEqual([]);
  });

  it('refuses a tarball whose checksum differs from SHASUMS256.txt and installs nothing', async () => {
    const tarball = buildTarball();
    const tampered = Buffer.concat([tarball, Buffer.from('x')]);
    const { fetchBytes } = serve({ tarball: tampered, shasums: shasumsFor(tarball) });

    await expect(fetchNode({ version: VERSION, binariesFolder, fetchBytes, installedVersion: neverInstalled })).rejects.toThrow(/checksum/i);

    expect(existsSync(installedBinary())).toBe(false);
    expect(leftovers()).toEqual([]);
  });

  it('refuses when SHASUMS256.txt does not list the tarball', async () => {
    const tarball = buildTarball();
    const { fetchBytes } = serve({ tarball, shasums: `${'a'.repeat(64)}  node-v${VERSION}-linux-x64.tar.gz\n` });

    await expect(fetchNode({ version: VERSION, binariesFolder, fetchBytes, installedVersion: neverInstalled })).rejects.toThrow(TARBALL_NAME);

    expect(existsSync(installedBinary())).toBe(false);
  });

  it('skips the download when the installed binary already reports the pinned version', async () => {
    mkdirSync(binariesFolder, { recursive: true });
    writeFileSync(installedBinary(), 'existing');
    const fetchBytes = async () => {
      throw new Error('no network expected');
    };

    const result = await fetchNode({ version: VERSION, binariesFolder, fetchBytes, installedVersion: () => `v${VERSION}` });

    expect(result).toEqual({ status: 'skipped', path: installedBinary() });
    expect(readFileSync(installedBinary(), 'utf8')).toBe('existing');
  });

  it('downloads again when the installed binary reports another version', async () => {
    const tarball = buildTarball();
    mkdirSync(binariesFolder, { recursive: true });
    writeFileSync(installedBinary(), 'old');
    const { fetchBytes } = serve({ tarball, shasums: shasumsFor(tarball) });

    const result = await fetchNode({ version: VERSION, binariesFolder, fetchBytes, installedVersion: () => 'v25.0.0' });

    expect(result.status).toBe('installed');
    expect(readFileSync(installedBinary(), 'utf8')).toBe(FAKE_NODE_BODY);
  });

  it('refuses to write through a symlink at the target path', async () => {
    const tarball = buildTarball();
    const victim = join(workFolder, 'victim');
    writeFileSync(victim, 'precious');
    mkdirSync(binariesFolder, { recursive: true });
    symlinkSync(victim, installedBinary());
    const { fetchBytes } = serve({ tarball, shasums: shasumsFor(tarball) });

    await expect(fetchNode({ version: VERSION, binariesFolder, fetchBytes, installedVersion: neverInstalled })).rejects.toThrow(/symlink/i);

    expect(readFileSync(victim, 'utf8')).toBe('precious');
    expect(lstatSync(installedBinary()).isSymbolicLink()).toBe(true);
  });

  it('refuses a target other than aarch64-apple-darwin', async () => {
    const fetchBytes = async () => Buffer.alloc(0);

    await expect(fetchNode({ version: VERSION, target: 'x86_64-apple-darwin', binariesFolder, fetchBytes, installedVersion: neverInstalled })).rejects.toThrow(/x86_64-apple-darwin/);
  });

  it('refuses a version that is not a plain semver', async () => {
    const fetchBytes = async () => Buffer.alloc(0);

    await expect(fetchNode({ version: '../evil', binariesFolder, fetchBytes, installedVersion: neverInstalled })).rejects.toThrow(/version/i);
  });
});

describe('node-version.txt', () => {
  it('pins the version the daemon is developed on', () => {
    expect(readFileSync(join(SCRIPT_FOLDER, 'node-version.txt'), 'utf8').trim()).toBe(VERSION);
  });
});
