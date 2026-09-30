#!/usr/bin/env node
// Downloads the official Node binary the packaged app runs the daemon with, verifies it against nodejs.org's SHASUMS256.txt,
// and installs bin/node as the Tauri sidecar apps/desktop/src-tauri/binaries/node-<target>.
// Usage: node scripts/release/fetch-node.mjs [<version>] [<target>]   (defaults: node-version.txt, aarch64-apple-darwin)
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_FOLDER = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(SCRIPT_FOLDER, '..', '..');
const DEFAULT_BINARIES_FOLDER = join(REPO_ROOT, 'apps/desktop/src-tauri/binaries');
const DEFAULT_TARGET = 'aarch64-apple-darwin';
const NODE_PLATFORM_BY_TARGET = { 'aarch64-apple-darwin': 'darwin-arm64' };
const PLAIN_SEMVER = /^\d+\.\d+\.\d+$/;
const EXECUTABLE_MODE = 0o755;

class FetchNodeError extends Error {}

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

const readPinnedVersion = () => readFileSync(join(SCRIPT_FOLDER, 'node-version.txt'), 'utf8').trim();

export const runInstalledVersion = (binaryPath) => {
  const result = spawnSync(binaryPath, ['--version'], { encoding: 'utf8', timeout: 10_000 });
  return result.status === 0 ? result.stdout.trim() : undefined;
};

/** @returns {Promise<Uint8Array>} */
async function downloadBytes(url) {
  const response = await fetch(url);
  if (!response.ok) throw new FetchNodeError(`GET ${url} answered ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

function findPublishedChecksum({ shasums, tarballName }) {
  const line = shasums.split('\n').find((candidate) => candidate.trim().endsWith(`  ${tarballName}`));
  if (line === undefined) throw new FetchNodeError(`SHASUMS256.txt does not list ${tarballName}`);
  return line.trim().split(/\s+/)[0];
}

function refuseSymlink(path) {
  if (lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink()) throw new FetchNodeError(`${path} is a symlink; remove it first`);
}

export function extractNodeBinary({ tarball, packageName, scratchFolder }) {
  const tarballPath = join(scratchFolder, 'node.tar.gz');
  writeFileSync(tarballPath, tarball);
  const extraction = spawnSync('tar', ['-xzf', tarballPath, '-C', scratchFolder, `${packageName}/bin/node`]);
  if (extraction.status !== 0) throw new FetchNodeError(`could not extract ${packageName}/bin/node: ${extraction.stderr}`);
  return join(scratchFolder, packageName, 'bin/node');
}

const readRecordedChecksum = (recordPath) => {
  try {
    return readFileSync(recordPath, 'utf8').trim();
  } catch {
    return undefined;
  }
};

/** Installs the pinned Node binary as the sidecar unless the installed one reports that version and the recorded tarball sha256 is the published one. */
export async function fetchNode({ version, target = DEFAULT_TARGET, binariesFolder = DEFAULT_BINARIES_FOLDER, fetchBytes = downloadBytes, installedVersion = runInstalledVersion, extractBinary = extractNodeBinary }) {
  if (!PLAIN_SEMVER.test(version)) throw new FetchNodeError(`version "${version}" is not a plain x.y.z`);
  const nodePlatform = NODE_PLATFORM_BY_TARGET[target];
  if (nodePlatform === undefined) throw new FetchNodeError(`target "${target}" is not supported yet, expected: ${Object.keys(NODE_PLATFORM_BY_TARGET).join(', ')}`);

  const destination = join(binariesFolder, `node-${target}`);
  const checksumRecord = `${destination}.sha256`;
  refuseSymlink(destination);
  refuseSymlink(checksumRecord);
  const packageName = `node-v${version}-${nodePlatform}`;
  const tarballName = `${packageName}.tar.gz`;
  const baseUrl = `https://nodejs.org/dist/v${version}`;
  const shasums = Buffer.from(await fetchBytes(`${baseUrl}/SHASUMS256.txt`)).toString('utf8');
  const publishedChecksum = findPublishedChecksum({ shasums, tarballName });
  const isPinnedVersionInstalled = installedVersion(destination) === `v${version}`;
  const isRecordedChecksumPublished = readRecordedChecksum(checksumRecord) === publishedChecksum;
  if (isPinnedVersionInstalled && isRecordedChecksumPublished) return { status: 'skipped', path: destination };

  const tarball = Buffer.from(await fetchBytes(`${baseUrl}/${tarballName}`));
  const downloadedChecksum = sha256(tarball);
  if (downloadedChecksum !== publishedChecksum) throw new FetchNodeError(`checksum mismatch for ${tarballName}: published ${publishedChecksum}, downloaded ${downloadedChecksum}`);

  mkdirSync(binariesFolder, { recursive: true });
  const scratchFolder = mkdtempSync(join(binariesFolder, '.fetch-node-'));
  try {
    const extractedBinary = extractBinary({ tarball, packageName, scratchFolder });
    const stagedBinary = join(scratchFolder, 'staged-node');
    renameSync(extractedBinary, stagedBinary);
    chmodSync(stagedBinary, EXECUTABLE_MODE);
    refuseSymlink(destination);
    renameSync(stagedBinary, destination);
    writeFileSync(checksumRecord, `${downloadedChecksum}\n`);
  } finally {
    rmSync(scratchFolder, { recursive: true, force: true });
  }
  return { status: 'installed', path: destination };
}

async function main() {
  try {
    const [version = readPinnedVersion(), target] = process.argv.slice(2);
    const { status, path } = await fetchNode({ version, target });
    console.log(`node ${version}: ${status} ${path}`);
  } catch (error) {
    console.error(`fetch-node: ${String(error.message).split('\n')[0]}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
