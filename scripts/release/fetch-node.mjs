#!/usr/bin/env node
// Downloads the official Node binary the packaged app runs the daemon with, verifies it against nodejs.org's SHASUMS256.txt,
// and installs bin/node as the Tauri sidecar apps/desktop/src-tauri/binaries/node-<target>.
// Usage: node scripts/release/fetch-node.mjs [<version>] [<target>]   (defaults: node-version.txt, aarch64-apple-darwin; or x86_64-apple-darwin)
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_FOLDER = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(SCRIPT_FOLDER, '..', '..');
const DEFAULT_BINARIES_FOLDER = join(REPO_ROOT, 'apps/desktop/src-tauri/binaries');
const DEFAULT_TARGET = 'aarch64-apple-darwin';
const NODE_PLATFORM_BY_TARGET = { 'aarch64-apple-darwin': 'darwin-arm64', 'x86_64-apple-darwin': 'darwin-x64' };
const PLAIN_SEMVER = /^\d+\.\d+\.\d+$/;
const EXECUTABLE_MODE = 0o755;
const FETCH_TIMEOUT_MS = 60_000;
const RECORD_LINE = /^(tarball|binary|version|target) (\S+)$/;

class FetchNodeError extends Error {}

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

const readPinnedVersion = () => readFileSync(join(SCRIPT_FOLDER, 'node-version.txt'), 'utf8').trim();

export const runInstalledVersion = (binaryPath) => {
  const result = spawnSync(binaryPath, ['--version'], { encoding: 'utf8', timeout: 10_000 });
  return result.status === 0 ? result.stdout.trim() : undefined;
};

/** @returns {Promise<Uint8Array>} */
export async function downloadBytes(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
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

/** @returns {{ tarball?: string, binary?: string, version?: string, target?: string }} the lines of the record; empty when it is missing or in another format. Records written before version and target were stored carry only the two checksums. */
const readChecksumRecord = (recordPath) => {
  try {
    const lines = readFileSync(recordPath, 'utf8').split('\n');
    const matches = lines.map((line) => RECORD_LINE.exec(line.trim())).filter((match) => match !== null);
    return Object.fromEntries(matches.map(([, kind, value]) => [kind, value]));
  } catch {
    return {};
  }
};

const hostTargetOf = (arch) => (arch === 'arm64' ? 'aarch64-apple-darwin' : arch === 'x64' ? 'x86_64-apple-darwin' : undefined);

/** Throws unless the extracted member is a regular file with a single link: a symlink or hardlink would make chmod and rename act on a file outside the staging folder. */
function refuseNonRegularMember({ extractedBinary, packageName }) {
  const memberStat = lstatSync(extractedBinary, { throwIfNoEntry: false });
  const isSingleLinkRegularFile = memberStat?.isFile() === true && memberStat.nlink === 1;
  if (!isSingleLinkRegularFile) throw new FetchNodeError(`${packageName}/bin/node is not a regular single-link file in the archive`);
}

const sha256OfFile = (path) => {
  try {
    return sha256(readFileSync(path));
  } catch {
    return undefined;
  }
};

/**
 * True when the binary hashes to the sha256 recorded at its verified install and was validated for this version and target; needs no network.
 * The binary is hashed first and executed only when the record predates version and target, and only on a host CPU that can run it.
 */
const isInstalledBinaryTheRecordedOne = ({ destination, checksumRecord, version, target, installedVersion, hostTarget }) => {
  const { binary: recordedBinaryChecksum, version: recordedVersion, target: recordedTarget } = readChecksumRecord(checksumRecord);
  const isHashingToTheRecordedBinary = recordedBinaryChecksum !== undefined && sha256OfFile(destination) === recordedBinaryChecksum;
  if (!isHashingToTheRecordedBinary) return false;

  const hasValidatedVersionAndTarget = recordedVersion !== undefined && recordedTarget !== undefined;
  if (hasValidatedVersionAndTarget) return recordedVersion === version && recordedTarget === target;

  const canHostExecuteTarget = hostTarget === target;
  return canHostExecuteTarget && installedVersion(destination) === `v${version}`;
};

/** Installs the pinned Node binary as the sidecar unless the installed one hashes to the binary sha256 recorded at its verified install, for this version and target. */
export async function fetchNode({ version, target = DEFAULT_TARGET, binariesFolder = DEFAULT_BINARIES_FOLDER, fetchBytes = downloadBytes, installedVersion = runInstalledVersion, extractBinary = extractNodeBinary, hostTarget = hostTargetOf(process.arch) }) {
  if (!PLAIN_SEMVER.test(version)) throw new FetchNodeError(`version "${version}" is not a plain x.y.z`);
  const nodePlatform = Object.hasOwn(NODE_PLATFORM_BY_TARGET, target) ? NODE_PLATFORM_BY_TARGET[target] : undefined;
  if (nodePlatform === undefined) throw new FetchNodeError(`target "${target}" is not supported, expected: ${Object.keys(NODE_PLATFORM_BY_TARGET).join(' or ')}`);

  const destination = join(binariesFolder, `node-${target}`);
  const checksumRecord = `${destination}.sha256`;
  refuseSymlink(destination);
  refuseSymlink(checksumRecord);
  if (isInstalledBinaryTheRecordedOne({ destination, checksumRecord, version, target, installedVersion, hostTarget })) return { status: 'skipped', path: destination };

  const packageName = `node-v${version}-${nodePlatform}`;
  const tarballName = `${packageName}.tar.gz`;
  const baseUrl = `https://nodejs.org/dist/v${version}`;
  const shasums = Buffer.from(await fetchBytes(`${baseUrl}/SHASUMS256.txt`)).toString('utf8');
  const publishedChecksum = findPublishedChecksum({ shasums, tarballName });
  const tarball = Buffer.from(await fetchBytes(`${baseUrl}/${tarballName}`));
  const downloadedChecksum = sha256(tarball);
  if (downloadedChecksum !== publishedChecksum) throw new FetchNodeError(`checksum mismatch for ${tarballName}: published ${publishedChecksum}, downloaded ${downloadedChecksum}`);

  mkdirSync(binariesFolder, { recursive: true });
  const scratchFolder = mkdtempSync(join(binariesFolder, '.fetch-node-'));
  try {
    const extractedBinary = extractBinary({ tarball, packageName, scratchFolder });
    refuseNonRegularMember({ extractedBinary, packageName });
    const stagedBinary = join(scratchFolder, 'staged-node');
    renameSync(extractedBinary, stagedBinary);
    chmodSync(stagedBinary, EXECUTABLE_MODE);
    refuseSymlink(destination);
    renameSync(stagedBinary, destination);
    writeFileSync(checksumRecord, `tarball ${downloadedChecksum}\nbinary ${sha256OfFile(destination)}\nversion ${version}\ntarget ${target}\n`);
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
