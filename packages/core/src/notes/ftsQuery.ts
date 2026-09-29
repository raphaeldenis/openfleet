export const MAX_SEARCH_RESULTS = 50;
export const MAX_QUERY_CHARS = 512;
export const MAX_QUERY_TERMS = 16;

export type FtsQuery = { outcome: 'blank' } | { outcome: 'too_many_terms' } | { outcome: 'match'; match: string };

/** Splits a user query into terms (NUL counts as a separator) and wraps each as an escaped, prefix-matched FTS5 phrase. */
export function buildFtsQuery(query: string): FtsQuery {
  const terms = query.replaceAll('\0', ' ').trim().split(/\s+/).filter((term) => term !== '');
  if (terms.length === 0) return { outcome: 'blank' };
  if (terms.length > MAX_QUERY_TERMS) return { outcome: 'too_many_terms' };
  return { outcome: 'match', match: terms.map((term) => `"${term.replace(/"/g, '""')}"*`).join(' ') };
}
