import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
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

  it('records the verified tarball sha256, the installed binary sha256, the version and the target next to the binary', async () => {
    const tarball = buildTarball();
    const { fetchBytes } = serve({ tarball, shasums: shasumsFor(tarball) });

    await fetchNode({ version: VERSION, binariesFolder, fetchBytes, installedVersion: neverInstalled });

    expect(readFileSync(checksumRecord(), 'utf8')).toBe(`tarball ${sha256(tarball)}\nbinary ${sha256(Buffer.from(FAKE_NODE_BODY))}\nversion ${VERSION}\ntarget aarch64-apple-darwin\n`);
  });

  const installBinaryWithRecord = ({ body, recordedBinaryBody = body }: { body: string; recordedBinaryBody?: string }) => {
    mkdirSync(binariesFolder, { recursive: true });
    writeFileSync(installedBinary(), body);
    writeFileSync(checksumRecord(), `tarball ${'c'.repeat(64)}\nbinary ${sha256(Buffer.from(recordedBinaryBody))}\n`);
  };

  it('skips without any network call when a legacy-record binary hashes to the recorded sha256 and reports the pinned version on a host that can run it', async () => {
    installBinaryWithRecord({ body: 'existing' });
    const fetchBytes = vi.fn(async () => {
      throw new Error('offline');
    });

    const result = await fetchNode({ version: VERSION, binariesFolder, fetchBytes, installedVersion: () => `v${VERSION}`, hostTarget: 'aarch64-apple-darwin' });

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

  it.each(['constructor', '__proto__', 'toString'])('refuses the object prototype key "%s" as a target before any request', async (target) => {
    const fetchBytes = vi.fn(async () => Buffer.alloc(0));

    await expect(fetchNode({ version: VERSION, target, binariesFolder, fetchBytes, installedVersion: neverInstalled })).rejects.toThrow(/is not supported/);

    expect(fetchBytes).not.toHaveBeenCalled();
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
      expect(readFileSync(`${x64Binary()}.sha256`, 'utf8')).toBe(`tarball ${sha256(tarball)}\nbinary ${sha256(Buffer.from(FAKE_NODE_BODY))}\nversion ${VERSION}\ntarget ${X64_TARGET}\n`);
      expect(statSync(x64Binary()).mode & 0o777).toBe(0o755);
    });

    it('refuses the darwin-x64 tarball when its checksum differs from the published one', async () => {
      const tarball = buildTarball('darwin-x64');
      const shasums = `${'d'.repeat(64)}  ${X64_TARBALL_NAME}\n`;
      const { fetchBytes } = serve({ tarball, shasums, tarballName: X64_TARBALL_NAME });

      await expect(fetchNode({ version: VERSION, target: X64_TARGET, binariesFolder, fetchBytes, installedVersion: neverInstalled })).rejects.toThrow(/checksum/i);

      expect(existsSync(x64Binary())).toBe(false);
    });

    it('skips offline on its own legacy record, validated by running it on an Intel host, and leaves the arm64 sidecar untouched', async () => {
      mkdirSync(binariesFolder, { recursive: true });
      writeFileSync(x64Binary(), 'existing-x64');
      writeFileSync(`${x64Binary()}.sha256`, `tarball ${'c'.repeat(64)}\nbinary ${sha256(Buffer.from('existing-x64'))}\n`);
      const fetchBytes = vi.fn(async () => {
        throw new Error('offline');
      });

      const result = await fetchNode({ version: VERSION, target: X64_TARGET, binariesFolder, fetchBytes, installedVersion: () => `v${VERSION}`, hostTarget: X64_TARGET });

      expect(result).toEqual({ status: 'skipped', path: x64Binary() });
      expect(fetchBytes).not.toHaveBeenCalled();
      expect(existsSync(installedBinary())).toBe(false);
    });
  });

  describe('never executes the cached binary before its integrity is checked', () => {
    const executionMarker = () => join(workFolder, 'cached-binary-executed');
    const offline = vi.fn(async () => {
      throw new Error('offline');
    });
    const installMarkerWritingBinary = (record?: string) => {
      mkdirSync(binariesFolder, { recursive: true });
      writeFileSync(installedBinary(), `#!/bin/sh\necho executed > '${executionMarker()}'\necho v${VERSION}\n`, { mode: 0o755 });
      if (record !== undefined) writeFileSync(checksumRecord(), record);
    };

    it('does not run a cached binary whose hash differs from the recorded one, and goes back to the download', async () => {
      installMarkerWritingBinary(`binary ${'0'.repeat(64)}\n`);

      await expect(fetchNode({ version: VERSION, binariesFolder, fetchBytes: offline })).rejects.toThrow('offline');

      expect(existsSync(executionMarker())).toBe(false);
      expect(offline).toHaveBeenCalled();
    });

    it('does not run a cached binary that has no checksum record', async () => {
      installMarkerWritingBinary();

      await expect(fetchNode({ version: VERSION, binariesFolder, fetchBytes: offline })).rejects.toThrow('offline');

      expect(existsSync(executionMarker())).toBe(false);
    });
  });

  describe('offline skip of a cache recorded with its validated version and target', () => {
    const APPLE_SILICON = 'aarch64-apple-darwin';
    const INTEL = 'x86_64-apple-darwin';
    const intelBinary = () => join(binariesFolder, `node-${INTEL}`);
    const offline = () => vi.fn(async () => {
      throw new Error('offline');
    });
    const installIntelCache = ({ recordedBody = 'intel-node', recordedVersion = VERSION, recordedTarget = INTEL }: { recordedBody?: string; recordedVersion?: string; recordedTarget?: string } = {}) => {
      mkdirSync(binariesFolder, { recursive: true });
      writeFileSync(intelBinary(), 'intel-node');
      writeFileSync(`${intelBinary()}.sha256`, `tarball ${'c'.repeat(64)}\nbinary ${sha256(Buffer.from(recordedBody))}\nversion ${recordedVersion}\ntarget ${recordedTarget}\n`);
    };

    it('skips an Intel cache on an Apple Silicon host without executing it, when digest, version and target match', async () => {
      installIntelCache();
      const fetchBytes = offline();
      const installedVersion = vi.fn(() => undefined);

      const result = await fetchNode({ version: VERSION, target: INTEL, binariesFolder, fetchBytes, installedVersion, hostTarget: APPLE_SILICON });

      expect(result).toEqual({ status: 'skipped', path: intelBinary() });
      expect(fetchBytes).not.toHaveBeenCalled();
      expect(installedVersion).not.toHaveBeenCalled();
    });

    it('still refuses the cache when its digest differs from the recorded one', async () => {
      installIntelCache({ recordedBody: 'something else' });
      const fetchBytes = offline();

      await expect(fetchNode({ version: VERSION, target: INTEL, binariesFolder, fetchBytes, installedVersion: () => undefined, hostTarget: APPLE_SILICON })).rejects.toThrow('offline');

      expect(fetchBytes).toHaveBeenCalled();
    });

    it.each([
      ['another version', { recordedVersion: '25.0.0' }],
      ['another target', { recordedTarget: APPLE_SILICON }],
    ])('downloads again when the record was validated for %s', async (_name, recordOptions) => {
      installIntelCache(recordOptions);
      const fetchBytes = offline();

      await expect(fetchNode({ version: VERSION, target: INTEL, binariesFolder, fetchBytes, installedVersion: () => `v${VERSION}`, hostTarget: APPLE_SILICON })).rejects.toThrow('offline');

      expect(fetchBytes).toHaveBeenCalled();
    });

    it('does not execute a foreign-CPU cache that carries an old record without version, and downloads again', async () => {
      mkdirSync(binariesFolder, { recursive: true });
      writeFileSync(intelBinary(), 'intel-node');
      writeFileSync(`${intelBinary()}.sha256`, `tarball ${'c'.repeat(64)}\nbinary ${sha256(Buffer.from('intel-node'))}\n`);
      const fetchBytes = offline();
      const installedVersion = vi.fn(() => `v${VERSION}`);

      await expect(fetchNode({ version: VERSION, target: INTEL, binariesFolder, fetchBytes, installedVersion, hostTarget: APPLE_SILICON })).rejects.toThrow('offline');

      expect(installedVersion).not.toHaveBeenCalled();
    });

    it('records the validated version and target next to the installed digest', async () => {
      const tarball = buildTarball('darwin-x64');
      const shasums = `${sha256(tarball)}  node-v${VERSION}-darwin-x64.tar.gz\n`;
      const { fetchBytes } = serve({ tarball, shasums, tarballName: `node-v${VERSION}-darwin-x64.tar.gz` });

      await fetchNode({ version: VERSION, target: INTEL, binariesFolder, fetchBytes, installedVersion: neverInstalled, hostTarget: APPLE_SILICON });

      expect(readFileSync(`${intelBinary()}.sha256`, 'utf8')).toBe(`tarball ${sha256(tarball)}\nbinary ${sha256(Buffer.from(FAKE_NODE_BODY))}\nversion ${VERSION}\ntarget ${INTEL}\n`);
    });
  });

  describe('refuses an extracted node that is not a regular single-link file, before any chmod or rename', () => {
    const buildTarballWithNodeSymlink = (externalFile: string): Buffer => {
      const stage = join(workFolder, 'symlink-stage');
      const packageFolder = join(stage, `node-v${VERSION}-darwin-arm64`);
      mkdirSync(join(packageFolder, 'bin'), { recursive: true });
      symlinkSync(externalFile, join(packageFolder, 'bin/node'));
      const tarball = join(workFolder, 'symlink.tar.gz');
      spawnSync('tar', ['-czf', tarball, '-C', stage, `node-v${VERSION}-darwin-arm64/bin/node`]);
      return readFileSync(tarball);
    };
    const externalFile = () => join(workFolder, 'external-node');
    const writeExternalFile = () => writeFileSync(externalFile(), '#!/bin/sh\necho v26.9.0\n', { mode: 0o600 });

    it('fails with a one-line error naming the member when it is a symlink, and leaves the external file mode alone', async () => {
      writeExternalFile();
      const tarball = buildTarballWithNodeSymlink(externalFile());
      const { fetchBytes } = serve({ tarball, shasums: shasumsFor(tarball) });

      const failure = await fetchNode({ version: VERSION, binariesFolder, fetchBytes, installedVersion: neverInstalled }).catch((error: Error) => error);

      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message.trim().split('\n')).toHaveLength(1);
      expect((failure as Error).message).toContain(`node-v${VERSION}-darwin-arm64/bin/node`);
      expect(statSync(externalFile()).mode & 0o777).toBe(0o600);
      expect(existsSync(installedBinary())).toBe(false);
      expect(leftovers()).toEqual([]);
    });

    it('fails when the member has a second hard link, and leaves the external file mode alone', async () => {
      writeExternalFile();
      const tarball = buildTarball();
      const { fetchBytes } = serve({ tarball, shasums: shasumsFor(tarball) });
      const extractBinary = ({ packageName, scratchFolder }: { packageName: string; scratchFolder: string }) => {
        mkdirSync(join(scratchFolder, packageName, 'bin'), { recursive: true });
        linkSync(externalFile(), join(scratchFolder, packageName, 'bin/node'));
        return join(scratchFolder, packageName, 'bin/node');
      };

      await expect(fetchNode({ version: VERSION, binariesFolder, fetchBytes, installedVersion: neverInstalled, extractBinary })).rejects.toThrow(`node-v${VERSION}-darwin-arm64/bin/node`);

      expect(statSync(externalFile()).mode & 0o777).toBe(0o600);
      expect(existsSync(installedBinary())).toBe(false);
    });
  });

  describe('treats a malformed record as an absent record', () => {
    const DIGEST = sha256(Buffer.from('existing'));
    const validLines = [`tarball ${'c'.repeat(64)}`, `binary ${DIGEST}`, `version ${VERSION}`, 'target aarch64-apple-darwin'];
    const malformedRecords: Array<[string, string]> = [
      ['a duplicated version line', [...validLines, 'version 25.0.0'].join('\n') + '\n'],
      ['a duplicated version replacing the target line', [validLines[0], validLines[1], 'version 25.0.0', `version ${VERSION}`].join('\n') + '\n'],
      ['a duplicated binary line', [...validLines, `binary ${DIGEST}`].join('\n') + '\n'],
      ['CRLF line endings', validLines.join('\r\n') + '\r\n'],
      ['an unknown key', [...validLines, 'extra value'].join('\n') + '\n'],
      ['an over-long line', [...validLines, `x ${'y'.repeat(600)}`].join('\n') + '\n'],
      ['a missing target line', validLines.slice(0, 3).join('\n') + '\n'],
      ['a missing tarball line', validLines.slice(1).join('\n') + '\n'],
      ['a version that is not a plain semver', [validLines[0], validLines[1], 'version v26.9.0', validLines[3]].join('\n') + '\n'],
      ['a target that is not a supported triple', [validLines[0], validLines[1], validLines[2], 'target riscv64-unknown-linux-gnu'].join('\n') + '\n'],
      ['a binary digest that is not 64 lowercase hex characters', [validLines[0], `binary ${DIGEST.toUpperCase()}`, validLines[2], validLines[3]].join('\n') + '\n'],
    ];

    it.each(malformedRecords)('downloads again for %s', async (_name, record) => {
      const tarball = buildTarball();
      mkdirSync(binariesFolder, { recursive: true });
      writeFileSync(installedBinary(), 'existing');
      writeFileSync(checksumRecord(), record);
      const { fetchBytes, requestedUrls } = serve({ tarball, shasums: shasumsFor(tarball) });

      const result = await fetchNode({ version: VERSION, binariesFolder, fetchBytes, installedVersion: () => `v${VERSION}`, hostTarget: 'aarch64-apple-darwin' });

      expect(result.status).toBe('installed');
      expect(requestedUrls.length).toBeGreaterThan(0);
    });

    it('skips for the same record when it is well formed', async () => {
      mkdirSync(binariesFolder, { recursive: true });
      writeFileSync(installedBinary(), 'existing');
      writeFileSync(checksumRecord(), validLines.join('\n') + '\n');
      const fetchBytes = vi.fn(async () => {
        throw new Error('offline');
      });

      const result = await fetchNode({ version: VERSION, binariesFolder, fetchBytes, installedVersion: neverInstalled });

      expect(result.status).toBe('skipped');
    });
  });

  describe('binds the record to the installed binary', () => {
    it('does not write the record when the installed binary cannot be verified, so a half-written install never has a matching record', async () => {
      const tarball = buildTarball();
      const { fetchBytes } = serve({ tarball, shasums: shasumsFor(tarball) });
      const extractBinary = ({ packageName, scratchFolder }: { packageName: string; scratchFolder: string }) => {
        mkdirSync(join(scratchFolder, packageName, 'bin'), { recursive: true });
        writeFileSync(join(scratchFolder, packageName, 'bin/node'), FAKE_NODE_BODY);
        return join(scratchFolder, packageName, 'bin/node');
      };
      const crashBeforeRecord = vi.fn(() => {
        throw new Error('crash after install');
      });

      await expect(fetchNode({ version: VERSION, binariesFolder, fetchBytes, installedVersion: neverInstalled, extractBinary, afterInstall: crashBeforeRecord })).rejects.toThrow('crash after install');

      expect(existsSync(checksumRecord())).toBe(false);
    });

    it('writes the record through a temporary file renamed over the destination, leaving no temporary file behind', async () => {
      const tarball = buildTarball();
      const { fetchBytes } = serve({ tarball, shasums: shasumsFor(tarball) });

      await fetchNode({ version: VERSION, binariesFolder, fetchBytes, installedVersion: neverInstalled });

      expect(leftovers()).toEqual([]);
      expect(lstatSync(checksumRecord()).isFile()).toBe(true);
    });
  });

  describe('a record symlink introduced while the download is awaited', () => {
    it('is replaced by a regular record and never followed to the external file', async () => {
      const tarball = buildTarball();
      const externalFile = join(workFolder, 'external-record');
      writeFileSync(externalFile, 'keep');
      mkdirSync(binariesFolder, { recursive: true });
      const { fetchBytes } = serve({ tarball, shasums: shasumsFor(tarball) });
      const racingFetch = async (url: string) => {
        if (url.endsWith('SHASUMS256.txt')) symlinkSync(externalFile, checksumRecord());
        return fetchBytes(url);
      };

      await fetchNode({ version: VERSION, binariesFolder, fetchBytes: racingFetch, installedVersion: neverInstalled });

      expect(readFileSync(externalFile, 'utf8')).toBe('keep');
      expect(lstatSync(checksumRecord()).isFile()).toBe(true);
      expect(readFileSync(checksumRecord(), 'utf8')).toMatch(/^tarball /);
    });
  });

  describe('executes a legacy-record binary from the bytes that were hashed', () => {
    it('runs a private copy, so replacing the cached file after the hash cannot change what runs', async () => {
      const good = `#!/bin/sh\necho v${VERSION}\n`;
      const marker = join(workFolder, 'swapped-executed');
      const bad = `#!/bin/sh\necho yes > '${marker}'\necho v${VERSION}\n`;
      mkdirSync(binariesFolder, { recursive: true });
      writeFileSync(installedBinary(), good, { mode: 0o755 });
      writeFileSync(checksumRecord(), `tarball ${'c'.repeat(64)}\nbinary ${sha256(Buffer.from(good))}\n`);
      const executedPaths: string[] = [];
      const installedVersion = (path: string) => {
        executedPaths.push(path);
        writeFileSync(installedBinary(), bad, { mode: 0o755 });
        return runInstalledVersion(path);
      };

      const result = await fetchNode({ version: VERSION, binariesFolder, fetchBytes: async () => Buffer.alloc(0), installedVersion, hostTarget: 'aarch64-apple-darwin' });

      expect(result.status).toBe('skipped');
      expect(executedPaths).toHaveLength(1);
      const [executedPath = ''] = executedPaths;
      expect(executedPath).not.toBe(installedBinary());
      expect(existsSync(marker)).toBe(false);
      expect(existsSync(executedPath)).toBe(false);
    });
  });

  describe('error messages never print the home folder', () => {
    it('shows ~ instead of $HOME when it refuses a symlink at the destination', async () => {
      vi.stubEnv('HOME', workFolder);
      mkdirSync(binariesFolder, { recursive: true });
      symlinkSync(join(workFolder, 'absent'), installedBinary());

      const failure = await fetchNode({ version: VERSION, binariesFolder, fetchBytes: async () => Buffer.alloc(0), installedVersion: neverInstalled }).catch((error: Error) => error);

      expect((failure as Error).message).not.toContain(workFolder);
      expect((failure as Error).message).toContain(`~/binaries/${BINARY_NAME} is a symlink`);
      vi.unstubAllEnvs();
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
