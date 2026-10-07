export type KnowledgeAuthority = 'postgres' | 'frozen' | 'native';
export type KnowledgeFallbackReason = 'fts_unavailable' | 'fts_corrupt';

export interface KnowledgeRepositoryScope {
  project_id: string;
  repo_key: string;
  canonical_root: string;
  git_common_dir: string;
  authority: KnowledgeAuthority;
}

export interface KnowledgeFact {
  id: string;
  area: string;
  fact: string;
  source_task: string | null;
  source_kind: string | null;
  verified_by: string | null;
  created_at: string;
}

export interface KnowledgeSearchResult {
  repo: string;
  engine: 'fts5' | 'like' | 'none';
  fallback: { reason: KnowledgeFallbackReason } | null;
  authority: KnowledgeAuthority;
  items: (KnowledgeFact & { fact_truncated: boolean })[];
  returned: number;
  limit: number;
  has_more: boolean;
  truncated: boolean;
}
