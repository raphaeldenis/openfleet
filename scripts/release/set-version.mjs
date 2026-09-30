#!/usr/bin/env node
// Usage: node scripts/release/set-version.mjs <semver> [--root <repo dir>]
// tauri.conf.json is the single source of the app version; this script writes it and every copy of it.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*)?(?:\+[0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*)?$/;

const TAURI_DIR = 'apps/desktop/src-tauri';
const TAURI_CONF = `${TAURI_DIR}/tauri.conf.json`;
const CARGO_TOML = `${TAURI_DIR}/Cargo.toml`;
const CARGO_LOCK = `${TAURI_DIR}/Cargo.lock`;
const PACKAGE_JSONS = ['packages/core/package.json', 'packages/shared/package.json', 'apps/desktop/package.json'];

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
  lines[versionIndex] = `version = "${version}"`;
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

function applyEdits({ root, edits }) {
  return edits.map(({ path, content }) => {
    const absolutePath = join(root, path);
    const isUnchanged = readFileSync(absolutePath, 'utf8') === content;
    if (!isUnchanged) writeFileSync(absolutePath, content);
    return `${isUnchanged ? 'unchanged' : 'updated  '} ${path}`;
  });
}

function parseArguments(argv) {
  const rootFlagIndex = argv.indexOf('--root');
  const hasRootFlag = rootFlagIndex !== -1;
  const defaultRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
  const root = hasRootFlag ? resolve(argv[rootFlagIndex + 1] ?? '') : defaultRoot;
  const positional = argv.filter((_, index) => !hasRootFlag || (index !== rootFlagIndex && index !== rootFlagIndex + 1));
  return { version: positional[0] ?? '', root };
}

function main() {
  const { version, root } = parseArguments(process.argv.slice(2));
  if (!SEMVER.test(version)) {
    console.error(`set-version: "${version}" is not a valid SemVer version (expected e.g. 0.2.0 or 0.2.0-beta.1)`);
    return 1;
  }
  const plan = planEdits({ root, version });
  if (plan.error) {
    console.error(`set-version: ${plan.error}; nothing was written`);
    return 1;
  }
  const summary = applyEdits({ root, edits: plan.edits });
  console.log([`OpenFleet version set to ${version}`, ...summary].join('\n'));
  return 0;
}

process.exitCode = main();
