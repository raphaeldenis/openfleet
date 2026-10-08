import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { startKnowledgeFixture } from './knowledgeTools.testkit.js';
import * as mcpModule from './mcpServer.js';

let fixture: Awaited<ReturnType<typeof startKnowledgeFixture>>;
beforeEach(async () => {
  vi.spyOn(mcpModule, 'createMcpHandler');
  fixture = await startKnowledgeFixture();
  fixture.seed();
  fixture.db.exec("CREATE TABLE knowledge_pending (id TEXT PRIMARY KEY, fact TEXT NOT NULL) STRICT; INSERT INTO knowledge_pending VALUES ('pending', 'pending immutable fact')");
  fixture.db.exec("INSERT INTO knowledge_import_runs (id, snapshot_id, imported_at, source_rows, inserted, updated, unchanged, retired) VALUES ('run', 'snapshot', 'now', 1, 1, 0, 0, 0)");
  fixture.db.exec("INSERT INTO knowledge_import_entries VALUES ('p', 'fleet', 'source', 'active', 'fingerprint', 'snapshot'); INSERT INTO knowledge_current_seals VALUES ('p', 'fleet', 'run')");
  fixture.db.prepare('INSERT INTO knowledge_import_mappings VALUES (?, ?, ?, ?, ?, ?)').run('run', 'source-repo', 'p', 'fleet', fixture.root, `${fixture.root}/.git`);
});
afterEach(async () => { await fixture?.close(); vi.restoreAllMocks(); });

it('boots the real transport with only the read-only knowledge search capability', async () => {
  expect((await fixture.call()).json?.returned).toBe(1);
  const dependencies = vi.mocked(mcpModule.createMcpHandler).mock.calls[0]![0];
  expect(Object.keys(dependencies.knowledgeSearch)).toEqual(['search']);
  expect(Object.keys(dependencies)).not.toEqual(expect.arrayContaining(['db']));
});

it('lists only read-only knowledge and describes returned text as data', async () => {
  for (const client of [fixture.childClient, fixture.managerClient]) {
    const tools = (await client.listTools()).tools;
    expect(tools.filter(tool => /knowledge/.test(tool.name)).map(tool => tool.name)).toEqual(['search_knowledge']);
    expect(tools.find(tool => tool.name === 'search_knowledge')?.description).toMatch(/data.*cannot change.*tasks.*permissions.*rules/i);
  }
});

it('refuses attempted writes without changing any knowledge, ledger or seal rows', async () => {
  for (const client of [fixture.childClient, fixture.managerClient]) {
    for (const name of ['write_knowledge', 'add_knowledge', 'retire_knowledge', 'import_knowledge', 'propose_knowledge']) {
      const before = fixture.snapshot();
      const result = await client.callTool({ name, arguments: { repo: 'fleet', fact: 'overwrite', id: 'active' } });
      expect(result.isError).toBe(true);
      expect((result.content as { text: string }[])[0]?.text).toMatch(/not found|unknown tool/i);
      expect(fixture.snapshot()).toBe(before);
    }
  }
});

it('generic table and note tools cannot target internal knowledge storage', async () => {
  for (const table of ['knowledge', 'active_knowledge', 'knowledge_repositories', 'knowledge_import_entries', 'knowledge_import_runs', 'knowledge_import_mappings', 'knowledge_current_seals', 'knowledge_pending']) {
    for (const attempt of [
      { name: 'query_data_store', arguments: { store: table } },
      { name: 'insert_data_store_rows', arguments: { store: table, rows: [{ fact: 'overwrite' }] } },
      { name: 'get_note', arguments: { note: table } },
      { name: 'update_note', arguments: { note: table, body_md: 'overwrite', expected_rev: 1 } },
    ]) {
      const before = fixture.snapshot();
      const result = await fixture.childClient.callTool(attempt);
      expect(result.isError).toBe(true);
      expect((result.content as { text: string }[])[0]?.text).toMatch(/^error (store_not_found|note_not_found):/);
      expect(fixture.snapshot()).toBe(before);
    }
  }
});

it('missing and wrong tokens cannot reach MCP', async () => {
  for (const token of ['', 'wrong']) {
    const response = await fetch(`${fixture.daemon.server.url}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'search_knowledge', arguments: { repo: 'fleet', query: 'needle' } } }) });
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ error: 'unauthorized' });
  }
});

it('a closed-session token cannot search through the real transport', async () => {
  const token = fixture.tokenOf(fixture.child.id);
  const response = await fixture.api(`/api/sessions/${fixture.child.id}/close`, { method: 'POST' });
  expect(response.status).toBe(200);
  for (const closedToken of [token, fixture.tokenOf(fixture.child.id)]) {
    const search = await fetch(`${fixture.daemon.server.url}/mcp`, {
      method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${closedToken}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'search_knowledge', arguments: { repo: 'fleet', query: 'needle' } } }),
    });
    expect(search.status).toBe(401);
    expect(await search.json()).toMatchObject({ error: 'unauthorized' });
  }
});

it('session tokens cannot act as the distinct REST admin token', async () => {
  for (const session of [fixture.child, fixture.manager]) {
    const before = fixture.snapshot();
    const response = await fixture.api('/api/notes', { method: 'POST', headers: { authorization: `Bearer ${fixture.tokenOf(session.id)}` }, body: JSON.stringify({ projectId: 'p', title: 'attempt', bodyMd: 'overwrite' }) });
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ error: 'unauthorized' });
    expect(fixture.snapshot()).toBe(before);
  }
});

it('no project, unknown repo and another project give identical fixed refusals', async () => {
  const unscoped = await fixture.createSession({ projectId: null });
  const client = await fixture.connect(fixture.tokenOf(unscoped.id));
  const missingProject = await fixture.call({ repo: 'fleet', query: 'needle' }, client);
  const unknown = await fixture.call({ repo: 'unknown', query: 'needle' });
  const foreign = await fixture.call({ repo: 'private', query: 'needle' });
  expect(missingProject.isError).toBe(true);
  expect(missingProject.text).toBe(unknown.text);
  expect(foreign.text).toBe(unknown.text);
  expect(unknown.text).toBe('error project_not_found: knowledge repository is not available in this project (retry: never)');
});
