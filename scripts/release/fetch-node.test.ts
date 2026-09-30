import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { downloadBytes, extractNodeBinary as extractNodeBinaryFor, fetchNode, runInstalledVersion } from './fetch-node.mjs';

const SCRIPT_FOLDER = dirname(fileURLToPath(import.meta.url));
const VERSION = '26.9.0';
const TARBALL_NAME = `node-v${VERSION}-darwin-arm64.tar.gz`;
const BASE_URL = `https://nodejs.org/dist/v${VERSION}`;
const BINARY_NAME = 'node-aarch64-apple-darwin';
const FAKE_NODE_BODY = '#!/bin/sh\necho fake-node\n';

let workFolder: string;
let binariesFolder: string;

const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

const buildTarball = (platform = 'darwin-arm64'): Buffer => {
  const stage = join(workFolder, 'stage');
  const packageFolder = join(stage, `node-v${VERSION}-${platform}`);
  mkdirSync(join(packageFolder, 'bin'), { recursive: true });
  writeFileSync(join(packageFolder, 'bin/node'), FAKE_NODE_BODY);
  writeFileSync(join(packageFolder, 'LICENSE'), 'license');
  const tarball = join(workFolder, `${platform}.tar.gz`);
  spawnSync('tar', ['-czf', tarball, '-C', stage, `node-v${VERSION}-${platform}`]);
  return readFileSync(tarball);
};

const serve = ({ tarball, shasums, tarballName = TARBALL_NAME }: { tarball: Buffer; shasums: string; tarballName?: string }) => {
  const requestedUrls: string[] = [];
  const fetchBytes = async (url: string) => {
    requestedUrls.push(url);
    if (url === `${BASE_URL}/${tarballName}`) return tarball;
    if (url === `${BASE_URL}/SHASUMS256.txt`) return Buffer.from(shasums);
    throw new Error(`unexpected url ${url}`);
  };
  return { fetchBytes, requestedUrls };
};

const shasumsFor = (tarball: Buffer) => `${'a'.repeat(64)}  node-v${VERSION}-linux-x64.tar.gz\n${sha256(tarball)}  ${TARBALL_NAME}\n`;
const neverInstalled = () => undefined;
const installedBinary = () => join(binariesFolder, BINARY_NAME);
const checksumRecord = () => `${installedBinary()}.sha256`;
const leftovers = () => (existsSync(binariesFolder) ? readdirSync(binariesFolder).filter((name) => name !== BINARY_NAME && name !== `${BINARY_NAME}.sha256`) : []);

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

  it('records the verified tarball sha256 and the installed binary sha256 next to the binary', async () => {
    const tarball = buildTarball();
    const { fetchBytes } = serve({ tarball, shasums: shasumsFor(tarball) });

    await fetchNode({ version: VERSION, binariesFolder, fetchBytes, installedVersion: neverInstalled });

    expect(readFileSync(checksumRecord(), 'utf8')).toBe(`tarball ${sha256(tarball)}\nbinary ${sha256(Buffer.from(FAKE_NODE_BODY))}\n`);
  });

  const installBinaryWithRecord = ({ body, recordedBinaryBody = body }: { body: string; recordedBinaryBody?: string }) => {
    mkdirSync(binariesFolder, { recursive: true });
    writeFileSync(installedBinary(), body);
    writeFileSync(checksumRecord(), `tarball ${'c'.repeat(64)}\nbinary ${sha256(Buffer.from(recordedBinaryBody))}\n`);
  };

  it('skips without any network call when the installed binary reports the pinned version and hashes to the recorded binary sha256', async () => {
    installBinaryWithRecord({ body: 'existing' });
    const fetchBytes = vi.fn(async () => {
      throw new Error('offline');
    });

    const result = await fetchNode({ version: VERSION, binariesFolder, fetchBytes, installedVersion: () => `v${VERSION}` });

    expect(result).toEqual({ status: 'skipped', path: installedBinary() });
    expect(readFileSync(installedBinary(), 'utf8')).toBe('existing');
    expect(fetchBytes).not.toHaveBeenCalled();
  });

  it('installs again when the binary on disk is not the one the record was written for (a Homebrew node copied over the fetched one)', async () => {
    const tarball = buildTarball();
    installBinaryWithRecord({ body: 'copied from homebrew', recordedBinaryBody: 'fetched' });
    const { fetchBytes } = serve({ tarball, shasums: shasumsFor(tarball) });

    const result = await fetchNode({ version: VERSION, binariesFolder, fetchBytes, installedVersion: () => `v${VERSION}` });

    expect(result.status).toBe('installed');
    expect(readFileSync(installedBinary(), 'utf8')).toBe(FAKE_NODE_BODY);
  });

  it('installs again when the record is the old single-line format, which carries no binary sha256', async () => {
    const tarball = buildTarball();
    mkdirSync(binariesFolder, { recursive: true });
    writeFileSync(installedBinary(), 'existing');
    writeFileSync(checksumRecord(), `${sha256(tarball)}\n`);
    const { fetchBytes } = serve({ tarball, shasums: shasumsFor(tarball) });

    const result = await fetchNode({ version: VERSION, binariesFolder, fetchBytes, installedVersion: () => `v${VERSION}` });

    expect(result.status).toBe('installed');
  });

  it('installs again when the version matches but no sha256 was recorded (a binary copied in by hand)', async () => {
    const tarball = buildTarball();
    mkdirSync(binariesFolder, { recursive: true });
    writeFileSync(installedBinary(), 'copied from homebrew');
    const { fetchBytes } = serve({ tarball, shasums: shasumsFor(tarball) });

    const result = await fetchNode({ version: VERSION, binariesFolder, fetchBytes, installedVersion: () => `v${VERSION}` });

    expect(result.status).toBe('installed');
    expect(readFileSync(installedBinary(), 'utf8')).toBe(FAKE_NODE_BODY);
  });

  it('downloads again when the installed binary reports another version', async () => {
    const tarball = buildTarball();
    installBinaryWithRecord({ body: 'old' });
    const { fetchBytes } = serve({ tarball, shasums: shasumsFor(tarball) });

    const result = await fetchNode({ version: VERSION, binariesFolder, fetchBytes, installedVersion: () => 'v25.0.0' });

    expect(result.status).toBe('installed');
    expect(readFileSync(installedBinary(), 'utf8')).toBe(FAKE_NODE_BODY);
  });

  it('verifies the checksum before it extracts anything from the tarball', async () => {
    const tarball = buildTarball();
    const tampered = Buffer.concat([tarball, Buffer.from('x')]);
    const { fetchBytes } = serve({ tarball: tampered, shasums: shasumsFor(tarball) });
    const extractBinary = vi.fn();

    await expect(fetchNode({ version: VERSION, binariesFolder, fetchBytes, installedVersion: neverInstalled, extractBinary })).rejects.toThrow(/checksum/i);

    expect(extractBinary).not.toHaveBeenCalled();
  });

  it('extracts only after the tarball was downloaded and verified', async () => {
    const tarball = buildTarball();
    const calls: string[] = [];
    const { fetchBytes } = serve({ tarball, shasums: shasumsFor(tarball) });
    const recordingFetch = async (url: string) => {
      calls.push(url.endsWith('.txt') ? 'fetch shasums' : 'fetch tarball');
      return fetchBytes(url);
    };
    const extractBinary = (arguments_: { tarball: Buffer; packageName: string; scratchFolder: string }) => {
      calls.push('extract');
      return extractNodeBinaryFor(arguments_);
    };

    await fetchNode({ version: VERSION, binariesFolder, fetchBytes: recordingFetch, installedVersion: neverInstalled, extractBinary });

    expect(calls).toEqual(['fetch shasums', 'fetch tarball', 'extract']);
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

  it('refuses a target other than the two macOS ones', async () => {
    const fetchBytes = async () => Buffer.alloc(0);

    await expect(fetchNode({ version: VERSION, target: 'riscv64-unknown-linux-gnu', binariesFolder, fetchBytes, installedVersion: neverInstalled })).rejects.toThrow(/riscv64-unknown-linux-gnu.*aarch64-apple-darwin.*x86_64-apple-darwin/);
  });

  describe('for x86_64-apple-darwin', () => {
    const X64_TARGET = 'x86_64-apple-darwin';
    const X64_TARBALL_NAME = `node-v${VERSION}-darwin-x64.tar.gz`;
    const x64Binary = () => join(binariesFolder, 'node-x86_64-apple-darwin');

    it('downloads the darwin-x64 tarball, verifies it and records both sha256 next to node-x86_64-apple-darwin', async () => {
      const tarball = buildTarball('darwin-x64');
      const shasums = `${sha256(tarball)}  ${X64_TARBALL_NAME}\n${'b'.repeat(64)}  ${TARBALL_NAME}\n`;
      const { fetchBytes, requestedUrls } = serve({ tarball, shasums, tarballName: X64_TARBALL_NAME });

      const result = await fetchNode({ version: VERSION, target: X64_TARGET, binariesFolder, fetchBytes, installedVersion: neverInstalled });

      expect(result).toEqual({ status: 'installed', path: x64Binary() });
      expect(requestedUrls).toContain(`${BASE_URL}/${X64_TARBALL_NAME}`);
      expect(readFileSync(`${x64Binary()}.sha256`, 'utf8')).toBe(`tarball ${sha256(tarball)}\nbinary ${sha256(Buffer.from(FAKE_NODE_BODY))}\n`);
      expect(statSync(x64Binary()).mode & 0o777).toBe(0o755);
    });

    it('refuses the darwin-x64 tarball when its checksum differs from the published one', async () => {
      const tarball = buildTarball('darwin-x64');
      const shasums = `${'d'.repeat(64)}  ${X64_TARBALL_NAME}\n`;
      const { fetchBytes } = serve({ tarball, shasums, tarballName: X64_TARBALL_NAME });

      await expect(fetchNode({ version: VERSION, target: X64_TARGET, binariesFolder, fetchBytes, installedVersion: neverInstalled })).rejects.toThrow(/checksum/i);

      expect(existsSync(x64Binary())).toBe(false);
    });

    it('skips offline on its own record and leaves the arm64 sidecar untouched', async () => {
      mkdirSync(binariesFolder, { recursive: true });
      writeFileSync(x64Binary(), 'existing-x64');
      writeFileSync(`${x64Binary()}.sha256`, `tarball ${'c'.repeat(64)}\nbinary ${sha256(Buffer.from('existing-x64'))}\n`);
      const fetchBytes = vi.fn(async () => {
        throw new Error('offline');
      });

      const result = await fetchNode({ version: VERSION, target: X64_TARGET, binariesFolder, fetchBytes, installedVersion: () => `v${VERSION}` });

      expect(result).toEqual({ status: 'skipped', path: x64Binary() });
      expect(fetchBytes).not.toHaveBeenCalled();
      expect(existsSync(installedBinary())).toBe(false);
    });
  });

  it('refuses a version that is not a plain semver', async () => {
    const fetchBytes = async () => Buffer.alloc(0);

    await expect(fetchNode({ version: '../evil', binariesFolder, fetchBytes, installedVersion: neverInstalled })).rejects.toThrow(/version/i);
  });
});

describe('downloadBytes', () => {
  afterEach(() => vi.restoreAllMocks());

  it('gives every request a 60 s timeout signal, so a hanging network cannot hang the build', async () => {
    const timeoutSignal = new AbortController().signal;
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(timeoutSignal);
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('ok'));

    await downloadBytes('https://nodejs.org/x');

    expect(timeout).toHaveBeenCalledWith(60_000);
    expect(fetchSpy).toHaveBeenCalledWith('https://nodejs.org/x', { signal: timeoutSignal });
  });
});

describe('runInstalledVersion', () => {
  const scriptPrinting = (body: string) => {
    mkdirSync(binariesFolder, { recursive: true });
    writeFileSync(installedBinary(), body, { mode: 0o755 });
    return installedBinary();
  };

  it('returns the version the binary prints, without the trailing newline', () => {
    expect(runInstalledVersion(scriptPrinting('#!/bin/sh\necho v26.9.0\n'))).toBe('v26.9.0');
  });

  it('returns nothing when the binary exits non-zero, whatever it printed', () => {
    expect(runInstalledVersion(scriptPrinting('#!/bin/sh\necho v26.9.0\nexit 1\n'))).toBeUndefined();
  });

  it('returns nothing when there is no binary', () => {
    expect(runInstalledVersion(join(binariesFolder, 'missing'))).toBeUndefined();
  });
});

describe('node-version.txt', () => {
  it('pins the version the daemon is developed on', () => {
    expect(readFileSync(join(SCRIPT_FOLDER, 'node-version.txt'), 'utf8').trim()).toBe(VERSION);
  });
});
