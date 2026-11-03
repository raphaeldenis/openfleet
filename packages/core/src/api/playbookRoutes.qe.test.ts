import { afterEach, describe, expect, it } from 'vitest';
import { startGovernanceFixture, OWN_PROJECT_ID, type GovernanceFixture } from '../governance/governanceQueue.testkit.js';

type RestPlaybook = {
  id: string; projectId: string; name: string; contentRev: number; agentLocked: boolean; origin: string; approvedDigest: string | null;
  inputs: unknown[]; flow: { cells: Record<string, unknown>[] }; policy: Record<string, unknown>; secrets: string[]; unreferencedSecrets: string[];
};

let fixture: GovernanceFixture | undefined;
afterEach(async () => { await fixture?.close(); fixture = undefined; });

const boot = async () => {
  fixture = await startGovernanceFixture();
  return fixture;
};
const jsonOf = async <T = RestPlaybook>(response: Response) => await response.json() as T;
const createPlaybook = async (f: GovernanceFixture, body: Record<string, unknown> = {}) =>
  jsonOf(await f.api('/api/playbooks', { method: 'POST', body: JSON.stringify({ projectId: OWN_PROJECT_ID, name: 'P1', ...body }) }));
const replace = (f: GovernanceFixture, id: string, body: Record<string, unknown>) => f.api(`/api/playbooks/${id}`, { method: 'PUT', body: JSON.stringify(body) });
const fetchWith = (f: GovernanceFixture, path: string, authorization?: string, init: RequestInit = {}) =>
  fetch(`${f.daemon.server.url}${path}`, { ...init, headers: { 'content-type': 'application/json', ...(authorization === undefined ? {} : { authorization }) } });
const mcpTokenOf = (f: GovernanceFixture, sessionId: string) => (f.db.prepare('SELECT mcp_token FROM sessions WHERE id = ?').get(sessionId) as { mcp_token: string }).mcp_token;
const scriptCell = (overrides: Record<string, unknown> = {}) => ({ id: 'build', kind: 'script', program: 'scripts/verify.sh', ...overrides });

describe('the playbook routes are behind the admin token', () => {
  it.each([
    ['GET', `/api/playbooks?projectId=${OWN_PROJECT_ID}`],
    ['POST', '/api/playbooks'],
    ['GET', '/api/playbooks/x'],
    ['PUT', '/api/playbooks/x'],
    ['DELETE', '/api/playbooks/x'],
  ])('answers 401 to %s %s with no token and with the MCP token of a session', async (method, path) => {
    const f = await boot();

    const withoutToken = await fetchWith(f, path, undefined, { method, body: method === 'GET' ? undefined : '{}' });
    const withSessionToken = await fetchWith(f, path, `Bearer ${mcpTokenOf(f, f.lead.id)}`, { method, body: method === 'GET' ? undefined : '{}' });

    expect([withoutToken.status, withSessionToken.status]).toEqual([401, 401]);
  });
});

describe('the CRUD of playbooks', () => {
  it('creates, lists, reads, replaces with a revision and deletes', async () => {
    const f = await boot();
    const playbook = await createPlaybook(f);

    const listed = await jsonOf<RestPlaybook[]>(await f.api(`/api/playbooks?projectId=${OWN_PROJECT_ID}`));
    const read = await jsonOf(await f.api(`/api/playbooks/${playbook.id}`));
    const replaced = await jsonOf(await replace(f, playbook.id, {
      expectedRev: 1, name: 'Renamed', inputs: [{ name: 'env', type: 'string' }], cells: [scriptCell()], policy: { maxRunsToKeep: 10 },
    }));
    const deleted = await f.api(`/api/playbooks/${playbook.id}?expectedRev=2`, { method: 'DELETE' });

    expect(playbook).toMatchObject({ projectId: OWN_PROJECT_ID, name: 'P1', contentRev: 1, origin: 'native', agentLocked: false, approvedDigest: null, flow: { cells: [] } });
    expect(listed.map((listedPlaybook) => listedPlaybook.id)).toEqual([playbook.id]);
    expect(read).toEqual(playbook);
    expect(replaced).toMatchObject({ name: 'Renamed', contentRev: 2, inputs: [{ name: 'env', type: 'string', required: false }], policy: { browserAutoGrant: false, autoDistill: false, maxRunsToKeep: 10 } });
    expect(replaced.flow.cells).toEqual([{ id: 'build', kind: 'script', program: 'scripts/verify.sh', args: [], env: {} }]);
    expect(deleted.status).toBe(200);
    expect((await f.api(`/api/playbooks/${playbook.id}`)).status).toBe(404);
  });

  it('creates a playbook with its cells and inputs in one call', async () => {
    const f = await boot();

    const playbook = await createPlaybook(f, { cells: [scriptCell(), { id: 'ask', kind: 'manual', prompt: 'Check' }], inputs: [{ name: 'env', type: 'string' }] });

    expect(playbook.flow.cells.map((cell) => cell.id)).toEqual(['build', 'ask']);
  });

  it('answers 409 playbook_conflict with the current revision to a replacement made on an old revision, and writes nothing', async () => {
    const f = await boot();
    const playbook = await createPlaybook(f);
    await replace(f, playbook.id, { expectedRev: 1, name: 'Second' });

    const stale = await replace(f, playbook.id, { expectedRev: 1, name: 'Third' });

    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ error: 'playbook_conflict', retry: 'after_refresh', detail: { currentRev: 2 } });
    expect((await jsonOf(await f.api(`/api/playbooks/${playbook.id}`))).name).toBe('Second');
  });

  it('refuses a replacement without expectedRev', async () => {
    const f = await boot();
    const playbook = await createPlaybook(f);

    expect((await replace(f, playbook.id, { name: 'x' })).status).toBe(400);
  });

  it('answers 404 playbook_not_found for an unknown playbook and 404 project_not_found for an unknown project', async () => {
    const f = await boot();

    expect(await (await f.api('/api/playbooks/nope')).json()).toMatchObject({ error: 'playbook_not_found' });
    const unknownProject = await f.api('/api/playbooks', { method: 'POST', body: JSON.stringify({ projectId: 'nope' }) });
    expect(await unknownProject.json()).toMatchObject({ error: 'project_not_found' });
  });
});

describe('the revision of a delete (F1)', () => {
  it.each(['', '?expectedRev=0', '?expectedRev=abc', '?expectedRev=1.5'])('refuses DELETE%s with 400 and keeps the playbook', async (query) => {
    const f = await boot();
    const playbook = await createPlaybook(f);

    const refused = await f.api(`/api/playbooks/${playbook.id}${query}`, { method: 'DELETE' });

    expect(refused.status).toBe(400);
    expect((await f.api(`/api/playbooks/${playbook.id}`)).status).toBe(200);
  });

  it('refuses a stale DELETE with 409 playbook_conflict and the current revision, and keeps the playbook', async () => {
    const f = await boot();
    const playbook = await createPlaybook(f);
    await replace(f, playbook.id, { expectedRev: 1, name: 'Second' });

    const stale = await f.api(`/api/playbooks/${playbook.id}?expectedRev=1`, { method: 'DELETE' });

    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ error: 'playbook_conflict', detail: { currentRev: 2 } });
    expect((await jsonOf(await f.api(`/api/playbooks/${playbook.id}`))).name).toBe('Second');
  });

  it('deletes with the current revision', async () => {
    const f = await boot();
    const playbook = await createPlaybook(f);

    const deleted = await f.api(`/api/playbooks/${playbook.id}?expectedRev=1`, { method: 'DELETE' });

    expect(deleted.status).toBe(200);
    expect((await f.api(`/api/playbooks/${playbook.id}`)).status).toBe(404);
  });
});

describe('the size caps count UTF-8 bytes (F2)', () => {
  const kanjiHttpCell = (position: number) => ({ id: `h${position}`, kind: 'http', method: 'POST', url: 'https://example.com', body: '漢'.repeat(60000) });

  it('stops 10 http cells of 60000 kanji (1 800 831 bytes) at the request body cap, before the playbook rules', async () => {
    const f = await boot();
    const playbook = await createPlaybook(f);

    const refused = await replace(f, playbook.id, { expectedRev: 1, cells: Array.from({ length: 10 }, (_, position) => kanjiHttpCell(position)) });

    expect(refused.status).toBe(413);
    expect((await jsonOf(await f.api(`/api/playbooks/${playbook.id}`))).contentRev).toBe(1);
  });

  it('accepts 5 of them: 900 000 bytes, under the cap', async () => {
    const f = await boot();
    const playbook = await createPlaybook(f);

    const accepted = await replace(f, playbook.id, { expectedRev: 1, cells: Array.from({ length: 5 }, (_, position) => kanjiHttpCell(position)) });

    expect(accepted.status).toBe(200);
  });
});

describe('the checks of a save through REST', () => {
  it('refuses a secret in a manual prompt with secret_not_allowed_here, a bash cell and a reserved kind with their codes', async () => {
    const f = await boot();
    const playbook = await createPlaybook(f);

    const secretInPrompt = await replace(f, playbook.id, { expectedRev: 1, cells: [{ id: 'ask', kind: 'manual', prompt: '{{secret:X}}' }] });
    const bash = await replace(f, playbook.id, { expectedRev: 1, cells: [{ id: 'b', kind: 'bash', command: 'ls' }] });
    const reserved = await replace(f, playbook.id, { expectedRev: 1, cells: [{ id: 'c', kind: 'claudePrompt', prompt: 'x' }] });

    expect((await secretInPrompt.json()).error).toBe('secret_not_allowed_here');
    expect((await bash.json()).error).toBe('cell_kind_unsupported');
    expect((await reserved.json()).error).toBe('cell_kind_reserved');
    expect((await jsonOf(await f.api(`/api/playbooks/${playbook.id}`))).contentRev).toBe(1);
  });

  it('refuses a loop without retry and a cell no path reaches with playbook_graph_invalid', async () => {
    const f = await boot();
    const playbook = await createPlaybook(f);

    const loop = await replace(f, playbook.id, { expectedRev: 1, cells: [scriptCell({ id: 'a' }), scriptCell({ id: 'b', next: [{ to: 'a' }] })] });
    const orphan = await replace(f, playbook.id, { expectedRev: 1, cells: [scriptCell({ id: 'a', next: [] }), scriptCell({ id: 'b' })] });

    expect([(await loop.json()).error, (await orphan.json()).error]).toEqual(['playbook_graph_invalid', 'playbook_graph_invalid']);
  });
});

describe('the secrets of a playbook written through REST', () => {
  it('declares the referenced names, reports the unreferenced stored ones by name, and clears the missing ones', async () => {
    const f = await boot();
    const playbook = await createPlaybook(f, { cells: [scriptCell({ env: { A: '{{secret:JIRA_TOKEN}}', B: '{{secret:OLD_KEY}}' } })] });
    f.db.prepare("UPDATE secret_refs SET status = 'stored', set_at = 'now', set_by = 'human' WHERE scope_id = ? AND name = 'OLD_KEY'").run(playbook.id);

    const afterEdit = await jsonOf(await replace(f, playbook.id, { expectedRev: 1, cells: [scriptCell({ env: { A: '{{secret:JIRA_TOKEN}}' } })] }));
    const afterRemoval = await jsonOf(await replace(f, playbook.id, { expectedRev: 2, cells: [scriptCell()] }));

    expect(playbook.secrets).toEqual(['JIRA_TOKEN', 'OLD_KEY']);
    expect(afterEdit).toMatchObject({ secrets: ['JIRA_TOKEN'], unreferencedSecrets: ['OLD_KEY'] });
    expect(afterRemoval).toMatchObject({ secrets: [], unreferencedSecrets: ['OLD_KEY'] });
    expect(f.db.prepare('SELECT name, status FROM secret_refs WHERE scope_id = ? ORDER BY name').all(playbook.id)).toEqual([{ name: 'OLD_KEY', status: 'stored' }]);
  });
});

describe('agent_locked and origin', () => {
  it('keeps the origin of the creation: agent through MCP, native through REST', async () => {
    const f = await boot();
    const lead = await f.connect(f.lead.id);
    const viaRest = await createPlaybook(f);

    const viaMcp = JSON.parse(((await lead.callTool({ name: 'create_playbook', arguments: { name: 'FromAgent' } })).content as { text: string }[])[0]!.text) as { origin: string };

    expect([viaRest.origin, viaMcp.origin]).toEqual(['native', 'agent']);
  });

  it('can be locked and unlocked through REST, and the revision moves each time', async () => {
    const f = await boot();
    const playbook = await createPlaybook(f);

    const locked = await jsonOf(await replace(f, playbook.id, { expectedRev: 1, agentLocked: true }));
    const unlocked = await jsonOf(await replace(f, playbook.id, { expectedRev: 2, agentLocked: false }));

    expect([locked.agentLocked, locked.contentRev, unlocked.agentLocked, unlocked.contentRev]).toEqual([true, 2, false, 3]);
  });
});

describe('the activity log of the REST writes', () => {
  it('records a write as an action of the human, with no cell text in it', async () => {
    const f = await boot();
    const canary = `canary free text ${crypto.randomUUID()}`;
    const playbook = await createPlaybook(f, { name: canary });
    await replace(f, playbook.id, { expectedRev: 1, cells: [{ id: 'ask', kind: 'manual', prompt: canary }] });
    await f.api(`/api/playbooks/${playbook.id}?expectedRev=2`, { method: 'DELETE' });

    const rows = f.db.prepare("SELECT actor_kind, source, action, outcome FROM activity_log WHERE action LIKE '%playbooks%'").all();

    expect(rows.map((row) => `${row.actor_kind} ${row.source} ${row.action} ${row.outcome}`)).toEqual([
      'human rest POST /api/playbooks ok', 'human rest PUT /api/playbooks/:id ok', 'human rest DELETE /api/playbooks/:id ok',
    ]);
    expect(JSON.stringify(f.db.prepare('SELECT * FROM activity_log').all())).not.toContain('canary');
  });

  it('records a refused write as a refusal of the human', async () => {
    const f = await boot();
    const playbook = await createPlaybook(f);
    await replace(f, playbook.id, { expectedRev: 9, name: 'x' });

    const row = f.db.prepare("SELECT outcome FROM activity_log WHERE action = 'PUT /api/playbooks/:id'").get() as { outcome: string };

    expect(row.outcome).not.toBe('ok');
  });
});
