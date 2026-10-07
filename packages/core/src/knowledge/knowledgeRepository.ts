import type { DatabaseSync } from 'node:sqlite';
import { log } from '../logger.js';
import type { KnowledgeRepositoryLookupPort, KnowledgeSearchPort } from './knowledgeSearchPort.js';
import type { KnowledgeFact, KnowledgeFallbackReason, KnowledgeRepositoryScope } from './knowledgeTypes.js';

function indexFailureReason(error: unknown): KnowledgeFallbackReason | undefined {
  if (!(error instanceof Error)) return undefined;
  const sqliteError = error as Error & { code?: string; errcode?: number };
  if (sqliteError.code !== 'ERR_SQLITE_ERROR') return undefined;
  const primaryCode = (sqliteError.errcode ?? 0) & 255;
  const isMissingIndex = primaryCode === 1 && /^no such (?:table: knowledge_fts|module: fts5)$/.test(error.message);
  if (isMissingIndex) return 'fts_unavailable';
  const isIndexCorruption = primaryCode === 11 && sqliteError.errcode === 267;
  return isIndexCorruption ? 'fts_corrupt' : undefined;
}

const literalLikePattern = (term: string): string => `%${term.replace(/[\\%_]/g, '\\$&')}%`;

export class KnowledgeRepository implements KnowledgeSearchPort, KnowledgeRepositoryLookupPort {
  constructor(private readonly db: DatabaseSync) {}

  findRepository({ projectId, repoKey, gitCommonDir }: { projectId: string; repoKey?: string; gitCommonDir?: string }): KnowledgeRepositoryScope | undefined {
    const lookupColumn = repoKey === undefined ? 'git_common_dir' : 'repo_key';
    const lookupValue = repoKey ?? gitCommonDir;
    if (lookupValue === undefined) return undefined;
    return this.db.prepare(`SELECT * FROM knowledge_repositories WHERE project_id = ? AND ${lookupColumn} = ?`)
      .get(projectId, lookupValue) as KnowledgeRepositoryScope | undefined;
  }

  search(input: Parameters<KnowledgeSearchPort['search']>[0]): ReturnType<KnowledgeSearchPort['search']> {
    try {
      const items = this.searchFts(input);
      return { items, engine: 'fts5', fallback: null };
    } catch (error) {
      const reason = indexFailureReason(error);
      if (reason === undefined) throw error;
      const items = this.searchLike(input);
      log('warn', 'knowledge.search_fallback', { reason, returned: items.length });
      return { items, engine: 'like', fallback: { reason } };
    }
  }

  private searchFts({ projectId, repoKey, match, fetchLimit }: Parameters<KnowledgeSearchPort['search']>[0]): KnowledgeFact[] {
    return this.db.prepare(`SELECT a.id, a.area, a.fact, a.source_task, a.source_kind, a.verified_by, a.created_at
      FROM knowledge_fts JOIN knowledge k ON k.rowid = knowledge_fts.rowid
      JOIN active_knowledge a ON a.id = k.id
      WHERE knowledge_fts MATCH ? AND a.project_id = ? AND a.repo_key = ?
      ORDER BY bm25(knowledge_fts, 2.0, 1.0), a.created_at DESC, a.id ASC LIMIT ?`)
      .all(match, projectId, repoKey, fetchLimit) as unknown as KnowledgeFact[];
  }

  /** LIKE uses substrings and SQLite's default ASCII case folding. */
  private searchLike({ projectId, repoKey, terms, fetchLimit }: Parameters<KnowledgeSearchPort['search']>[0]): KnowledgeFact[] {
    const termConditions = terms.map(() => "(area LIKE ? ESCAPE '\\' OR fact LIKE ? ESCAPE '\\')").join(' AND ');
    const termParameters = terms.flatMap((term) => [literalLikePattern(term), literalLikePattern(term)]);
    return this.db.prepare(`SELECT id, area, fact, source_task, source_kind, verified_by, created_at
      FROM active_knowledge WHERE project_id = ? AND repo_key = ? AND ${termConditions}
      ORDER BY created_at DESC, id ASC LIMIT ?`)
      .all(projectId, repoKey, ...termParameters, fetchLimit) as unknown as KnowledgeFact[];
  }
}
