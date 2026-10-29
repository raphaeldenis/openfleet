import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, join, sep } from 'node:path';
import { OpenFleetError, type DetectedCommand, type DetectedCommandKind, type DetectedRepository } from '@openfleet/shared';

export const MAX_MANIFEST_BYTES = 256 * 1024;
const MAX_GIT_HEAD_BYTES = 1024;

type Commands = DetectedRepository['commands'];
type ManifestSource = DetectedCommand['source'];

const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9:_.-]*$/;
const MAKE_TARGET_LINE = /^([A-Za-z0-9][A-Za-z0-9_.-]*):(?!=)/;
const PYPROJECT_TOOL_SECTION = /^\[tool\.([A-Za-z0-9_-]+)/;
const GIT_HEAD_BRANCH = /^ref: refs\/heads\/([A-Za-z0-9._/-]{1,100})\s*$/;

/** The script or target names that stand for each kind of command, most specific first. */
const NAMES_BY_KIND: Record<Exclude<DetectedCommandKind, 'install'>, readonly string[]> = {
  test: ['test'],
  lint: ['lint'],
  typecheck: ['typecheck', 'type-check', 'type:check'],
  build: ['build'],
  dev: ['dev', 'start'],
};
const KINDS_WITH_NAMES = Object.keys(NAMES_BY_KIND) as (keyof typeof NAMES_BY_KIND)[];

const LOCKFILE_PACKAGE_MANAGERS = [
  { lockfile: 'pnpm-lock.yaml', packageManager: 'pnpm' },
  { lockfile: 'yarn.lock', packageManager: 'yarn' },
  { lockfile: 'package-lock.json', packageManager: 'npm' },
  { lockfile: 'bun.lock', packageManager: 'bun' },
  { lockfile: 'bun.lockb', packageManager: 'bun' },
] as const;

const STACK_HINTS_BY_DEPENDENCY = [
  { dependency: 'typescript', hint: 'typescript' },
  { dependency: 'vue', hint: 'vue' },
  { dependency: 'react', hint: 'react' },
  { dependency: 'svelte', hint: 'svelte' },
  { dependency: 'vitest', hint: 'vitest' },
  { dependency: 'jest', hint: 'jest' },
] as const;

const PYPROJECT_COMMANDS_BY_TOOL: Record<string, { kind: DetectedCommandKind; command: string }> = {
  pytest: { kind: 'test', command: 'pytest' },
  ruff: { kind: 'lint', command: 'ruff check .' },
  mypy: { kind: 'typecheck', command: 'mypy .' },
};

const CARGO_COMMANDS: Commands = {
  test: { command: 'cargo test', source: 'Cargo.toml' },
  lint: { command: 'cargo clippy', source: 'Cargo.toml' },
  typecheck: { command: 'cargo check', source: 'Cargo.toml' },
  build: { command: 'cargo build', source: 'Cargo.toml' },
};

export interface RepositoryDetectorScope {
  /** The repository must live under one of these directories (symlinks resolved). */
  allowedRoots: readonly string[];
}

/**
 * Reads the manifests of a repository and names the commands they declare. It only reads: no command runs, no script body
 * is returned, and a manifest that is a symlink, a FIFO, oversized or malformed is ignored.
 */
export function detectRepository(repositoryPath: string, scope: RepositoryDetectorScope): DetectedRepository {
  const repository = resolveAllowedRepository(repositoryPath, scope);
  const git = detectGit(repository);
  const manifestFindings = [
    detectNodePackage(repository),
    detectMakefile(repository),
    detectPyproject(repository),
    detectCargo(repository),
  ];
  const commands = mergeFirstWins(manifestFindings.map((finding) => finding.commands));
  const stack = manifestFindings.flatMap((finding) => finding.stack);
  return { isGitRepository: git.isGitRepository, ...(git.defaultBranch && { defaultBranch: git.defaultBranch }), stack, commands };
}

function resolveAllowedRepository(repositoryPath: string, scope: RepositoryDetectorScope): string {
  const isAcceptableText = isAbsolute(repositoryPath) && !repositoryPath.includes('\0') && !repositoryPath.split(sep).includes('..');
  if (!isAcceptableText) throw new OpenFleetError('invalid_body', 'the repository path must be an absolute path without ".." segments.');

  const repository = realPathOrUndefined(repositoryPath);
  const isDirectory = repository !== undefined && lstatSync(repository).isDirectory();
  if (!isDirectory) throw new OpenFleetError('directory_missing', 'the repository path is not an existing directory.');

  const isInsideAllowedRoot = scope.allowedRoots.some((root) => isInside(repository, realPathOrUndefined(root)));
  if (!isInsideAllowedRoot) throw new OpenFleetError('directory_unreadable', 'the repository is outside the directories OpenFleet may read.');
  return repository;
}

function realPathOrUndefined(path: string): string | undefined {
  try {
    return realpathSync.native(path);
  } catch {
    return undefined;
  }
}

function isInside(path: string, root: string | undefined): boolean {
  if (root === undefined) return false;
  return path === root || path.startsWith(root.endsWith(sep) ? root : root + sep);
}

function detectGit(repository: string): { isGitRepository: boolean; defaultBranch?: string } {
  const gitEntry = statOrUndefined(join(repository, '.git'));
  if (!gitEntry) return { isGitRepository: false };
  const head = gitEntry.isDirectory() ? readManifest(join(repository, '.git', 'HEAD'), MAX_GIT_HEAD_BYTES) : undefined;
  const defaultBranch = head?.match(GIT_HEAD_BRANCH)?.[1];
  return { isGitRepository: true, ...(defaultBranch && { defaultBranch }) };
}

function statOrUndefined(path: string) {
  try {
    return lstatSync(path);
  } catch {
    return undefined;
  }
}

/** Returns the text of a regular file within the cap; a symlink, a FIFO, an oversized or unreadable file gives undefined. */
function readManifest(path: string, maxBytes = MAX_MANIFEST_BYTES): string | undefined {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stats = fstatSync(descriptor);
    const isReadable = stats.isFile() && stats.size <= maxBytes;
    return isReadable ? readFileSync(descriptor, 'utf8') : undefined;
  } catch {
    return undefined;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

interface ManifestFinding {
  commands: Commands;
  stack: string[];
}
const NOTHING_FOUND = (): ManifestFinding => ({ commands: {}, stack: [] });

function mergeFirstWins(commandSets: Commands[]): Commands {
  return Object.assign({}, ...[...commandSets].reverse()) as Commands;
}

function detectNodePackage(repository: string): ManifestFinding {
  const manifest = parseJsonObject(readManifest(join(repository, 'package.json')));
  if (!manifest) return NOTHING_FOUND();

  const packageManager = packageManagerOf(repository);
  const scripts = stringEntriesOf(manifest.scripts);
  const commands: Commands = {};
  if (packageManager) commands.install = { command: `${packageManager} install`, source: 'package.json' };
  const runner = packageManager ?? 'npm';
  for (const kind of KINDS_WITH_NAMES) {
    const scriptName = NAMES_BY_KIND[kind].find((name) => name in scripts && SAFE_NAME.test(name));
    if (!scriptName) continue;
    const isNativeTestCommand = scriptName === 'test' && runner !== 'bun';
    const command = isNativeTestCommand ? `${runner} test` : `${runner} run ${scriptName}`;
    commands[kind] = { command, source: 'package.json' };
  }
  const dependencyNames = new Set([...Object.keys(objectOf(manifest.dependencies)), ...Object.keys(objectOf(manifest.devDependencies))]);
  const stack = STACK_HINTS_BY_DEPENDENCY.filter(({ dependency }) => dependencyNames.has(dependency)).map(({ hint }) => hint);
  return { commands, stack };
}

function packageManagerOf(repository: string): string | undefined {
  const match = LOCKFILE_PACKAGE_MANAGERS.find(({ lockfile }) => statOrUndefined(join(repository, lockfile))?.isFile());
  return match?.packageManager;
}

function parseJsonObject(text: string | undefined): Record<string, unknown> | undefined {
  if (text === undefined) return undefined;
  try {
    const parsed: unknown = JSON.parse(text);
    const isPlainObject = typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed);
    return isPlainObject ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

function objectOf(value: unknown): Record<string, unknown> {
  const isPlainObject = typeof value === 'object' && value !== null && !Array.isArray(value);
  return isPlainObject ? (value as Record<string, unknown>) : {};
}

/** The entries whose value is a string: only their names matter, the values are never read further. */
function stringEntriesOf(value: unknown): Record<string, true> {
  const entries = Object.entries(objectOf(value)).filter(([, body]) => typeof body === 'string');
  return Object.fromEntries(entries.map(([name]) => [name, true as const]));
}

function detectMakefile(repository: string): ManifestFinding {
  const text = readManifest(join(repository, 'Makefile'));
  if (text === undefined) return NOTHING_FOUND();

  const targets = new Set(text.split('\n').flatMap((line) => MAKE_TARGET_LINE.exec(line)?.[1] ?? []));
  const commands: Commands = {};
  for (const kind of KINDS_WITH_NAMES) {
    const targetName = NAMES_BY_KIND[kind].find((name) => targets.has(name));
    if (targetName) commands[kind] = { command: `make ${targetName}`, source: 'Makefile' };
  }
  return { commands, stack: [] };
}

function detectPyproject(repository: string): ManifestFinding {
  const text = readManifest(join(repository, 'pyproject.toml'));
  if (text === undefined) return NOTHING_FOUND();

  const commands: Commands = {};
  for (const line of text.split('\n')) {
    const tool = PYPROJECT_TOOL_SECTION.exec(line)?.[1];
    const detected = tool === undefined ? undefined : PYPROJECT_COMMANDS_BY_TOOL[tool];
    if (detected) commands[detected.kind] = { command: detected.command, source: 'pyproject.toml' satisfies ManifestSource };
  }
  return { commands, stack: ['python'] };
}

function detectCargo(repository: string): ManifestFinding {
  const text = readManifest(join(repository, 'Cargo.toml'));
  if (text === undefined) return NOTHING_FOUND();
  return { commands: { ...CARGO_COMMANDS }, stack: ['rust'] };
}
