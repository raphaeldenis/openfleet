#!/usr/bin/env node
// Usage: node scripts/release/set-version.mjs <semver> [--root <repo dir>]
// tauri.conf.json is the single source of the app version; this script writes it and every copy of it.
//
// Deviation from the spec (§3.1): Cargo.lock is updated by editing the app crate's version entry directly instead of
// running `cargo update -p app`. It works offline and without cargo, and the result stays valid for `cargo metadata --locked --offline`.
//
// Crash window: the files are renamed into place one after the other. A SIGKILL between two renames leaves a half-bumped tree;
// running the same version again completes it (the script is idempotent). SIGINT and SIGTERM are held until the edit is done.
import { accessSync, chmodSync, constants, lstatSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*)?(?:\+[0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*)?$/;
const CARGO_MAX_NUMBER = 18446744073709551615n;
const MAX_VERSION_LENGTH = 256;

function isVersionCargoAccepts(version) {
  if (!SEMVER.test(version) || version.length > MAX_VERSION_LENGTH) return false;
  const [major, minor, patch] = version.split(/[-+]/)[0].split('.').map(BigInt);
  return [major, minor, patch].every((component) => component <= CARGO_MAX_NUMBER);
}

const TAURI_DIR = 'apps/desktop/src-tauri';
const TAURI_CONF = `${TAURI_DIR}/tauri.conf.json`;
const CARGO_TOML = `${TAURI_DIR}/Cargo.toml`;
const CARGO_LOCK = `${TAURI_DIR}/Cargo.lock`;
const PACKAGE_JSONS = ['packages/core/package.json', 'packages/shared/package.json', 'apps/desktop/package.json'];

const ALL_VERSION_FILES = [TAURI_CONF, ...PACKAGE_JSONS, CARGO_TOML, CARGO_LOCK];

const TOP_LEVEL_JSON_VERSION = /^(  "version":\s*")[^"]*(")/m;

function replaceTopLevelJsonVersion(content, version) {
  if (!TOP_LEVEL_JSON_VERSION.test(content)) return null;
  return content.replace(TOP_LEVEL_JSON_VERSION, `$1${version}$2`);
}

function replaceCargoTomlVersion(content, version) {
  const lines = content.split('\n');
  const packageHeaderIndex = lines.findIndex((line) => line.trim() === '[package]');
  if (packageHeaderIndex === -1) return null;
  const nextHeaderOffset = lines.slice(packageHeaderIndex + 1).findIndex((line) => /^\s*\[/.test(line));
  const packageEnd = nextHeaderOffset === -1 ? lines.length : packageHeaderIndex + 1 + nextHeaderOffset;
  const versionIndex = lines.findIndex((line, index) => index > packageHeaderIndex && index < packageEnd && /^version\s*=/.test(line));
  if (versionIndex === -1) return null;
  const quotedVersion = /^(version\s*=\s*")[^"]*(")/;
  if (!quotedVersion.test(lines[versionIndex])) return null;
  lines[versionIndex] = lines[versionIndex].replace(quotedVersion, `$1${version}$2`);
  return lines.join('\n');
}

function crateNameOf(cargoToml) {
  return /^\[package\][^[]*?^name\s*=\s*"([^"]+)"/ms.exec(cargoToml)?.[1] ?? null;
}

function replaceCargoLockVersion(content, crateName, version) {
  const crateEntry = new RegExp(`(\\[\\[package\\]\\]\\nname = "${crateName}"\\nversion = ")[^"]*(")`);
  if (!crateEntry.test(content)) return null;
  return content.replace(crateEntry, `$1${version}$2`);
}

/** Computes every edit in memory; returns the edits or the reason none can be made. */
function planEdits({ root, version }) {
  const read = (relativePath) => readFileSync(join(root, relativePath), 'utf8');
  const symlinked = ALL_VERSION_FILES.find((path) => lstatSync(join(root, path), { throwIfNoEntry: false })?.isSymbolicLink());
  if (symlinked) return { error: `${symlinked} is a symlink; replace it with a regular file first` };
  const cargoToml = read(CARGO_TOML);
  const crateName = crateNameOf(cargoToml);
  if (!crateName) return { error: `${CARGO_TOML} has no [package] name` };

  const attempts = [
    ...[TAURI_CONF, ...PACKAGE_JSONS].map((path) => [path, replaceTopLevelJsonVersion(read(path), version)]),
    [CARGO_TOML, replaceCargoTomlVersion(cargoToml, version)],
    [CARGO_LOCK, replaceCargoLockVersion(read(CARGO_LOCK), crateName, version)],
  ];
  const failed = attempts.find(([, content]) => content === null);
  if (failed) return { error: `${failed[0]} has no version to replace` };
  return { edits: attempts.map(([path, content]) => ({ path, content })) };
}

const TERMINATION_SIGNALS = ['SIGINT', 'SIGTERM'];
const STALE_TEMP_FILE = /\.set-version-(\d+)\.tmp$/;

function tryQuietly(action) {
  try {
    action();
  } catch {
    // best effort: the caller already has a more useful error to report
  }
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code !== 'ESRCH';
  }
}

/** Removes the temp files that a killed run left next to the version files; best effort. */
function sweepStaleTempFiles(root) {
  for (const directory of new Set(ALL_VERSION_FILES.map((path) => dirname(join(root, path))))) {
    tryQuietly(() => {
      for (const name of readdirSync(directory)) {
        const pid = STALE_TEMP_FILE.exec(name)?.[1];
        if (pid && !isProcessAlive(Number(pid))) rmSync(join(directory, name), { force: true });
      }
    });
  }
}

/** Stages every changed file as a temp copy (same directory, same mode), then renames them all; any failure restores the originals and removes the temp files. */
function applyEdits({ root, edits }) {
  const absolute = (path) => join(root, path);
  const tempPathOf = (path) => `${absolute(path)}.set-version-${process.pid}.tmp`;
  const changed = edits
    .map((edit) => ({ ...edit, original: readFileSync(absolute(edit.path), 'utf8') }))
    .filter(({ content, original }) => content !== original);
  const staged = [];
  const renamed = [];
  sweepStaleTempFiles(root);
  const holdTerminationSignals = () => {};
  for (const signal of TERMINATION_SIGNALS) process.on(signal, holdTerminationSignals);
  try {
    for (const { path, content } of changed) {
      const mode = statSync(absolute(path)).mode & 0o777;
      accessSync(absolute(path), constants.W_OK);
      staged.push(tempPathOf(path));
      writeFileSync(tempPathOf(path), content, { mode });
      chmodSync(tempPathOf(path), mode);
    }
    for (const edit of changed) {
      renameSync(tempPathOf(edit.path), absolute(edit.path));
      renamed.push(edit);
    }
  } catch (error) {
    for (const { path, original } of renamed) tryQuietly(() => writeFileSync(absolute(path), original));
    for (const tempPath of staged) tryQuietly(() => rmSync(tempPath, { force: true }));
    throw error;
  } finally {
    for (const signal of TERMINATION_SIGNALS) process.off(signal, holdTerminationSignals);
  }
  const changedPaths = new Set(changed.map(({ path }) => path));
  return edits.map(({ path }) => `${changedPaths.has(path) ? 'updated  ' : 'unchanged'} ${path}`);
}

function parseArguments(argv) {
  const rootFlagIndex = argv.indexOf('--root');
  const hasRootFlag = rootFlagIndex !== -1;
  const defaultRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
  const rootValue = argv[rootFlagIndex + 1];
  if (hasRootFlag && !rootValue) return { error: '--root needs a directory' };
  const root = hasRootFlag ? resolve(rootValue) : defaultRoot;
  const positional = argv.filter((_, index) => !hasRootFlag || (index !== rootFlagIndex && index !== rootFlagIndex + 1));
  if (positional.length > 1) return { error: `unexpected extra argument ${JSON.stringify(positional[1])}; usage: set-version <semver> [--root <dir>]` };
  return { version: positional[0] ?? '', root };
}

function main() {
  const { version, root, error } = parseArguments(process.argv.slice(2));
  if (error) {
    console.error(`set-version: ${error}`);
    return 1;
  }
  if (!isVersionCargoAccepts(version)) {
    console.error(`set-version: "${version}" is not a valid SemVer version (expected e.g. 0.2.0 or 0.2.0-beta.1)`);
    return 1;
  }
  try {
    const plan = planEdits({ root, version });
    if (plan.error) {
      console.error(`set-version: ${plan.error}; nothing was written`);
      return 1;
    }
    const summary = applyEdits({ root, edits: plan.edits });
    console.log([`OpenFleet version set to ${version}`, ...summary].join('\n'));
    return 0;
  } catch (fileError) {
    console.error(`set-version: ${fileError.message.split('\n')[0]}; every file is left as it was`);
    return 1;
  }
}

process.exitCode = main();
