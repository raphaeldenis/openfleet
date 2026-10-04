#!/usr/bin/env node
// Usage: node scripts/release/prepare.mjs <semver> [--dry-run] [--skip-checks] [--allow-non-main] [--root <repo dir>]
// Prepares a release in the working tree: bumps every version file (set-version.mjs), runs the pre-push checks, writes a release notes stub
// and prints the git commands to run by hand. It never commits, tags or pushes, and it builds nothing (see RELEASING.md for the dmg build).
// Exit codes: 0 prepared (or dry run complete), 1 refused before touching anything, 2 a step failed.
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compareVersions, groupCommits, parseSemver, renderReleaseNotes } from './release-lib.mjs';

const EXIT = { prepared: 0, refused: 1, stepFailed: 2 };
const RELEASE_BRANCH = 'main';
const TAURI_CONF = 'apps/desktop/src-tauri/tauri.conf.json';
const SCRIPT_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const SET_VERSION_SCRIPT = join(SCRIPT_DIRECTORY, 'set-version.mjs');
const USAGE = 'usage: node scripts/release/prepare.mjs <semver> [--dry-run] [--skip-checks] [--allow-non-main] [--root <repo dir>]';
const MAX_LISTED_FILES = 5;

const PRE_PUSH_CHECKS = [
  { name: 'architecture', command: 'pnpm', args: ['arch'] },
  { name: 'typecheck', command: 'pnpm', args: ['typecheck'] },
  { name: 'root tests', command: 'pnpm', args: ['test'] },
  { name: 'desktop tests', command: 'pnpm', args: ['--filter', '@openfleet/desktop', 'test'] },
];

const FLAGS = new Set(['--dry-run', '--skip-checks', '--allow-non-main']);

function parseArguments(argv) {
  const flags = new Set();
  const positional = [];
  let root = resolve(SCRIPT_DIRECTORY, '../..');
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === '--root') {
      const rootValue = argv[++index];
      if (!rootValue) return { error: `--root needs a directory; ${USAGE}` };
      root = resolve(rootValue);
    } else if (FLAGS.has(argument)) {
      flags.add(argument);
    } else if (argument.startsWith('--')) {
      return { error: `unknown flag ${argument}; ${USAGE}` };
    } else {
      positional.push(argument);
    }
  }
  if (positional.length === 0) return { error: `a version is required; ${USAGE}` };
  if (positional.length > 1) return { error: `unexpected extra argument ${JSON.stringify(positional[1])}; ${USAGE}` };
  return {
    version: positional[0],
    root,
    isDryRun: flags.has('--dry-run'),
    shouldSkipChecks: flags.has('--skip-checks'),
    allowsNonMainBranch: flags.has('--allow-non-main'),
  };
}

let cachedGitEnvironment;
/** The environment minus the GIT_DIR & co. that git exports to hooks, which would redirect every git call to another repository. */
function gitEnvironment() {
  if (!cachedGitEnvironment) {
    const localVariableNames = new Set(spawnSync('git', ['rev-parse', '--local-env-vars'], { encoding: 'utf8' }).stdout.split('\n'));
    cachedGitEnvironment = Object.fromEntries(Object.entries(process.env).filter(([name]) => !localVariableNames.has(name)));
  }
  return cachedGitEnvironment;
}

function git(root, args) {
  const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8', env: gitEnvironment() });
  return { isSuccess: result.status === 0, output: (result.stdout ?? '').trim() };
}

function readCurrentVersion(root) {
  try {
    return JSON.parse(readFileSync(join(root, TAURI_CONF), 'utf8')).version ?? null;
  } catch {
    return null;
  }
}

function listFiles(files) {
  const shown = files.slice(0, MAX_LISTED_FILES).join(', ');
  return files.length > MAX_LISTED_FILES ? `${shown}, … (${files.length} in total)` : shown;
}

/** Returns why the release cannot be prepared, with the fix, or `null` when every precondition holds. */
function findRefusal({ root, version, allowsNonMainBranch }) {
  if (!parseSemver(version)) return `"${version}" is not a valid SemVer version (expected e.g. 0.2.0 or 0.2.0-beta.1)`;

  const isInsideRepository = git(root, ['rev-parse', '--is-inside-work-tree']).isSuccess;
  if (!isInsideRepository) return `${root} is not a git repository; run this script from a clone of OpenFleet`;

  const changedFiles = git(root, ['status', '--porcelain', '--untracked-files=all']).output.split('\n').filter(Boolean);
  const isTreeDirty = changedFiles.length > 0;
  if (isTreeDirty) return `the working tree has uncommitted or untracked files (${listFiles(changedFiles)}); commit, stash or delete them, then run this again`;

  const branch = git(root, ['rev-parse', '--abbrev-ref', 'HEAD']).output;
  const isOnReleaseBranch = branch === RELEASE_BRANCH;
  if (!isOnReleaseBranch && !allowsNonMainBranch) return `releases are prepared on ${RELEASE_BRANCH} but HEAD is on "${branch}"; run: git switch ${RELEASE_BRANCH} (or pass --allow-non-main to override)`;

  const currentVersion = readCurrentVersion(root);
  if (!currentVersion || !parseSemver(currentVersion)) return `${TAURI_CONF} has no valid "version" to compare with; fix that file first`;
  const isVersionHigher = compareVersions(version, currentVersion) > 0;
  if (!isVersionHigher) return `version ${version} is not greater than the current version ${currentVersion} (${TAURI_CONF}); choose a higher one`;

  const isTagTaken = git(root, ['rev-parse', '--verify', '--quiet', `refs/tags/v${version}`]).isSuccess;
  if (isTagTaken) return `the tag v${version} already exists; if it is a leftover, delete it with: git tag -d v${version}, or choose another version`;

  return null;
}

function readCommitsSinceLastTag(root) {
  const lastTag = git(root, ['describe', '--tags', '--abbrev=0', '--match', 'v*']);
  const previousTag = lastTag.isSuccess ? lastTag.output : null;
  const range = previousTag ? `${previousTag}..HEAD` : 'HEAD';
  const log = git(root, ['log', '--no-merges', '--format=%h%x09%s', range]).output;
  const commits = log.split('\n').filter(Boolean).map((line) => {
    const [hash, ...subjectParts] = line.split('\t');
    return { hash, subject: subjectParts.join('\t') };
  });
  return { previousTag, commits };
}

function run(command, args, { cwd }) {
  return spawnSync(command, args, { cwd, stdio: 'inherit' }).status === 0;
}

function say(message) {
  console.log(`prepare: ${message}`);
}

function fail(exitCode, message) {
  console.error(`prepare: ${message}`);
  return exitCode;
}

function warnLoudly(message) {
  console.error(`\nprepare: !!! WARNING: ${message}\n`);
}

function printNextCommands({ version, branch, files }) {
  const tag = `v${version}`;
  console.log(
    [
      '',
      'prepare: done. This script never commits, tags or pushes; run these yourself.',
      '',
      '1. Commit the bump (then build and try the dmgs from this commit, see RELEASING.md):',
      `   git add ${files.join(' ')}`,
      `   git commit -m "chore(release): ${tag}"`,
      '',
      '2. Once the dmgs are built and checked, tag and push:',
      `   git tag -a ${tag} -m "OpenFleet ${tag}"`,
      `   git push origin ${branch} ${tag}`,
      '',
    ].join('\n'),
  );
}

const PREDICTED_VERSION_FILES = [
  'apps/desktop/src-tauri/tauri.conf.json',
  'packages/core/package.json',
  'packages/shared/package.json',
  'apps/desktop/package.json',
  'apps/desktop/src-tauri/Cargo.toml',
  'apps/desktop/src-tauri/Cargo.lock',
];

function main() {
  const parsed = parseArguments(process.argv.slice(2));
  if (parsed.error) return fail(EXIT.refused, parsed.error);
  const { version, root, isDryRun, shouldSkipChecks, allowsNonMainBranch } = parsed;

  const refusal = findRefusal({ root, version, allowsNonMainBranch });
  if (refusal) return fail(EXIT.refused, `refused: ${refusal}`);

  const branch = git(root, ['rev-parse', '--abbrev-ref', 'HEAD']).output;
  const isOffReleaseBranch = branch !== RELEASE_BRANCH;
  if (isOffReleaseBranch) warnLoudly(`preparing a release from "${branch}", not ${RELEASE_BRANCH}. Releases are cut from ${RELEASE_BRANCH}; make sure this is intended.`);
  const announce = (stepText) => say(isDryRun ? `[dry run, nothing changes] ${stepText}` : stepText);

  const notesFile = `release-notes-v${version}.md`;
  const { previousTag, commits } = readCommitsSinceLastTag(root);
  const notes = renderReleaseNotes({ version, date: new Date().toISOString().slice(0, 10), previousTag, groups: groupCommits(commits) });

  announce(`step 1/3: set the version to ${version} in every version file`);
  if (!isDryRun && !run(process.execPath, [SET_VERSION_SCRIPT, version, '--root', root], { cwd: root })) {
    return fail(EXIT.stepFailed, 'set-version failed; it leaves every file as it was. Fix the cause shown above, then run this again');
  }

  if (shouldSkipChecks) {
    warnLoudly('--skip-checks: architecture, typecheck and tests were NOT run for this release. The pre-push hook runs them when you push.');
  } else {
    announce(`step 2/3: run the pre-push checks (${PRE_PUSH_CHECKS.map(({ name }) => name).join(', ')})`);
  }
  const checksToRun = shouldSkipChecks || isDryRun ? [] : PRE_PUSH_CHECKS;
  for (const { name, command, args } of checksToRun) {
    say(`▶ ${name}: ${command} ${args.join(' ')}`);
    if (!run(command, args, { cwd: root })) {
      const bumpedFiles = git(root, ['diff', '--name-only']).output.split('\n').filter(Boolean);
      return fail(EXIT.stepFailed, `the "${name}" check failed. Fix it and run this again after undoing the bump: git restore ${bumpedFiles.join(' ')}`);
    }
  }

  announce(`step 3/3: write the release notes stub ${notesFile} (${commits.length} commits ${previousTag ? `since ${previousTag}` : 'in the whole history'})`);
  if (isDryRun) {
    console.log(`\n${notes}`);
  } else {
    writeFileSync(join(root, notesFile), notes);
  }

  const bumpedFiles = isDryRun ? PREDICTED_VERSION_FILES : git(root, ['diff', '--name-only']).output.split('\n').filter(Boolean);
  printNextCommands({ version, branch, files: bumpedFiles });
  return EXIT.prepared;
}

process.exitCode = main();
