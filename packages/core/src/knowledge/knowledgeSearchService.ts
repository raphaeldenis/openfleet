import { isAbsolute } from 'node:path';
import { OpenFleetError } from '@openfleet/shared';
import { buildFtsQuery, MAX_QUERY_CHARS } from '../notes/ftsQuery.js';
import { maskedSecrets } from '../redact.js';
import type { KnowledgeSearchPort, RepositoryScopePort } from './knowledgeSearchPort.js';
import type { KnowledgeFact, KnowledgeSearchResult } from './knowledgeTypes.js';

const FACT_BYTE_LIMIT = 4096;
const ENVELOPE_BYTE_LIMIT = 32768;

function validatedInput(input: unknown): { repo: string; query: string; limit: number } {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) throw new OpenFleetError('invalid_body', 'invalid knowledge search input');
  const fields = input as Record<string, unknown>;
  const hasUnknownField = Object.keys(fields).some((key) => !['repo', 'query', 'limit'].includes(key));
  const hasRequiredStrings = typeof fields.repo === 'string' && typeof fields.query === 'string';
  if (hasUnknownField || !hasRequiredStrings) throw new OpenFleetError('invalid_body', 'invalid knowledge search input');
  const repo = (fields.repo as string).trim();
  const query = fields.query as string;
  const hasInvalidRepo = repo.length === 0 || repo.length > 4096 || /[\p{Cc}*?\[\]]/u.test(fields.repo as string);
  const isRelativePathOrUrl = !isAbsolute(repo) && /[/\\:]/.test(repo);
  if (hasInvalidRepo || isRelativePathOrUrl) throw new OpenFleetError('invalid_body', 'invalid knowledge repository');
  if (query.length > MAX_QUERY_CHARS) throw new OpenFleetError('query_too_long', 'knowledge search query exceeds 512 characters');
  const limit = fields.limit === undefined ? 10 : fields.limit;
  const isValidLimit = typeof limit === 'number' && Number.isInteger(limit) && limit >= 1 && limit <= 50;
  if (!isValidLimit) throw new OpenFleetError('invalid_body', 'knowledge search limit must be an integer between 1 and 50');
  return { repo, query, limit: limit as number };
}

function unicodePrefixWithinBytes(text: string): string {
  let bytes = 0;
  let prefix = '';
  for (const character of text) {
    const characterBytes = Buffer.byteLength(character);
    if (bytes + characterBytes > FACT_BYTE_LIMIT) break;
    prefix += character;
    bytes += characterBytes;
  }
  return prefix;
}

function maskedItem(item: KnowledgeFact): KnowledgeSearchResult['items'][number] {
  const maskedFact = maskedSecrets(item.fact);
  const fact = unicodePrefixWithinBytes(maskedFact);
  const maskedNullable = (value: string | null) => value === null ? null : maskedSecrets(value);
  return {
    id: maskedSecrets(item.id), area: maskedSecrets(item.area), fact,
    source_task: maskedNullable(item.source_task), source_kind: maskedNullable(item.source_kind), verified_by: maskedNullable(item.verified_by),
    created_at: maskedSecrets(item.created_at), fact_truncated: fact !== maskedFact,
  };
}

export class KnowledgeSearchService {
  constructor(private readonly ports: { search: KnowledgeSearchPort; scope: RepositoryScopePort }) {}

  async search({ projectId, input }: { projectId: string | null | undefined; input: unknown }): Promise<KnowledgeSearchResult> {
    const { repo, query, limit } = validatedInput(input);
    if (!projectId) throw new OpenFleetError('project_not_found', 'knowledge repository is not available in this project');
    const parsedQuery = buildFtsQuery(query);
    if (parsedQuery.outcome === 'too_many_terms') throw new OpenFleetError('invalid_body', 'knowledge search query exceeds 16 terms');
    const scope = await this.ports.scope.resolve({ projectId, repo });
    const result: KnowledgeSearchResult = { repo: scope.repo_key, authority: scope.authority, engine: 'none', fallback: null, items: [], returned: 0, limit, has_more: false, truncated: false };
    if (parsedQuery.outcome === 'blank') return result;
    const terms = query.replaceAll('\0', ' ').trim().split(/\s+/);
    const found = this.ports.search.search({ projectId, repoKey: scope.repo_key, match: parsedQuery.match, terms, fetchLimit: limit + 1 });
    result.engine = found.engine;
    result.fallback = found.fallback;
    result.has_more = found.items.length > limit;
    for (const item of found.items.slice(0, limit)) {
      const candidate = maskedItem(item);
      const nextItems = [...result.items, candidate];
      const reservedEnvelope = { ...result, items: nextItems, returned: nextItems.length, truncated: false, has_more: false };
      const fitsEnvelope = Buffer.byteLength(JSON.stringify(reservedEnvelope)) <= ENVELOPE_BYTE_LIMIT;
      if (!fitsEnvelope) {
        result.truncated = true;
        result.has_more = true;
        break;
      }
      result.items = nextItems;
    }
    result.returned = result.items.length;
    return result;
  }
}
