import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { childEnvironmentForGit } from '../process/childEnvironment.js';
import { createTempDirTracker } from '../tempDirTracker.js';
import { createNodeGitPort } from './nodeGitPort.js';

const tempDirs = createTempDirTracker();

afterEach(() => {
  vi.unstubAllEnvs();
  tempDirs.removeAll();
});

function git(directory: string, args: string[]): string {
  const identity = ['-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'commit.gpgsign=false'];
  return execFileSync('git', [...identity, ...args], { cwd: directory, env: childEnvironmentForGit(process.env), encoding: 'utf8' });
}

function makeRepoWithCommittedFile(fileName = 'tracked.txt'): string {
  const repo = tempDirs.make('of-gitport-');
  git(repo, ['init', '-b', 'main']);
  writeFileSync(join(repo, fileName), 'one\n');
  git(repo, ['add', '--', fileName]);
  git(repo, ['commit', '-m', 'init']);
  return repo;
}

const linesOf = (output: string): string[] => output.split('\n').filter(Boolean);

describe('createNodeGitPort', () => {
  describe('in a repository with a modified tracked file and an untracked file', () => {
    it('reports both in the status and the modified one in the diff stat', () => {
      const repo = makeRepoWithCommittedFile();
      writeFileSync(join(repo, 'tracked.txt'), 'one\ntwo\n');
      writeFileSync(join(repo, 'untracked.txt'), 'new\n');
      const port = createNodeGitPort();

      const status = port.statusShort(repo);
      const diffStat = port.diffStatOf(repo);

      expect(linesOf(status)).toEqual([' M tracked.txt', '?? untracked.txt']);
      expect(diffStat).toContain('tracked.txt | 1 +');
      expect(diffStat).toContain('1 file changed, 1 insertion(+)');
    });

    it('leaves no index.lock behind', () => {
      const repo = makeRepoWithCommittedFile();
      writeFileSync(join(repo, 'tracked.txt'), 'changed\n');
      const port = createNodeGitPort();

      port.statusShort(repo);
      port.diffStatOf(repo);

      expect(existsSync(join(repo, '.git', 'index.lock'))).toBe(false);
    });
  });

  describe('in a clean repository', () => {
    it('returns empty outputs', () => {
      const repo = makeRepoWithCommittedFile();
      const port = createNodeGitPort();

      expect({ status: port.statusShort(repo), diffStat: port.diffStatOf(repo) }).toEqual({ status: '', diffStat: '' });
    });
  });

  describe('when it cannot answer', () => {
    it('throws for a directory that is not a repository', () => {
      const notARepo = tempDirs.make('of-gitport-plain-');
      const port = createNodeGitPort();

      expect(() => port.statusShort(notARepo)).toThrow();
      expect(() => port.diffStatOf(notARepo)).toThrow();
    });

    it('throws for a directory that does not exist', () => {
      const missing = join(tempDirs.make('of-gitport-missing-'), 'nope');
      const port = createNodeGitPort();

      expect(() => port.statusShort(missing)).toThrow(/does not exist/);
    });

    it('throws for a path that is a file, not a directory', () => {
      const repo = makeRepoWithCommittedFile();
      const port = createNodeGitPort();

      expect(() => port.statusShort(join(repo, 'tracked.txt'))).toThrow(/not a directory/);
    });

    it.each(['.', 'relative/dir', '', '~/repo'])('refuses the non-absolute directory %j', (directory) => {
      const port = createNodeGitPort();

      expect(() => port.statusShort(directory)).toThrow(/absolute/);
      expect(() => port.diffStatOf(directory)).toThrow(/absolute/);
    });

    it('throws when the git executable is missing', () => {
      const repo = makeRepoWithCommittedFile();
      const port = createNodeGitPort({ gitExecutable: join(repo, 'no-such-git') });

      expect(() => port.statusShort(repo)).toThrow();
    });

    it('throws within a bounded time when git exceeds the timeout', () => {
      const repo = makeRepoWithCommittedFile();
      const port = createNodeGitPort({ timeoutMs: 1 });
      const startedAt = Date.now();

      expect(() => port.statusShort(repo)).toThrow();

      expect(Date.now() - startedAt).toBeLessThan(2_000);
    });
  });

  describe('when the output exceeds the buffer cap', () => {
    it('returns only complete lines within the cap', () => {
      const repo = makeRepoWithCommittedFile();
      const untrackedNames = Array.from({ length: 200 }, (_, index) => `untracked-file-${String(index).padStart(4, '0')}.txt`);
      for (const name of untrackedNames) writeFileSync(join(repo, name), '');
      const maxBufferBytes = 1024;
      const port = createNodeGitPort({ maxBufferBytes });

      const status = port.statusShort(repo);

      const lines = linesOf(status);
      const everyLineIsComplete = lines.every((line) => /^\?\? untracked-file-\d{4}\.txt$/.test(line));
      expect({ isWithinCap: Buffer.byteLength(status) <= maxBufferBytes, hasLines: lines.length > 0, everyLineIsComplete }).toEqual({
        isWithinCap: true,
        hasLines: true,
        everyLineIsComplete: true,
      });
    });

    it('answers a default-capped status for a repository with thousands of untracked files without failing', () => {
      const repo = makeRepoWithCommittedFile();
      const manyFiles = join(repo, 'many');
      mkdirSync(manyFiles);
      for (let index = 0; index < 4000; index += 1) writeFileSync(join(manyFiles, `${'x'.repeat(60)}-${index}.txt`), '');
      const port = createNodeGitPort();

      const status = port.statusShort(repo);

      expect(status.length).toBeGreaterThan(0);
    });
  });

  describe('with hostile file names', () => {
    it('reports newline, quote, leading-dash and unicode names as single quoted lines', () => {
      const repo = makeRepoWithCommittedFile();
      const hostileNames = ['-rf.txt', 'say "hi".txt', 'line\nbreak.txt', 'héllo-ü.txt'];
      for (const name of hostileNames) writeFileSync(join(repo, name), 'x\n');
      const port = createNodeGitPort();

      const status = port.statusShort(repo);

      const lines = linesOf(status);
      expect(lines).toHaveLength(hostileNames.length);
      expect(lines).toContain('?? -rf.txt');
      expect(lines).toContain('?? "say \\"hi\\".txt"');
      expect(lines).toContain('?? "line\\nbreak.txt"');
    });

    it('keeps a modified tracked file named like an option readable in the diff stat', () => {
      const repo = makeRepoWithCommittedFile('--stat.txt');
      writeFileSync(join(repo, '--stat.txt'), 'one\ntwo\n');
      const port = createNodeGitPort();

      expect(port.diffStatOf(repo)).toContain('--stat.txt');
    });
  });

  describe('with spaces in the directory path', () => {
    it('answers for a repository under a path with spaces', () => {
      const parent = tempDirs.make('of-gitport-spaces-');
      const repo = join(parent, 'my repo dir');
      mkdirSync(repo);
      git(repo, ['init', '-b', 'main']);
      writeFileSync(join(repo, 'a b.txt'), 'x\n');
      const port = createNodeGitPort();

      expect(linesOf(port.statusShort(repo))).toEqual(['?? "a b.txt"']);
    });
  });

  describe('while an agent holds the index lock', () => {
    it('still answers status and diff stat and leaves the lock untouched', () => {
      const repo = makeRepoWithCommittedFile();
      writeFileSync(join(repo, 'tracked.txt'), 'one\ntwo\n');
      const lockPath = join(repo, '.git', 'index.lock');
      writeFileSync(lockPath, 'held by an agent');
      const port = createNodeGitPort();
      const startedAt = Date.now();

      const status = port.statusShort(repo);
      const diffStat = port.diffStatOf(repo);

      expect({
        status: linesOf(status),
        diffMentionsFile: diffStat.includes('tracked.txt'),
        lockContent: readFileSync(lockPath, 'utf8'),
        isFast: Date.now() - startedAt < 3_000,
      }).toEqual({ status: [' M tracked.txt'], diffMentionsFile: true, lockContent: 'held by an agent', isFast: true });
    });
  });

  describe('against the host environment', () => {
    it('ignores GIT_DIR and GIT_WORK_TREE exported by the caller', () => {
      const hostRepo = makeRepoWithCommittedFile('host.txt');
      writeFileSync(join(hostRepo, 'host-only.txt'), 'x\n');
      const targetRepo = makeRepoWithCommittedFile();
      vi.stubEnv('GIT_DIR', join(hostRepo, '.git'));
      vi.stubEnv('GIT_WORK_TREE', hostRepo);
      const port = createNodeGitPort();

      const status = port.statusShort(targetRepo);

      expect(status).toBe('');
    });

    it('does not run a core.fsmonitor command planted in the repository config', () => {
      const repo = makeRepoWithCommittedFile();
      const markerPath = join(repo, '..', `${repo.split('/').pop()}-fsmonitor-ran`);
      const hookPath = join(repo, '..', `${repo.split('/').pop()}-hook.sh`);
      writeFileSync(hookPath, `#!/bin/sh\ntouch '${markerPath}'\nprintf '\\0'\n`);
      chmodSync(hookPath, 0o755);
      git(repo, ['config', 'core.fsmonitor', hookPath]);
      writeFileSync(join(repo, 'untracked.txt'), 'x\n');
      const port = createNodeGitPort();

      const status = port.statusShort(repo);

      expect({ status: linesOf(status), hookRan: existsSync(markerPath) }).toEqual({ status: ['?? untracked.txt'], hookRan: false });
    });
  });
});
