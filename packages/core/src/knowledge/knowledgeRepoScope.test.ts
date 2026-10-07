import { execFileSync } from 'node:child_process';
import { mkdirSync, realpathSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, it, vi } from 'vitest';
import { applyMigrations } from '../db/migrate.js';
import { createTempDirTracker } from '../tempDirTracker.js';
import { KnowledgeRepository } from './knowledgeRepository.js';
import { KnowledgeRepoScope } from './knowledgeRepoScope.js';

const tempDirs = createTempDirTracker();
afterEach(() => { vi.unstubAllEnvs(); tempDirs.removeAll(); });

function repositoryFixture() {
  const root = tempDirs.make('knowledge-scope-');
  const repo = join(root, 'repo');
  mkdirSync(repo);
  execFileSync('git', ['init', '-b', 'main'], { cwd: repo });
  execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '--allow-empty', '-m', 'fixture'], { cwd: repo });
  const db = new DatabaseSync(':memory:');
  applyMigrations(db);
  db.exec("INSERT INTO projects (id, name, created_at) VALUES ('p', 'Fleet', 'now'), ('other', 'Other', 'now')");
  db.prepare('INSERT INTO knowledge_repositories (project_id, repo_key, canonical_root, git_common_dir) VALUES (?, ?, ?, ?)')
    .run('p', 'fleet', realpathSync.native(repo), realpathSync.native(join(repo, '.git')));
  const scope = new KnowledgeRepoScope({ repositories: new KnowledgeRepository(db) });
  return { root, repo, db, scope };
}

it('resolves registered keys, roots, child worktrees and symlinks by common-directory identity', async () => {
  const { root, repo, db, scope } = repositoryFixture();
  try {
    const worktree = join(root, 'child');
    execFileSync('git', ['worktree', 'add', '-b', 'child', worktree], { cwd: repo });
    const alias = join(root, 'alias');
    symlinkSync(worktree, alias);
    for (const input of ['fleet', repo, worktree, alias]) expect(await scope.resolve({ projectId: 'p', repo: input })).toMatchObject({ project_id: 'p', repo_key: 'fleet', authority: 'postgres' });
    await expect(scope.resolve({ projectId: 'other', repo })).rejects.toMatchObject({ code: 'project_not_found', message: 'knowledge repository is not available in this project' });
  } finally { db.close(); }
});

it('refuses a prefixed foreign repository and a symlink pointing outside the registered repository', async () => {
  const { root, repo, db, scope } = repositoryFixture();
  try {
    const foreign = `${repo}-foreign`;
    mkdirSync(foreign);
    execFileSync('git', ['init'], { cwd: foreign });
    const alias = join(root, 'foreign-alias');
    symlinkSync(foreign, alias);
    for (const input of [foreign, alias, join(root, 'missing')]) await expect(scope.resolve({ projectId: 'p', repo: input })).rejects.toMatchObject({ code: 'project_not_found', message: 'knowledge repository is not available in this project' });
  } finally { db.close(); }
});

it('reports Git unavailable when checking a real repository path', async () => {
  const { repo, db, scope } = repositoryFixture();
  try {
    vi.stubEnv('PATH', '/nonexistent-fixture-path');
    await expect(scope.resolve({ projectId: 'p', repo })).rejects.toMatchObject({ code: 'git_unavailable' });
  } finally { db.close(); }
});
