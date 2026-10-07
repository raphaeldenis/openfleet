import type { KnowledgeFact, KnowledgeFallbackReason, KnowledgeRepositoryScope } from './knowledgeTypes.js';

export interface KnowledgeSearchPort {
  search(input: { projectId: string; repoKey: string; match: string; terms: string[]; fetchLimit: number }): {
    items: KnowledgeFact[];
    engine: 'fts5' | 'like';
    fallback: { reason: KnowledgeFallbackReason } | null;
  };
}

export interface KnowledgeRepositoryLookupPort {
  findRepository(input: { projectId: string; repoKey?: string; gitCommonDir?: string }): KnowledgeRepositoryScope | undefined;
}

export interface RepositoryScopePort {
  resolve(input: { projectId: string; repo: string }): Promise<KnowledgeRepositoryScope>;
}
