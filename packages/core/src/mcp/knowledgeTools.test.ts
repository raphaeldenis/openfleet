import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { recentLogLines } from '../logger.js';
import { startKnowledgeFixture } from './knowledgeTools.testkit.js';
import { createWorktree } from '../git/worktrees.js';
import { symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

let fixture: Awaited<ReturnType<typeof startKnowledgeFixture>>;
beforeEach(async () => { fixture = await startKnowledgeFixture(); });
afterEach(async () => { vi.restoreAllMocks(); await fixture?.close(); });

it('searches with genuine child and manager tokens using the registered project, even from a scratch directory', async () => {
  fixture.seed();
  fixture.seed({ id: 'second', repo: 'second' });
  fixture.seed({ id: 'foreign', project: 'other' });
  for (const client of [fixture.childClient, fixture.managerClient]) {
    const result = await fixture.call({ repo: ' fleet ', query: 'needle' }, client);
    expect(result.isError).toBe(false);
    expect(result.json).toMatchObject({ repo: 'fleet', engine: 'fts5', fallback: null, authority: 'postgres', returned: 1, limit: 10, has_more: false, truncated: false });
    expect(result.json?.items.map(item => item.id)).toEqual(['active']);
  }
  expect((await fixture.call({ repo: fixture.root, query: 'needle' })).json?.repo).toBe('fleet');
});

it('resolves registered worktrees and symlinks by common-directory identity without a path-prefix shortcut', async () => {
  fixture.seed();
  const worktree = await createWorktree({ repoPath: fixture.root, branchName: 'knowledge-reader', worktreesRoot: join(fixture.home, 'worktrees') });
  const link = join(fixture.home, 'linked-repo');
  symlinkSync(fixture.root, link);
  for (const repo of [worktree.path, link]) {
    const result = await fixture.call({ repo, query: 'needle' });
    expect(result.json).toMatchObject({ repo: 'fleet', items: [{ id: 'active' }] });
  }
  const missingPath = await fixture.call({ repo: `${fixture.root}-unregistered`, query: 'needle' });
  expect(missingPath.text).toBe('error project_not_found: knowledge repository is not available in this project (retry: never)');
});

it.each([
  [{ repo: 5, query: 'needle' }, 'invalid_body'],
  [{ query: 'needle' }, 'invalid_body'],
  [{ repo: 'fleet' }, 'invalid_body'],
  [{ repo: ' ', query: 'needle' }, 'invalid_body'],
  [{ repo: 'x'.repeat(4097), query: 'needle' }, 'invalid_body'],
  [{ repo: 'fleet\0', query: 'needle' }, 'invalid_body'],
  [{ repo: 'fleet\u0085', query: 'needle' }, 'invalid_body'],
  [{ repo: '../fleet', query: 'needle' }, 'invalid_body'],
  [{ repo: 'https://example.com/repo', query: 'needle' }, 'invalid_body'],
  [{ repo: 'fleet*', query: 'needle' }, 'invalid_body'],
  [{ repo: 'fleet', query: 1 }, 'invalid_body'],
  [{ repo: 'fleet', query: 'x'.repeat(513) }, 'query_too_long'],
  [{ repo: 'fleet', query: Array(17).fill('x').join(' ') }, 'invalid_body'],
  ...[0, 51, 1.5, NaN, '10', null].map((limit): [Record<string, unknown>, string] => [{ repo: 'fleet', query: 'needle', limit }, 'invalid_body']),
  ...['project_id', 'caller', 'role', 'write', 'sql', 'where'].map((key): [Record<string, unknown>, string] => [{ repo: 'fleet', query: 'needle', [key]: 'other' }, 'invalid_body']),
])('answers invalid input %# in the one-line application grammar', async (input, code) => {
  const result = await fixture.call(input as Record<string, unknown>);
  expect(result.isError).toBe(true);
  expect(result.text).toMatch(new RegExp(`^error ${code}: [^\\n]+ \\(retry: never\\)$`));
});

it('reports blank queries without searching and accepts inclusive limit edges', async () => {
  fixture.seed();
  expect((await fixture.call({ repo: 'fleet', query: ' \t\0' })).json).toMatchObject({ engine: 'none', fallback: null, items: [], returned: 0, has_more: false });
  for (const limit of [1, 50]) expect((await fixture.call({ repo: 'fleet', query: 'needle', limit })).json).toMatchObject({ limit, returned: 1, has_more: false });
});

it('excludes retired facts and discloses FTS and forced LIKE without logging text', async () => {
  fixture.seed({ fact: 'needle unknown-credential-residue' });
  fixture.seed({ id: 'retired', fact: 'needle unknown-credential-residue', retired: 'now' });
  fixture.seed({ id: 'second', repo: 'second', fact: 'needle unknown-credential-residue' });
  fixture.seed({ id: 'foreign', project: 'other', fact: 'needle unknown-credential-residue' });
  expect((await fixture.call()).json?.items.map(item => item.id)).toEqual(['active']);
  expect((await fixture.call({ repo: 'fleet', query: 'absent' })).json).toMatchObject({ engine: 'fts5', fallback: null, returned: 0 });
  fixture.db.exec('DROP TABLE knowledge_fts');
  const previousLogs = recentLogLines().length;
  const result = await fixture.call({ repo: 'fleet', query: 'needle unknown-credential-residue' });
  expect(result.json).toMatchObject({ engine: 'like', fallback: { reason: 'fts_unavailable' }, items: [{ id: 'active' }] });
  const logs = recentLogLines().slice(previousLogs);
  expect(logs.join('')).not.toMatch(/needle|unknown-credential-residue/);
  const fallback = logs.map(line => JSON.parse(line) as Record<string, unknown>).find(line => line.msg === 'knowledge.search_fallback');
  expect(fallback?.detail).toEqual({ reason: 'fts_unavailable', returned: 1 });
});

it('discloses real index corruption through MCP and preserves scoped active hits', async () => {
  fixture.seed(); fixture.seed({ id: 'retired', retired: 'now' }); fixture.seed({ id: 'second', repo: 'second' });
  fixture.db.enableDefensive(false);
  fixture.db.exec('DELETE FROM knowledge_fts_data WHERE id > 10');
  expect((await fixture.call()).json).toMatchObject({ engine: 'like', fallback: { reason: 'fts_corrupt' }, items: [{ id: 'active' }] });
});

it('refuses an unrelated database failure instead of returning successful LIKE results or raw SQL', async () => {
  fixture.seed();
  fixture.db.exec('DROP VIEW active_knowledge');
  const result = await fixture.call();
  expect(result.isError).toBe(true);
  expect(result.text).toMatch(/^error internal_error: .*\(retry: later, ref [0-9a-f]{8}\)$/);
  expect(result.text).not.toMatch(/SELECT|active_knowledge|SQLITE/);
});

it('refuses malformed FTS application SQL while the LIKE source remains available', async () => {
  fixture.seed();
  fixture.db.exec('DROP TABLE knowledge_fts; CREATE TABLE knowledge_fts (area TEXT, fact TEXT); INSERT INTO knowledge_fts (rowid, area, fact) SELECT rowid, area, fact FROM knowledge');
  const result = await fixture.call();
  expect(result.isError).toBe(true);
  expect(result.text).toMatch(/^error internal_error:/);
});

it('refuses a real busy database during FTS retrieval without successful LIKE fallback', async () => {
  fixture.seed();
  fixture.db.exec('PRAGMA journal_mode = DELETE; PRAGMA busy_timeout = 0');
  const blocker = new DatabaseSync(join(fixture.home, 'openfleet.db'));
  const prepareStatement = fixture.db.prepare.bind(fixture.db);
  const previousLogs = recentLogLines().length;
  vi.spyOn(fixture.db, 'prepare').mockImplementation(sql => {
    const isFtsRetrieval = sql.includes('FROM knowledge_fts');
    if (isFtsRetrieval) blocker.exec('BEGIN EXCLUSIVE');
    return prepareStatement(sql);
  });
  try {
    const result = await fixture.call();
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/^error (db_stuck|internal_error):/);
    expect(recentLogLines().slice(previousLogs).join('')).not.toContain('knowledge.search_fallback');
  } finally {
    vi.restoreAllMocks();
    blocker.exec('ROLLBACK');
    blocker.close();
  }
});

it.each([10, 266])('refuses injected FTS I/O failure %i through the real MCP transport', async errcode => {
  fixture.seed();
  const prepareStatement = fixture.db.prepare.bind(fixture.db);
  const previousLogs = recentLogLines().length;
  vi.spyOn(fixture.db, 'prepare').mockImplementation(sql => {
    const statement = prepareStatement(sql);
    const isFtsRetrieval = sql.includes('FROM knowledge_fts');
    if (isFtsRetrieval) vi.spyOn(statement, 'all').mockImplementation(() => { throw Object.assign(new Error('disk I/O error'), { code: 'ERR_SQLITE_ERROR', errcode }); });
    return statement;
  });
  const result = await fixture.call();
  expect(result.isError).toBe(true);
  expect(result.text).toMatch(/^error (db_stuck|internal_error):/);
  expect(recentLogLines().slice(previousLogs).join('')).not.toContain('knowledge.search_fallback');
});

it('advertises input bounds while keeping invalid calls in the handler grammar', async () => {
  const tool = (await fixture.childClient.listTools()).tools.find(tool => tool.name === 'search_knowledge');
  expect(tool?.inputSchema).toMatchObject({
    type: 'object', required: ['repo', 'query'], additionalProperties: false,
    properties: { repo: { type: 'string', minLength: 1, maxLength: 4096 }, query: { type: 'string', maxLength: 512 }, limit: { type: 'integer', minimum: 1, maximum: 50, default: 10 } },
  });
});

it('masks provider, Bearer and cookie secrets in every field before serializing and cropping', async () => {
  const provider = `sk-${'A'.repeat(40)}`;
  const bearer = 'Bearer abcdefghijklmnopqrstuvwxyz123456';
  const cookie = 'Cookie: session=abcdefghijklmnopqrstuvwxyz123456';
  const secrets = `${provider} ${bearer} ${cookie}`;
  fixture.seed({ id: `id-${provider}`, fact: `needle ${'x'.repeat(4080)} ${secrets}`, area: `needle ${secrets}`, provenance: secrets });
  fixture.db.prepare('UPDATE knowledge SET created_at = ?').run(secrets);
  const previousLogs = recentLogLines().length;
  const result = await fixture.call();
  expect(result.json?.returned).toBe(1);
  for (const secret of [provider, 'abcdefghijklmnopqrstuvwxyz123456']) {
    expect(result.text).not.toContain(secret);
    expect(recentLogLines().slice(previousLogs).join('')).not.toContain(secret);
  }
  expect(result.json?.items[0]?.fact).toContain('***');
});

it('fetches an extra hit with deterministic order and truthful default and maximum limits', async () => {
  for (let index = 59; index >= 0; index--) fixture.seed({ id: `fact-${String(index).padStart(2, '0')}` });
  expect((await fixture.call()).json).toMatchObject({ returned: 10, limit: 10, has_more: true });
  expect((await fixture.call({ repo: 'fleet', query: 'needle', limit: 50 })).json).toMatchObject({ returned: 50, has_more: true });
  expect((await fixture.call({ repo: 'fleet', query: 'needle', limit: 1 })).json?.items[0]?.id).toBe('fact-00');
});

it('reserves the entire serialized envelope and crops multibyte facts safely', async () => {
  for (let index = 0; index < 20; index++) fixture.seed({ id: `fact-${index}`, fact: `needle ${'😀'.repeat(2048)}`, provenance: 'é'.repeat(1024) });
  const result = await fixture.call({ repo: 'fleet', query: 'needle', limit: 50 });
  expect(Buffer.byteLength(result.text)).toBeLessThanOrEqual(32768);
  expect(result.json).toMatchObject({ truncated: true, has_more: true });
  expect(result.json!.returned).toBe(result.json!.items.length);
  expect(result.json!.returned).toBeGreaterThan(0);
  for (const item of result.json!.items) {
    expect(item.fact).toBe(`needle ${'😀'.repeat(1022)}`);
    expect(item.fact_truncated).toBe(true);
  }
});

it('drops an oversized first item instead of exceeding the serialized response budget', async () => {
  fixture.seed({ provenance: 'x'.repeat(40000) });
  const result = await fixture.call();
  expect(Buffer.byteLength(result.text)).toBeLessThanOrEqual(32768);
  expect(result.json).toMatchObject({ items: [], returned: 0, truncated: true, has_more: true });
});

it('reserves response metadata when items alone fit the 32 KiB boundary', async () => {
  fixture.seed();
  const baseline = (await fixture.call()).json!;
  const provenance = 'x'.repeat(10830);
  const item = { ...baseline.items[0]!, source_task: provenance, source_kind: provenance, verified_by: provenance };
  expect(Buffer.byteLength(JSON.stringify([item]))).toBeLessThanOrEqual(32768);
  fixture.db.prepare('UPDATE knowledge SET source_task = ?, source_kind = ?, verified_by = ?').run(provenance, provenance, provenance);
  const result = await fixture.call();
  expect(Buffer.byteLength(result.text)).toBeLessThanOrEqual(32768);
  expect(result.json).toMatchObject({ items: [], returned: 0, has_more: true, truncated: true });
});

it.each(['postgres', 'frozen', 'native'])('reports authority %s honestly', async authority => {
  fixture.db.prepare("UPDATE knowledge_repositories SET authority = ?, frozen_at = '2026-10-07', final_snapshot_id = 'sealed', activated_at = '2026-10-08' WHERE project_id = 'p' AND repo_key = 'fleet'").run(authority);
  expect((await fixture.call({ repo: 'fleet', query: '' })).json?.authority).toBe(authority);
});
