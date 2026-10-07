import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { createTempDirTracker } from '../tempDirTracker.js';
import { recentLogLines } from '../logger.js';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { applyMigrations } from '../db/migrate.js';
import { KnowledgeRepository } from './knowledgeRepository.js';
import { KnowledgeRepoScope } from './knowledgeRepoScope.js';
import { KnowledgeSearchService } from './knowledgeSearchService.js';

let db: DatabaseSync;
let service: KnowledgeSearchService;
const tempDirs = createTempDirTracker();
beforeEach(() => {
  db = new DatabaseSync(':memory:');
  applyMigrations(db);
  db.exec("INSERT INTO projects (id, name, created_at) VALUES ('p', 'Fleet', 'now'), ('other', 'Other', 'now')");
  db.exec("INSERT INTO knowledge_repositories (project_id, repo_key, canonical_root, git_common_dir) VALUES ('p', 'fleet', '/fleet', '/fleet/.git'), ('p', 'second', '/second', '/second/.git'), ('other', 'private', '/private', '/private/.git'), ('other', 'fleet', '/foreign', '/foreign/.git')");
  const repository = new KnowledgeRepository(db);
  service = new KnowledgeSearchService({ search: repository, scope: new KnowledgeRepoScope({ repositories: repository }) });
});
afterEach(() => { db.close(); tempDirs.removeAll(); });

function seed({ id = 'a', project = 'p', repo = 'fleet', fact = 'needle', area = 'architecture', retired = null, created = '2026-01-01', provenance = null }: { id?: string; project?: string; repo?: string; fact?: string; area?: string; retired?: string | null; created?: string; provenance?: string | null } = {}) {
  db.prepare('INSERT INTO knowledge (id, project_id, repo_key, area, fact, created_at, retired_at, source_task, source_kind, verified_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, project, repo, area, fact, created, retired, provenance, provenance, provenance);
}
const search = (input: unknown = { repo: 'fleet', query: 'needle' }) => service.search({ projectId: 'p', input });

it('searches active facts only in both engines and follows retirement and restoration', async () => {
  seed(); seed({ id: 'retired', retired: 'now' });
  expect((await search()).items.map((item) => item.id)).toEqual(['a']);
  db.exec("UPDATE knowledge SET retired_at = 'now' WHERE id = 'a'");
  expect((await search()).items).toEqual([]);
  db.exec("UPDATE knowledge SET retired_at = NULL WHERE id = 'a'");
  db.exec('DROP TABLE knowledge_fts');
  expect((await search()).items.map((item) => item.id)).toEqual(['a']);
});

it('binds project and repository and gives identical refusals for unknown and foreign keys', async () => {
  seed(); seed({ id: 'second', repo: 'second' }); seed({ id: 'foreign', project: 'other', repo: 'private' });
  seed({ id: 'foreign-same-key', project: 'other', repo: 'fleet' });
  expect((await search()).items.map((item) => item.id)).toEqual(['a']);
  await expect(search({ repo: 'unknown', query: 'needle' })).rejects.toMatchObject({ code: 'project_not_found', message: 'knowledge repository is not available in this project' });
  await expect(search({ repo: 'private', query: 'needle' })).rejects.toMatchObject({ code: 'project_not_found', message: 'knowledge repository is not available in this project' });
  db.exec('DROP TABLE knowledge_fts');
  expect((await search()).items.map((item) => item.id)).toEqual(['a']);
});

it('updates and deletes indexed text through fixture writes', async () => {
  seed();
  expect((await search()).returned).toBe(1);
  db.exec("UPDATE knowledge SET fact = 'different' WHERE id = 'a'");
  expect((await search()).returned).toBe(0);
  expect((await search({ repo: 'fleet', query: 'different' })).returned).toBe(1);
  db.exec("DELETE FROM knowledge WHERE id = 'a'");
  expect((await search({ repo: 'fleet', query: 'different' })).returned).toBe(0);
});

it('refreshes indexed terms when only the area changes', async () => {
  seed({ area: 'oldterm', fact: 'body' });

  db.exec("UPDATE knowledge SET area = 'newterm' WHERE id = 'a'");
  const newAreaResult = await search({ repo: 'fleet', query: 'newterm' });
  const oldAreaResult = await search({ repo: 'fleet', query: 'oldterm' });

  expect(newAreaResult.engine).toBe('fts5');
  expect(newAreaResult.items.map((item) => item.id)).toEqual(['a']);
  expect(oldAreaResult.engine).toBe('fts5');
  expect(oldAreaResult.items).toEqual([]);
});

it('treats FTS operators and quotes as literal user terms', async () => {
  seed({ id: 'literal', fact: 'needle OR missing' });
  seed({ id: 'partial', fact: 'needle' });

  const literalResult = await search({ repo: 'fleet', query: 'needle OR missing' });
  const quotedResult = await search({ repo: 'fleet', query: 'needle"' });

  expect(literalResult.items.map((item) => item.id)).toEqual(['literal']);
  expect(quotedResult.returned).toBe(2);
  expect(quotedResult.engine).toBe('fts5');
});

it('validates input without coercion and accepts limit edges and blank queries', async () => {
  for (const limit of [0, 51, 1.5, '1', null]) await expect(search({ repo: 'fleet', query: 'needle', limit })).rejects.toMatchObject({ code: 'invalid_body' });
  for (const input of [{ repo: '../fleet', query: 'x' }, { repo: 'https://host/repo', query: 'x' }, { repo: 'fleet*', query: 'x' }, { repo: 'fleet\0', query: 'x' }, { repo: 'fleet', query: 1 }, { repo: 'fleet', query: 'x', project_id: 'other' }, { repo: 'fleet', query: Array(17).fill('x').join(' ') }]) await expect(search(input)).rejects.toMatchObject({ code: 'invalid_body' });
  await expect(search({ repo: 'fleet', query: 'x'.repeat(513) })).rejects.toMatchObject({ code: 'query_too_long' });
  for (const repo of ['fleet[ab]', 'fleet\u0085']) await expect(search({ repo, query: 'needle' })).rejects.toMatchObject({ code: 'invalid_body' });
  expect(await search({ repo: 'fleet', query: '\0 \t' })).toMatchObject({ engine: 'none', returned: 0, has_more: false });
  for (const limit of [1, 50]) expect(await search({ repo: 'fleet', query: 'needle', limit })).toMatchObject({ limit });
  expect(await search({ repo: 'fleet', query: 'x'.repeat(512) })).toMatchObject({ engine: 'fts5' });
  expect(await search({ repo: 'fleet', query: Array(16).fill('x').join(' ') })).toMatchObject({ engine: 'fts5' });
  await expect(service.search({ projectId: null, input: { repo: 'fleet', query: 'needle' } })).rejects.toMatchObject({ code: 'project_not_found' });
});

it('reports no more results when exactly the requested limit exists', async () => {
  seed();
  expect(await search({ repo: 'fleet', query: 'needle', limit: 1 })).toMatchObject({ returned: 1, has_more: false, truncated: false });
});

it('fetches one extra result and orders ties by id with default and maximum limits', async () => {
  for (let index = 59; index >= 0; index--) seed({ id: `fact-${String(index).padStart(2, '0')}` });
  expect(await search()).toMatchObject({ returned: 10, limit: 10, has_more: true });
  expect((await search({ repo: 'fleet', query: 'needle', limit: 1 })).items.map((item) => item.id)).toEqual(['fact-00']);
  expect(await search({ repo: 'fleet', query: 'needle', limit: 50 })).toMatchObject({ returned: 50, has_more: true });
  db.exec('DROP TABLE knowledge_fts');
  db.exec('DROP INDEX knowledge_active_scope');
  db.exec('DROP INDEX knowledge_scope_area');
  db.exec('DROP INDEX knowledge_source_task');
  expect((await search({ repo: 'fleet', query: 'needle', limit: 1 })).items.map((item) => item.id)).toEqual(['fact-00']);
});

it('bounds serialized output and crops multibyte facts to a safe prefix', async () => {
  for (let index = 0; index < 20; index++) seed({ id: `fact-${index}`, fact: `needle ${'😀'.repeat(2048)}`, provenance: 'é'.repeat(1024) });
  const result = await search({ repo: 'fleet', query: 'needle', limit: 50 });
  expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(32768);
  expect(result).toMatchObject({ truncated: true, has_more: true });
  expect(result.items.length).toBeGreaterThan(0);
  for (const item of result.items) {
    expect(Buffer.byteLength(item.fact)).toBeLessThanOrEqual(4096);
    expect(item.fact).toBe(`needle ${'😀'.repeat(1022)}`);
    expect(item.fact_truncated).toBe(true);
  }
});

it('drops even the first item when its metadata exceeds the envelope', async () => {
  seed({ provenance: 'x'.repeat(40000) });
  expect(await search()).toMatchObject({ items: [], returned: 0, truncated: true, has_more: true });
});

it('masks every field before cropping a credential that crosses the boundary', async () => {
  const secret = `sk-${'A'.repeat(40)}`;
  seed({ fact: `needle ${'x'.repeat(4080)} ${secret} tail`, area: `needle ${secret}`, provenance: `Bearer ${secret}` });
  const result = await search();
  expect(JSON.stringify(result)).not.toContain(secret);
  expect(result.items[0]).toMatchObject({ area: 'needle ***', source_task: 'Bearer ***', source_kind: 'Bearer ***', verified_by: 'Bearer ***' });
  expect(result.items[0]?.fact).toContain('***');
  expect(result.items[0]?.fact).not.toContain('sk-');
});

it('declares missing-index fallback and treats LIKE wildcards and backslashes literally', async () => {
  seed({ fact: 'needle 100% a_b c\\d' }); seed({ id: 'wildcard', fact: 'needle 1000 axb cd' });
  db.exec('DROP TABLE knowledge_fts');
  const result = await search({ repo: 'fleet', query: '100% a_b c\\d' });
  expect(result).toMatchObject({ engine: 'like', fallback: { reason: 'fts_unavailable' } });
  expect(result.items.map((item) => item.id)).toEqual(['a']);
});

it('logs only a fixed fallback event with a count and reason', async () => {
  const fact = 'needle unknown-credential-residue';
  seed({ fact });
  db.exec('DROP TABLE knowledge_fts');
  const previousLogCount = recentLogLines().length;

  await search({ repo: 'fleet', query: fact });

  const entries = recentLogLines().slice(previousLogCount).map((line) => JSON.parse(line) as Record<string, unknown>);
  expect(entries).toHaveLength(1);
  expect(entries[0]).toMatchObject({ msg: 'knowledge.search_fallback', detail: { reason: 'fts_unavailable', returned: 1 } });
  expect(Object.keys(entries[0]!).sort()).toEqual(['detail', 'level', 'msg', 'ts']);
  expect(Object.keys(entries[0]!.detail as object).sort()).toEqual(['reason', 'returned']);
  expect(JSON.stringify(entries)).not.toContain('needle');
});

it('keeps zero hits in FTS and propagates application SQL errors', async () => {
  expect(await search()).toMatchObject({ engine: 'fts5', fallback: null, returned: 0 });
  db.exec('DROP VIEW active_knowledge');
  await expect(search()).rejects.toThrow();
});

it('classifies real FTS corruption and returns scoped active LIKE hits', async () => {
  seed(); seed({ id: 'retired', retired: 'now' }); seed({ id: 'second', repo: 'second' });
  db.enableDefensive(false);
  db.exec('DELETE FROM knowledge_fts_data WHERE id > 10');
  expect(await search()).toMatchObject({ engine: 'like', fallback: { reason: 'fts_corrupt' }, items: [{ id: 'a' }] });
});

it('propagates a real syntax fault without degrading to LIKE', async () => {
  seed();
  const repository = new KnowledgeRepository(db);
  expect(() => repository.search({ projectId: 'p', repoKey: 'fleet', match: '"', terms: ['needle'], fetchLimit: 2 })).toThrow();
});

it('propagates a real busy database without degrading to LIKE', async () => {
  const databasePath = join(tempDirs.make('knowledge-busy-'), 'fixture.db');
  const first = new DatabaseSync(databasePath);
  const second = new DatabaseSync(databasePath);
  try {
    applyMigrations(first);
    first.exec('BEGIN EXCLUSIVE');
    const repository = new KnowledgeRepository(second);
    expect(() => repository.search({ projectId: 'p', repoKey: 'fleet', match: 'needle', terms: ['needle'], fetchLimit: 2 })).toThrow(expect.objectContaining({ code: 'ERR_SQLITE_ERROR', errcode: 5 }));
  } finally {
    first.exec('ROLLBACK');
    second.close(); first.close();
  }
});

it.each([10, 266])('propagates FTS I/O error %i without LIKE retrieval or fallback logging', async (errcode) => {
  seed();
  const ioFailure = Object.assign(new Error('disk I/O error'), { code: 'ERR_SQLITE_ERROR', errcode });
  const prepareStatement = db.prepare.bind(db);
  const previousLogCount = recentLogLines().length;
  const prepareSpy = vi.spyOn(db, 'prepare').mockImplementation((sql) => {
    const statement = prepareStatement(sql);
    const isFtsRetrieval = sql.includes('FROM knowledge_fts');
    if (isFtsRetrieval) vi.spyOn(statement, 'all').mockImplementation(() => { throw ioFailure; });
    return statement;
  });

  try {
    await expect(search()).rejects.toBe(ioFailure);

    const retrievesLikeMatches = prepareSpy.mock.calls.some(([sql]) => sql.includes('area LIKE'));
    const fallbackEntries = recentLogLines().slice(previousLogCount)
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((entry) => entry.msg === 'knowledge.search_fallback');
    expect(retrievesLikeMatches).toBe(false);
    expect(fallbackEntries).toEqual([]);
  } finally {
    vi.restoreAllMocks();
  }
});

it('orders weighted area matches before fact matches and newer dates before id ties', async () => {
  seed({ id: 'fact', area: 'other', fact: 'needle' });
  seed({ id: 'area', area: 'needle', fact: 'other' });
  expect((await search()).items.map((item) => item.id)).toEqual(['area', 'fact']);
  db.exec("UPDATE knowledge SET area = 'same', fact = 'needle'");
  db.exec("UPDATE knowledge SET created_at = '2026-02-01' WHERE id = 'fact'");
  expect((await search()).items.map((item) => item.id)).toEqual(['fact', 'area']);
});
