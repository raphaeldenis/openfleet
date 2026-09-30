#!/usr/bin/env node
// Bundles the daemon into a self-contained folder: daemon.mjs (launcher), daemon.bundle.mjs, migrations/ and node_modules/node-pty.
// A non-empty --out is only cleared when it holds this script's .openfleet-daemon-bundle marker; an older unmarked bundle folder is refused once and must be removed by hand.
// Usage: node scripts/release/bundle-daemon.mjs [--target aarch64-apple-darwin|x86_64-apple-darwin] [--out <dir>] [--tauri-conf <file>] [--node-pty-dir <dir>]
import { chmodSync, closeSync, cpSync, existsSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SCRIPT_FOLDER = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(SCRIPT_FOLDER, '..', '..');
const TAURI_CONF = join(REPO_ROOT, 'apps/desktop/src-tauri/tauri.conf.json');
const DEFAULT_OUT = join(REPO_ROOT, 'apps/desktop/src-tauri/resources/daemon');
const CORE_ROOT = join(REPO_ROOT, 'packages/core');
const SPAWN_HELPER_MODE = 0o755;
const MACH_O_64_LITTLE_ENDIAN_MAGIC = 0xfeedfacf;
const MACH_O_HEADER_PREFIX_BYTES = 8;
const PREBUILD_BINARIES = ['pty.node', 'spawn-helper'];

const LAUNCHER_NAME = 'daemon.mjs';
const BUNDLE_NAME = 'daemon.bundle.mjs';
const MARKER_NAME = '.openfleet-daemon-bundle';
const MARKER_FORMAT_VERSION = 1;
const BUNDLE_ENTRIES = [LAUNCHER_NAME, BUNDLE_NAME, 'migrations', 'node_modules'];
const MINIMUM_NODE_MAJOR = 26;

const NODE_PTY_PREBUILDS_BY_TARGET = {
  'aarch64-apple-darwin': 'darwin-arm64',
  'x86_64-apple-darwin': 'darwin-x64',
};

const MACH_O_CPU_NAMES = { 0x0100000c: 'arm64', 0x01000007: 'x86_64' };
const CPU_NAME_BY_TARGET = { 'aarch64-apple-darwin': 'arm64', 'x86_64-apple-darwin': 'x86_64' };

// esbuild output is ESM, but bundled CommonJS dependencies (ws, zod, the MCP SDK) still call require().
const REQUIRE_SHIM = "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);";

class BundleError extends Error {}

const hostTarget = () => (process.arch === 'arm64' ? 'aarch64-apple-darwin' : 'x86_64-apple-darwin');

/** Returns the one-line refusal for a Node older than `minimumMajor`, or '' when the version is supported. Self-contained: it is embedded verbatim in the launcher. */
export function describeUnsupportedNode(nodeVersion, minimumMajor) {
  const major = Number(nodeVersion.split('.')[0]);
  const isSupported = major >= minimumMajor;
  return isSupported ? '' : `openfleet: the daemon needs Node ${minimumMajor} or newer (found ${nodeVersion})`;
}

// node:sqlite is a static import of the bundle, so the version check must run in a file that imports nothing.
const buildLauncherSource = () =>
  [
    describeUnsupportedNode.toString(),
    `const refusal = describeUnsupportedNode(process.versions.node, ${MINIMUM_NODE_MAJOR});`,
    'if (refusal) {',
    '  console.error(refusal);',
    '  process.exit(1);',
    '}',
    `await import('./${BUNDLE_NAME}');`,
    '',
  ].join('\n');

function parseArguments(argv) {
  const options = { target: hostTarget(), out: DEFAULT_OUT, tauriConf: TAURI_CONF, nodePtyDir: undefined };
  const optionNameByFlag = { '--target': 'target', '--out': 'out', '--tauri-conf': 'tauriConf', '--node-pty-dir': 'nodePtyDir' };
  const flagsAfterPnpmSeparator = argv[0] === '--' ? argv.slice(1) : argv;
  for (let i = 0; i < flagsAfterPnpmSeparator.length; i += 2) {
    const optionName = optionNameByFlag[flagsAfterPnpmSeparator[i]];
    if (!optionName) throw new BundleError(`unknown argument "${flagsAfterPnpmSeparator[i]}"`);
    const value = flagsAfterPnpmSeparator[i + 1];
    if (value === undefined || value.startsWith('--')) throw new BundleError(`${flagsAfterPnpmSeparator[i]} needs a value`);
    options[optionName] = value;
  }
  return options;
}

function readVersion(tauriConfPath) {
  const { version } = JSON.parse(readFileSync(tauriConfPath, 'utf8'));
  if (typeof version !== 'string' || version === '') throw new BundleError(`no version in ${tauriConfPath}`);
  return version;
}

function resolveNodePtyFolder(coreRequire) {
  return realpathSync(dirname(coreRequire.resolve('node-pty/package.json')));
}

async function loadEsbuild(coreRequire) {
  const module = await import(pathToFileURL(coreRequire.resolve('esbuild')).href);
  return module.default ?? module;
}

const isSameOrInside = ({ folder, candidate }) => {
  const path = relative(folder, candidate);
  const [firstSegment] = path.split(sep);
  return firstSegment !== '..' && !isAbsolute(path);
};

const realpathOrUndefined = (path) => (existsSync(path) ? realpathSync(path) : undefined);

function refuseOut(out, reason) {
  throw new BundleError(`refusing --out ${out}: ${reason}`);
}

function assertOutIsNotProtected(out, outPath) {
  const homeFolder = realpathOrUndefined(homedir());
  const isHomeFolder = homeFolder !== undefined && outPath === homeFolder;
  const holdsThisScript = isSameOrInside({ folder: outPath, candidate: realpathSync(SCRIPT_FOLDER) });
  if (isHomeFolder || holdsThisScript) refuseOut(out, 'it is the home folder, the filesystem root, or a folder that contains this repository');
}

function readMarkerEntries(out) {
  try {
    const { entries } = JSON.parse(readFileSync(join(out, MARKER_NAME), 'utf8'));
    const isKnownList = Array.isArray(entries) && entries.every((entry) => BUNDLE_ENTRIES.includes(entry));
    return isKnownList ? entries : undefined;
  } catch {
    return undefined;
  }
}

/** Deletes only the entries a previous run listed in its marker; refuses any folder that is neither empty nor marked. */
function clearPreviousBundle(out) {
  const outStat = lstatSync(out, { throwIfNoEntry: false });
  if (outStat === undefined) return;
  if (outStat.isSymbolicLink()) refuseOut(out, 'it is a symbolic link');
  if (!outStat.isDirectory()) refuseOut(out, 'it is not a folder');
  assertOutIsNotProtected(out, realpathSync(out));

  const isEmpty = readdirSync(out).length === 0;
  if (isEmpty) return;
  const previousEntries = readMarkerEntries(out);
  if (previousEntries === undefined) refuseOut(out, `it is not empty and has no ${MARKER_NAME} marker, so it was not written by this script`);
  for (const entry of previousEntries) rmSync(join(out, entry), { recursive: true, force: true });
  rmSync(join(out, MARKER_NAME), { force: true });
}

function writeMarker({ out, target }) {
  const marker = { formatVersion: MARKER_FORMAT_VERSION, target, entries: BUNDLE_ENTRIES };
  writeFileSync(join(out, MARKER_NAME), `${JSON.stringify(marker, null, 2)}\n`);
}

function describeMachOCpu(path) {
  const header = Buffer.alloc(MACH_O_HEADER_PREFIX_BYTES);
  const descriptor = openSync(path, 'r');
  try {
    readSync(descriptor, header, 0, MACH_O_HEADER_PREFIX_BYTES, 0);
  } finally {
    closeSync(descriptor);
  }
  const isThin64BitMachO = header.readUInt32LE(0) === MACH_O_64_LITTLE_ENDIAN_MAGIC;
  return isThin64BitMachO ? (MACH_O_CPU_NAMES[header.readUInt32LE(4)] ?? 'unknown') : 'not a thin 64-bit Mach-O';
}

/** Throws unless node-pty ships the prebuild folder for the target and each of its binaries is a Mach-O for the target's CPU. Runs before anything is cleared. */
function assertPrebuildMatchesTarget({ nodePtyFolder, prebuildFolder, target }) {
  const folder = join(nodePtyFolder, 'prebuilds', prebuildFolder);
  const expectedCpu = CPU_NAME_BY_TARGET[target];
  for (const binaryName of PREBUILD_BINARIES) {
    const binaryPath = join(folder, binaryName);
    const isRegularFile = statSync(binaryPath, { throwIfNoEntry: false })?.isFile() === true;
    if (!isRegularFile) throw new BundleError(`node-pty ${readNodePtyVersion(nodePtyFolder)} has no prebuilds/${prebuildFolder}/${binaryName}, required for ${target}`);
    const actualCpu = describeMachOCpu(binaryPath);
    if (actualCpu !== expectedCpu) throw new BundleError(`node-pty prebuilds/${prebuildFolder}/${binaryName} is ${actualCpu}, required ${expectedCpu} for ${target}`);
  }
}

const readNodePtyVersion = (nodePtyFolder) => JSON.parse(readFileSync(join(nodePtyFolder, 'package.json'), 'utf8')).version;

function copyNodePty({ nodePtyFolder, prebuildFolder, out }) {
  const destination = join(out, 'node_modules/node-pty');
  mkdirSync(join(destination, 'prebuilds'), { recursive: true });
  cpSync(join(nodePtyFolder, 'package.json'), join(destination, 'package.json'));
  cpSync(join(nodePtyFolder, 'lib'), join(destination, 'lib'), { recursive: true });
  cpSync(join(nodePtyFolder, 'prebuilds', prebuildFolder), join(destination, 'prebuilds', prebuildFolder), { recursive: true });
  chmodSync(join(destination, 'prebuilds', prebuildFolder, 'spawn-helper'), SPAWN_HELPER_MODE);
}

// The bundle is built in memory against a virtual outfile inside the core package, so the paths in its comments and
// inline sourcemap depend on neither the working directory nor the chosen output folder.
async function buildBundle({ esbuild, version }) {
  const { outputFiles } = await esbuild.build({
    absWorkingDir: CORE_ROOT,
    entryPoints: [join(CORE_ROOT, 'src/main.ts')],
    outfile: join(CORE_ROOT, BUNDLE_NAME),
    write: false,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node26',
    minify: false,
    sourcemap: 'inline',
    external: ['node-pty'],
    banner: { js: REQUIRE_SHIM },
    define: { __OPENFLEET_VERSION__: JSON.stringify(version) },
    logLevel: 'silent',
  });
  return outputFiles[0].contents;
}

export async function bundleDaemon({ target, out, tauriConf, nodePtyDir }) {
  const prebuildFolder = Object.hasOwn(NODE_PTY_PREBUILDS_BY_TARGET, target) ? NODE_PTY_PREBUILDS_BY_TARGET[target] : undefined;
  if (prebuildFolder === undefined) throw new BundleError(`unknown target "${target}", expected one of: ${Object.keys(NODE_PTY_PREBUILDS_BY_TARGET).join(', ')}`);
  const version = readVersion(tauriConf);
  const coreRequire = createRequire(join(CORE_ROOT, 'package.json'));
  const nodePtyFolder = nodePtyDir === undefined ? resolveNodePtyFolder(coreRequire) : realpathSync(resolve(nodePtyDir));
  assertPrebuildMatchesTarget({ nodePtyFolder, prebuildFolder, target });
  const esbuild = await loadEsbuild(coreRequire);
  const bundleContents = await buildBundle({ esbuild, version });

  clearPreviousBundle(out);
  mkdirSync(out, { recursive: true });
  writeMarker({ out, target });
  writeFileSync(join(out, BUNDLE_NAME), bundleContents);
  writeFileSync(join(out, LAUNCHER_NAME), buildLauncherSource());
  cpSync(join(CORE_ROOT, 'src/db/migrations'), join(out, 'migrations'), { recursive: true });
  copyNodePty({ nodePtyFolder, prebuildFolder, out });
  return { out, version, target };
}

async function main() {
  try {
    const { out, version, target } = await bundleDaemon(parseArguments(process.argv.slice(2)));
    console.log(`bundled daemon ${version} for ${target} into ${out}`);
  } catch (error) {
    console.error(`bundle-daemon: ${String(error.message).split('\n')[0]}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
