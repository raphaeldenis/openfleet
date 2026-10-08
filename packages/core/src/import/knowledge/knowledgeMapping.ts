import { realpathSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { isAbsolute, resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { run } from '../../git/worktrees.js';
import type { KnowledgeRepositoryScope } from '../../knowledge/knowledgeTypes.js';
import { childEnvironmentForGit } from '../../process/childEnvironment.js';
import { isWellFormedUnicode, KnowledgeImportError, structuralId } from './knowledgeExportSchema.js';

const mappingSchema = z.strictObject({ version: z.literal(1), repos: z.array(z.strictObject({
  source_repo: structuralId,
  project_id: structuralId,
  repo_key: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/),
  canonical_root: z.string().max(4096).refine(isAbsolute).refine(isWellFormedUnicode),
})).max(50_000) });

export interface KnowledgeMapping extends KnowledgeRepositoryScope { source_repo: string }

export async function resolveKnowledgeMapping(input: { mapping: unknown; sourceRepos: string[] }): Promise<KnowledgeMapping[]> {
  const parsed = mappingSchema.safeParse(input.mapping);
  if (!parsed.success) throw new KnowledgeImportError('INVALID_MAPPING');
  const mappings: KnowledgeMapping[] = [];
  const sourceRepos = new Set<string>();
  const targetScopes = new Set<string>();
  const gitScopes = new Set<string>();
  for (const repo of parsed.data.repos) {
    const identity = JSON.stringify([repo.project_id, repo.repo_key]);
    if (sourceRepos.has(repo.source_repo) || targetScopes.has(identity)) throw new KnowledgeImportError('INVALID_MAPPING');
    sourceRepos.add(repo.source_repo);
    targetScopes.add(identity);
    const canonical = await canonicalRepository(repo.canonical_root);
    const gitScope = JSON.stringify([repo.project_id, canonical.git_common_dir]);
    if (gitScopes.has(gitScope)) throw new KnowledgeImportError('INVALID_MAPPING');
    gitScopes.add(gitScope);
    mappings.push({ ...repo, ...canonical, authority: 'postgres' });
  }
  const coversExactSnapshot = sourceRepos.size === input.sourceRepos.length && input.sourceRepos.every((repo) => sourceRepos.has(repo));
  if (!coversExactSnapshot) throw new KnowledgeImportError('INVALID_MAPPING');
  return mappings;
}

async function canonicalRepository(path: string): Promise<Pick<KnowledgeMapping, 'canonical_root' | 'git_common_dir'>> {
  try {
    const canonicalPath = realpathSync.native(path);
    if (!statSync(canonicalPath).isDirectory()) throw new KnowledgeImportError('REPOSITORY_UNAVAILABLE');
    const options = { cwd: canonicalPath, timeoutMs: 5000, maxBufferBytes: 8192 };
    const root = await run(['rev-parse', '--show-toplevel'], options);
    const common = await run(['rev-parse', '--git-common-dir'], options);
    return { canonical_root: realpathSync.native(root.stdout.trim()), git_common_dir: realpathSync.native(resolve(canonicalPath, common.stdout.trim())) };
  } catch { throw new KnowledgeImportError('REPOSITORY_UNAVAILABLE'); }
}

export function assertMappingProjects(input: { db: DatabaseSync; mappings: KnowledgeMapping[] }): void {
  for (const mapping of input.mappings) {
    const projectExists = input.db.prepare('SELECT 1 FROM projects WHERE id = ?').get(mapping.project_id) !== undefined;
    if (!projectExists) throw new KnowledgeImportError('UNKNOWN_PROJECT');
  }
}

export function assertMappingRepositories(mappings: KnowledgeMapping[]): void {
  for (const mapping of mappings) {
    try {
      const root = realpathSync.native(mapping.canonical_root);
      const common = execFileSync('git', ['rev-parse', '--git-common-dir'], { cwd: root, encoding: 'utf8', env: childEnvironmentForGit(process.env), timeout: 5000, maxBuffer: 8192, stdio: ['ignore', 'pipe', 'pipe'] });
      const commonDirectory = realpathSync.native(resolve(root, common.trim()));
      const mappingStillMatches = root === mapping.canonical_root && commonDirectory === mapping.git_common_dir;
      if (!mappingStillMatches) throw new KnowledgeImportError('REPOSITORY_UNAVAILABLE');
    } catch { throw new KnowledgeImportError('REPOSITORY_UNAVAILABLE'); }
  }
}

export function mappingIdentity(mapping: KnowledgeMapping): string[] {
  return [mapping.source_repo, mapping.project_id, mapping.repo_key, mapping.canonical_root, mapping.git_common_dir];
}
