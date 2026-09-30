#!/usr/bin/env node
// Bundles the daemon into a self-contained folder: daemon.mjs, migrations/ and node_modules/node-pty.
// Usage: node scripts/release/bundle-daemon.mjs [--target aarch64-apple-darwin|x86_64-apple-darwin] [--out <dir>] [--tauri-conf <file>]
import { chmodSync, cpSync, mkdirSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const TAURI_CONF = join(REPO_ROOT, 'apps/desktop/src-tauri/tauri.conf.json');
const DEFAULT_OUT = join(REPO_ROOT, 'apps/desktop/src-tauri/resources/daemon');
const CORE_ROOT = join(REPO_ROOT, 'packages/core');
const SPAWN_HELPER_MODE = 0o755;

const NODE_PTY_PREBUILDS_BY_TARGET = {
  'aarch64-apple-darwin': 'darwin-arm64',
  'x86_64-apple-darwin': 'darwin-x64',
};

// esbuild output is ESM, but bundled CommonJS dependencies (ws, zod, the MCP SDK) still call require().
const REQUIRE_SHIM = "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);";

class BundleError extends Error {}

const hostTarget = () => (process.arch === 'arm64' ? 'aarch64-apple-darwin' : 'x86_64-apple-darwin');

function parseArguments(argv) {
  const options = { target: hostTarget(), out: DEFAULT_OUT, tauriConf: TAURI_CONF };
  const optionNameByFlag = { '--target': 'target', '--out': 'out', '--tauri-conf': 'tauriConf' };
  for (let i = 0; i < argv.length; i += 2) {
    const optionName = optionNameByFlag[argv[i]];
    if (!optionName) throw new BundleError(`unknown argument "${argv[i]}"`);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) throw new BundleError(`${argv[i]} needs a value`);
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

function removePreviousBundle(out) {
  for (const name of ['daemon.mjs', 'migrations', 'node_modules']) rmSync(join(out, name), { recursive: true, force: true });
}

function copyNodePty({ nodePtyFolder, prebuildFolder, out }) {
  const destination = join(out, 'node_modules/node-pty');
  mkdirSync(join(destination, 'prebuilds'), { recursive: true });
  cpSync(join(nodePtyFolder, 'package.json'), join(destination, 'package.json'));
  cpSync(join(nodePtyFolder, 'lib'), join(destination, 'lib'), { recursive: true });
  cpSync(join(nodePtyFolder, 'prebuilds', prebuildFolder), join(destination, 'prebuilds', prebuildFolder), { recursive: true });
  chmodSync(join(destination, 'prebuilds', prebuildFolder, 'spawn-helper'), SPAWN_HELPER_MODE);
}

export async function bundleDaemon({ target, out, tauriConf }) {
  const prebuildFolder = NODE_PTY_PREBUILDS_BY_TARGET[target];
  if (!prebuildFolder) throw new BundleError(`unknown target "${target}", expected one of: ${Object.keys(NODE_PTY_PREBUILDS_BY_TARGET).join(', ')}`);
  const version = readVersion(tauriConf);
  const coreRequire = createRequire(join(CORE_ROOT, 'package.json'));
  const nodePtyFolder = resolveNodePtyFolder(coreRequire);
  const esbuild = await loadEsbuild(coreRequire);

  removePreviousBundle(out);
  mkdirSync(out, { recursive: true });
  await esbuild.build({
    entryPoints: [join(CORE_ROOT, 'src/main.ts')],
    outfile: join(out, 'daemon.mjs'),
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
