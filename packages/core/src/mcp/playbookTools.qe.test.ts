import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startGovernanceFixture, OTHER_PROJECT_ID, OWN_PROJECT_ID, type GovernanceFixture } from '../governance/governanceQueue.testkit.js';
import { ARBITER_TOOL_NAMES } from './arbiterTools.js';

type Client = Awaited<ReturnType<GovernanceFixture['connect']>>;
type PlaybookView = {
  id: string; name: string; project_id: string; content_rev: number; agent_locked: boolean; origin: string; approved: boolean;
  inputs: { name: string }[]; cells: Record<string, any>[]; secrets: string[]; unreferencedSecrets: string[];
};

const PLAYBOOK_TOOLS = [
  'list_playbooks', 'get_playbook', 'create_playbook', 'delete_playbook', 'get_playbook_schema', 'list_playbook_cells',
  'add_playbook_cell', 'update_playbook_cell', 'delete_playbook_cell', 'reorder_playbook_cells', 'set_playbook_inputs',
];

let fixture: GovernanceFixture;
let lead: Client;
beforeEach(async () => {
  fixture = await startGovernanceFixture();
  lead = await fixture.connect(fixture.lead.id);
});
afterEach(async () => { await fixture.close(); });

const call = async (client: Client, name: string, args: Record<string, unknown> = {}) => {
  const result = await client.callTool({ name, arguments: args });
  const text = (result.content as { text: string }[])[0]!.text;
  return { isError: result.isError === true, text, json: result.isError === true ? undefined : JSON.parse(text) };
};
const created = async (name = 'Deploy'): Promise<PlaybookView> => (await call(lead, 'create_playbook', { name })).json as PlaybookView;
const viewOf = async (playbook: string, client = lead): Promise<PlaybookView> => (await call(client, 'get_playbook', { playbook })).json as PlaybookView;
const addCell = (playbook: string, kind: string, args: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) => call(lead, 'add_playbook_cell', { playbook, kind, args, ...extra });
const script = (extra: Record<string, unknown> = {}) => ({ program: 'scripts/verify.sh', ...extra });
const declaredSecrets = (playbookId: string) => fixture.db.prepare("SELECT name, status FROM secret_refs WHERE scope_kind = 'playbook' AND scope_id = ? ORDER BY name").all(playbookId);
const markStored = (playbookId: string, name: string) => fixture.db.prepare("UPDATE secret_refs SET status = 'stored', set_at = 'now', set_by = 'human' WHERE scope_kind = 'playbook' AND scope_id = ? AND name = ?").run(playbookId, name);
const lockViaRest = async (playbook: PlaybookView) => fixture.api(`/api/playbooks/${playbook.id}`, { method: 'PUT', body: JSON.stringify({ expectedRev: playbook.content_rev, agentLocked: true }) });

describe('create_playbook, list_playbooks, get_playbook', () => {
  it('creates an empty unlocked playbook of origin agent at revision 1 in the project of the caller, readable by id and by exact name', async () => {
    const playbook = await created('Deploy');

    expect(playbook).toMatchObject({ name: 'Deploy', project_id: OWN_PROJECT_ID, content_rev: 1, agent_locked: false, origin: 'agent', approved: false, cells: [], inputs: [], secrets: [], unreferencedSecrets: [] });
    expect(await viewOf(playbook.id)).toEqual(playbook);
    expect(await viewOf('Deploy')).toEqual(playbook);
    expect((await call(lead, 'list_playbooks')).json.playbooks).toEqual([{ id: playbook.id, name: 'Deploy', content_rev: 1, cell_count: 0, agent_locked: false }]);
  });

  it('does not show a playbook of another project, whatever its id or name', async () => {
    const foreign = await (await fixture.api('/api/playbooks', { method: 'POST', body: JSON.stringify({ projectId: OTHER_PROJECT_ID, name: 'Foreign' }) })).json() as { id: string };

    expect((await call(lead, 'get_playbook', { playbook: foreign.id })).text).toMatch(/^error playbook_not_found:/);
    expect((await call(lead, 'get_playbook', { playbook: 'Foreign' })).text).toMatch(/^error playbook_not_found:/);
    expect((await call(lead, 'list_playbooks')).json.playbooks).toEqual([]);
  });

  it('refuses an ambiguous name', async () => {
    await created('Twin');
    await created('Twin');

    expect((await call(lead, 'get_playbook', { playbook: 'Twin' })).text).toMatch(/^error invalid_body: .*ambiguous/);
  });
});

describe('get_playbook_schema', () => {
  it('names the eight kinds, the reserved kinds and the refusal of a shell cell', async () => {
    const { json } = await call(lead, 'get_playbook_schema');

    expect(json.kinds.map((kind: { kind: string }) => kind.kind).sort()).toEqual(['http', 'manual', 'readFromStore', 'script', 'subPlaybook', 'tool', 'waitFor', 'writeToStore']);
    expect([...json.reservedKinds].sort()).toEqual(['calendarEvent', 'claudePrompt', 'claudeSession', 'customTool']);
    expect(json.refusedKinds.bash).toMatch(/script/);
    expect(json.limits).toMatchObject({ cells: 200, scriptArguments: 64, promptChars: 8192 });
  });
});

describe('the cells of a playbook', () => {
  it('adds cells in order with a generated id, inserts after a given one, and lists them', async () => {
    const playbook = await created();
    await addCell(playbook.id, 'script', script());
    const second = (await addCell(playbook.id, 'manual', { prompt: 'Check the dashboard' })).json as PlaybookView;
    const inserted = (await addCell(playbook.id, 'script', script({ args: ['--fast'] }), { after: second.cells[0]!.id })).json as PlaybookView;
    const listed = (await call(lead, 'list_playbook_cells', { playbook: playbook.id })).json;

    expect(inserted.cells.map((cell) => cell.kind)).toEqual(['script', 'script', 'manual']);
    expect(new Set(inserted.cells.map((cell) => cell.id)).size).toBe(3);
    expect(inserted.content_rev).toBe(4);
    expect(listed.cells.map((cell: { position: number; kind: string }) => [cell.position, cell.kind])).toEqual([[0, 'script'], [1, 'script'], [2, 'manual']]);
  });

  it('keeps an id given by the caller', async () => {
    const playbook = await created();

    const { json } = await addCell(playbook.id, 'script', script(), { id: 'build' });

    expect(json.cells[0].id).toBe('build');
  });

  it('merges the fields given into a cell and keeps the others, without changing its id or kind', async () => {
    const playbook = await created();
    await addCell(playbook.id, 'script', script({ args: ['a'] }), { id: 'build' });

    const updated = (await call(lead, 'update_playbook_cell', { playbook: playbook.id, cell_id: 'build', args: { args: ['b', 'c'], timeoutSeconds: 30 } })).json as PlaybookView;
    const kindChange = await call(lead, 'update_playbook_cell', { playbook: playbook.id, cell_id: 'build', args: { kind: 'manual', prompt: 'x' } });

    expect(updated.cells[0]).toMatchObject({ id: 'build', kind: 'script', program: 'scripts/verify.sh', args: ['b', 'c'], timeoutSeconds: 30 });
    expect(kindChange.text).toMatch(/^error invalid_body:/);
  });

  it('deletes a cell by id and refuses an unknown id', async () => {
    const playbook = await created();
    await addCell(playbook.id, 'script', script(), { id: 'a' });
    await addCell(playbook.id, 'script', script(), { id: 'b' });

    const deleted = (await call(lead, 'delete_playbook_cell', { playbook: playbook.id, cell_id: 'a' })).json as PlaybookView;

    expect(deleted.cells.map((cell) => cell.id)).toEqual(['b']);
    expect((await call(lead, 'delete_playbook_cell', { playbook: playbook.id, cell_id: 'nope' })).text).toMatch(/^error playbook_cell_not_found:/);
    expect((await call(lead, 'update_playbook_cell', { playbook: playbook.id, cell_id: 'nope', args: {} })).text).toMatch(/^error playbook_cell_not_found:/);
  });

  it('reorders the cells and refuses an order that does not name every cell once', async () => {
    const playbook = await created();
    for (const id of ['a', 'b', 'c']) await addCell(playbook.id, 'script', script(), { id });

    const reordered = (await call(lead, 'reorder_playbook_cells', { playbook: playbook.id, order: ['c', 'a', 'b'] })).json as PlaybookView;

    expect(reordered.cells.map((cell) => cell.id)).toEqual(['c', 'a', 'b']);
    expect((await call(lead, 'reorder_playbook_cells', { playbook: playbook.id, order: ['c', 'a'] })).text).toMatch(/^error invalid_body:/);
    expect((await call(lead, 'reorder_playbook_cells', { playbook: playbook.id, order: ['c', 'c', 'a'] })).text).toMatch(/^error invalid_body:/);
    expect((await viewOf(playbook.id)).cells.map((cell) => cell.id)).toEqual(['c', 'a', 'b']);
  });

  it('replaces the inputs and refuses two inputs of the same name', async () => {
    const playbook = await created();

    const { json } = await call(lead, 'set_playbook_inputs', { playbook: playbook.id, inputs: [{ name: 'env', type: 'string', required: true }, { name: 'retries', type: 'number', default: 3 }] });
    const duplicated = await call(lead, 'set_playbook_inputs', { playbook: playbook.id, inputs: [{ name: 'a', type: 'string' }, { name: 'a', type: 'string' }] });

    expect(json.inputs.map((input: { name: string }) => input.name)).toEqual(['env', 'retries']);
    expect(duplicated.text).toMatch(/^error invalid_body:/);
  });

  it('holds 200 cells and refuses the 201st', async () => {
    const playbook = await created();
    fixture.db.prepare('UPDATE playbooks SET flow_json = ? WHERE id = ?').run(JSON.stringify({ cells: Array.from({ length: 200 }, (_, position) => ({ id: `c${position}`, kind: 'script', program: 'p', args: [], env: {} })) }), playbook.id);

    const refused = await addCell(playbook.id, 'script', script());

    expect(refused.text).toMatch(/^error playbook_limit_exceeded:/);
  });
});

describe('the kinds that are refused', () => {
  it.each(['claudePrompt', 'claudeSession', 'customTool', 'calendarEvent'])('refuses a %s cell with the reserved code', async (kind) => {
    const playbook = await created();

    expect((await addCell(playbook.id, kind, { prompt: 'x' })).text).toMatch(/^error cell_kind_reserved:/);
    expect((await viewOf(playbook.id)).cells).toEqual([]);
  });

  it('refuses a bash cell and any unknown kind with the unsupported code, and never stores a shell string', async () => {
    const playbook = await created();

    expect((await addCell(playbook.id, 'bash', { command: 'rm -rf /' })).text).toMatch(/^error cell_kind_unsupported: .*script/);
    expect((await addCell(playbook.id, 'nonsense')).text).toMatch(/^error cell_kind_unsupported:/);
    expect((await addCell(playbook.id, 'script', script({ command: 'rm -rf /' }))).text).toMatch(/^error invalid_body:/);
    expect((await viewOf(playbook.id)).cells).toEqual([]);
  });

  it('refuses a script with more than 64 arguments', async () => {
    const playbook = await created();

    expect((await addCell(playbook.id, 'script', script({ args: Array.from({ length: 65 }, () => 'a') }))).text).toMatch(/^error invalid_body:/);
  });
});

describe('the templates checked at every save', () => {
  it('refuses a secret in a manual prompt, a script argument, an http url, a body, a tool input and a label, and stores nothing', async () => {
    const playbook = await created();
    const secret = '{{secret:API_TOKEN}}';
    const attempts: [string, Record<string, unknown>][] = [
      ['manual', { prompt: `use ${secret}` }],
      ['script', script({ args: [secret] })],
      ['http', { method: 'GET', url: `https://example.com/?k=${secret}` }],
      ['http', { method: 'POST', url: 'https://example.com', body: secret }],
      ['tool', { tool: 'list_notes', input: { query: secret } }],
      ['script', script({ label: secret })],
    ];

    for (const [kind, args] of attempts) {
      expect((await addCell(playbook.id, kind, args)).text, `${kind} ${JSON.stringify(args)}`).toMatch(/^error secret_not_allowed_here:/);
    }
    expect(declaredSecrets(playbook.id)).toEqual([]);
    expect((await viewOf(playbook.id)).content_rev).toBe(1);
  });

  it('accepts a secret in a script env value, an http header and an http auth', async () => {
    const playbook = await created();

    const withEnv = await addCell(playbook.id, 'script', script({ env: { API_TOKEN: '{{secret:API_TOKEN}}' } }));
    const withHeader = await addCell(playbook.id, 'http', { method: 'GET', url: 'https://example.com', headers: { 'X-Key': '{{secret:HEADER_KEY}}' } });
    const withAuth = await addCell(playbook.id, 'http', { method: 'GET', url: 'https://example.com', auth: { type: 'bearer', token: '{{secret:BEARER}}' } });

    expect([withEnv.isError, withHeader.isError, withAuth.isError]).toEqual([false, false, false]);
    expect((await viewOf(playbook.id)).secrets).toEqual(['API_TOKEN', 'BEARER', 'HEADER_KEY']);
  });

  it('refuses a malformed secret name and an unknown token', async () => {
    const playbook = await created();

    expect((await addCell(playbook.id, 'script', script({ env: { A: '{{secret:1bad}}' } }))).text).toMatch(/^error invalid_secret_name:/);
    expect((await addCell(playbook.id, 'script', script({ args: ['{{whatever}}'] }))).text).toMatch(/^error unknown_token:/);
  });

  it('refuses a reference to an http response in script args, script env and an http url, and allows it in a text slot', async () => {
    const playbook = await created();
    await addCell(playbook.id, 'http', { method: 'GET', url: 'https://example.com/data' }, { id: 'fetch' });

    const inArgs = await addCell(playbook.id, 'script', script({ args: ['{{steps.fetch.body}}'] }));
    const inEnv = await addCell(playbook.id, 'script', script({ env: { X: '{{steps.fetch.body}}' } }));
    const inUrl = await addCell(playbook.id, 'http', { method: 'GET', url: '{{steps.fetch.next}}/x' });
    const inPrompt = await addCell(playbook.id, 'manual', { prompt: 'Check {{steps.fetch.body}}' });

    expect([inArgs.text, inEnv.text, inUrl.text].every((text) => /^error untrusted_reference:/.test(text))).toBe(true);
    expect(inPrompt.isError).toBe(false);
  });

  it.each([
    ['readFromStore', { storeID: 's1' }],
    ['tool', { tool: 'list_notes' }],
    ['script', script()],
    ['manual', { prompt: 'Check' }],
  ])('refuses a reference to the output of a %s cell in script args, script env and an http header, and allows {{inputs.x}} and a text slot', async (kind, args) => {
    const playbook = await created();
    await addCell(playbook.id, kind, args, { id: 'source' });

    const inArgs = await addCell(playbook.id, 'script', script({ args: ['{{steps.source.out}}'] }));
    const inEnv = await addCell(playbook.id, 'script', script({ env: { X: '{{steps.source.out}}' } }));
    const inHeader = await addCell(playbook.id, 'http', { method: 'GET', url: 'https://example.com', headers: { 'X-A': '{{steps.source.out}}' } });
    const fromInputs = await addCell(playbook.id, 'script', script({ args: ['{{inputs.env}}'] }));
    const inLabel = await addCell(playbook.id, 'manual', { prompt: 'Got {{steps.source.out}}' });

    expect([inArgs.text, inEnv.text, inHeader.text].every((text) => /^error untrusted_reference:/.test(text))).toBe(true);
    expect([fromInputs.isError, inLabel.isError]).toEqual([false, false]);
  });

  it('refuses {{item}} in script args when the loop iterates an http response', async () => {
    const playbook = await created();
    await addCell(playbook.id, 'http', { method: 'GET', url: 'https://example.com/list' }, { id: 'fetch' });
    await addCell(playbook.id, 'script', script({ args: ['fixed'] }), { id: 'each' });
    const iterating = await call(lead, 'update_playbook_cell', { playbook: playbook.id, cell_id: 'fetch', args: { next: [{ to: 'each', forEach: 'steps.fetch.items' }] } });

    const refused = await call(lead, 'update_playbook_cell', { playbook: playbook.id, cell_id: 'each', args: { args: ['{{item}}'] } });
    const inText = await call(lead, 'update_playbook_cell', { playbook: playbook.id, cell_id: 'each', args: { label: 'item {{item}}' } });

    expect(iterating.isError).toBe(false);
    expect(refused.text).toMatch(/^error untrusted_reference: .*\{\{item\}\}/);
    expect(inText.isError).toBe(false);
  });

  it.each(['https:/example.com', 'https:///evil.com', 'https:\\\\evil.com', '//evil.com', 'https://\nevil.com'])('refuses the non canonical url %j', async (url) => {
    const playbook = await created();

    expect((await addCell(playbook.id, 'http', { method: 'GET', url })).text).toMatch(/^error non_canonical_url:/);
  });

  it('checks the inputs too: a secret in an input default is refused', async () => {
    const playbook = await created();

    const refused = await call(lead, 'set_playbook_inputs', { playbook: playbook.id, inputs: [{ name: 'a', type: 'string', default: '{{secret:X}}' }] });

    expect(refused.text).toMatch(/^error secret_not_allowed_here:/);
  });

  it('checks the whole playbook on update: a secret moved into a prompt by an update is refused and the cell keeps its value', async () => {
    const playbook = await created();
    await addCell(playbook.id, 'manual', { prompt: 'ok' }, { id: 'ask' });

    const refused = await call(lead, 'update_playbook_cell', { playbook: playbook.id, cell_id: 'ask', args: { prompt: '{{secret:X}}' } });

    expect(refused.text).toMatch(/^error secret_not_allowed_here:/);
    expect((await viewOf(playbook.id)).cells[0]!.prompt).toBe('ok');
  });
});

describe('the graph of a playbook', () => {
  it('refuses a next that leads to a cell that does not exist', async () => {
    const playbook = await created();

    const refused = await addCell(playbook.id, 'script', script({ next: [{ to: 'ghost' }] }));

    expect(refused.text).toMatch(/^error playbook_graph_invalid: .*ghost/);
  });

  it('refuses a cell that no path from the entry cell reaches', async () => {
    const playbook = await created();
    await addCell(playbook.id, 'script', script(), { id: 'a' });
    await addCell(playbook.id, 'script', script(), { id: 'b' });

    const refused = await call(lead, 'update_playbook_cell', { playbook: playbook.id, cell_id: 'a', args: { next: [] } });

    expect(refused.text).toMatch(/^error playbook_graph_invalid: .*from the entry cell a to b/);
    expect((await viewOf(playbook.id)).cells[0]!.next).toBeUndefined();
  });

  it('refuses two cells with the same id', async () => {
    const playbook = await created();
    await addCell(playbook.id, 'script', script(), { id: 'a' });

    const refused = await addCell(playbook.id, 'script', script(), { id: 'a' });

    expect(refused.text).toMatch(/^error playbook_graph_invalid: two cells carry the id a/);
  });

  it('refuses a loop with no retry, forEach or waitFor, and names the cells', async () => {
    const playbook = await created();
    await addCell(playbook.id, 'script', script(), { id: 'a' });

    const refused = await addCell(playbook.id, 'script', script({ next: [{ to: 'a' }] }), { id: 'b' });

    expect(refused.text).toMatch(/^error playbook_graph_invalid: cells a, b loop without/);
    expect((await viewOf(playbook.id)).cells.map((cell) => cell.id)).toEqual(['a']);
  });

  it('accepts a loop that retries, one that iterates with forEach and one that waits', async () => {
    const retrying = await created('Retrying');
    await addCell(retrying.id, 'script', script(), { id: 'a' });
    const retried = await addCell(retrying.id, 'script', script({ retry: { maxAttempts: 3, until: [{ lhs: 'steps.b.ok', op: 'eq', rhs: true }], backoffMs: 100 }, next: [{ to: 'a' }] }), { id: 'b' });

    const iterating = await created('Iterating');
    await addCell(iterating.id, 'script', script({ next: [{ to: 'a', forEach: 'inputs.items' }] }), { id: 'a' });

    const waiting = await created('Waiting');
    const waited = await addCell(waiting.id, 'waitFor', { predicate: [{ lhs: 'steps.a.ready', op: 'eq', rhs: true }], next: [{ to: 'a' }] }, { id: 'a' });

    expect([retried.isError, waited.isError]).toEqual([false, false]);
    expect((await viewOf(iterating.id)).cells).toHaveLength(1);
  });

  it('refuses to delete the cell that is the only way to the cells after it, and to branch around a cell', async () => {
    const playbook = await created();
    for (const id of ['a', 'b', 'c']) await addCell(playbook.id, 'script', script(), { id });
    await call(lead, 'update_playbook_cell', { playbook: playbook.id, cell_id: 'a', args: { next: [{ to: 'b' }, { to: 'c' }] } });

    const branchingAround = await call(lead, 'update_playbook_cell', { playbook: playbook.id, cell_id: 'a', args: { next: [{ to: 'c' }] } });
    const deletedTarget = await call(lead, 'delete_playbook_cell', { playbook: playbook.id, cell_id: 'c' });

    expect(branchingAround.text).toMatch(/^error playbook_graph_invalid: .*b/);
    expect(deletedTarget.text).toMatch(/^error playbook_graph_invalid: .*not a cell of this playbook/);
  });
});

describe('the secrets a playbook declares', () => {
  it('declares a referenced secret as missing, and removes the declaration when no cell references it any more', async () => {
    const playbook = await created();
    await addCell(playbook.id, 'script', script({ env: { A: '{{secret:JIRA_TOKEN}}' } }), { id: 'build' });
    const declaredAfterAdd = declaredSecrets(playbook.id);

    await call(lead, 'update_playbook_cell', { playbook: playbook.id, cell_id: 'build', args: { env: {} } });

    expect(declaredAfterAdd).toEqual([{ name: 'JIRA_TOKEN', status: 'missing' }]);
    expect(declaredSecrets(playbook.id)).toEqual([]);
    expect((await viewOf(playbook.id)).secrets).toEqual([]);
  });

  it('declares a name once however many cells use it, and reads a token written with spaces', async () => {
    const playbook = await created();
    await addCell(playbook.id, 'script', script({ env: { A: '{{secret:KEY}}' } }));
    await addCell(playbook.id, 'script', script({ env: { B: '{{ secret:KEY }}' } }));

    expect(declaredSecrets(playbook.id)).toEqual([{ name: 'KEY', status: 'missing' }]);
    const removed = await call(lead, 'delete_playbook_cell', { playbook: playbook.id, cell_id: (await viewOf(playbook.id)).cells[0]!.id });
    expect(removed.isError).toBe(false);
    expect(declaredSecrets(playbook.id)).toEqual([{ name: 'KEY', status: 'missing' }]);
  });

  it('keeps a stored secret declared when no cell references it, lists it as unreferenced by name, and stops listing it once a cell references it again', async () => {
    const playbook = await created();
    await addCell(playbook.id, 'script', script({ env: { A: '{{secret:JIRA_TOKEN}}' } }), { id: 'build' });
    markStored(playbook.id, 'JIRA_TOKEN');

    const unreferenced = (await call(lead, 'update_playbook_cell', { playbook: playbook.id, cell_id: 'build', args: { env: {} } })).json as PlaybookView;
    const rereferenced = (await call(lead, 'update_playbook_cell', { playbook: playbook.id, cell_id: 'build', args: { env: { A: '{{secret:JIRA_TOKEN}}' } } })).json as PlaybookView;

    expect(unreferenced.unreferencedSecrets).toEqual(['JIRA_TOKEN']);
    expect(unreferenced.secrets).toEqual([]);
    expect(declaredSecrets(playbook.id)).toEqual([{ name: 'JIRA_TOKEN', status: 'stored' }]);
    expect(rereferenced.unreferencedSecrets).toEqual([]);
    expect(rereferenced.secrets).toEqual(['JIRA_TOKEN']);
  });

  it('shows the statuses to the secret tool of the playbook, with names only', async () => {
    const playbook = await created();
    await addCell(playbook.id, 'script', script({ env: { A: '{{secret:JIRA_TOKEN}}' } }));

    const { json } = await call(lead, 'list_playbook_secret_statuses', { playbook_id: playbook.id });

    expect(json.statuses).toEqual([{ name: 'JIRA_TOKEN', status: 'missing' }]);
  });

  it('removes the missing declarations of a deleted playbook and keeps the stored ones', async () => {
    const playbook = await created();
    await addCell(playbook.id, 'script', script({ env: { A: '{{secret:GONE}}', B: '{{secret:KEPT}}' } }));
    markStored(playbook.id, 'KEPT');

    await call(lead, 'delete_playbook', { playbook: playbook.id });

    expect(declaredSecrets(playbook.id)).toEqual([{ name: 'KEPT', status: 'stored' }]);
  });

  it('leaves the declarations alone when a save is refused', async () => {
    const playbook = await created();
    await addCell(playbook.id, 'script', script({ env: { A: '{{secret:KEEP}}' } }), { id: 'build' });

    await call(lead, 'update_playbook_cell', { playbook: playbook.id, cell_id: 'build', args: { env: {}, args: ['{{secret:OTHER}}'] } });

    expect(declaredSecrets(playbook.id)).toEqual([{ name: 'KEEP', status: 'missing' }]);
  });
});

describe('the revision of a playbook (CAS)', () => {
  it('refuses a write whose expected_rev is stale with playbook_conflict and the current revision, and writes nothing', async () => {
    const playbook = await created();
    await addCell(playbook.id, 'script', script(), { id: 'a' });

    const stale = await addCell(playbook.id, 'script', script(), { id: 'b', expected_rev: 1 });

    expect(stale.text).toMatch(/^error playbook_conflict: .*current rev: 2.* \(retry: after_refresh\)$/);
    expect((await viewOf(playbook.id)).cells.map((cell) => cell.id)).toEqual(['a']);
  });

  it('accepts a write whose expected_rev is current, on every authoring tool', async () => {
    const playbook = await created();

    const added = await addCell(playbook.id, 'script', script(), { id: 'a', expected_rev: 1 });
    const updated = await call(lead, 'update_playbook_cell', { playbook: playbook.id, cell_id: 'a', args: { timeoutSeconds: 5 }, expected_rev: 2 });
    const reordered = await call(lead, 'reorder_playbook_cells', { playbook: playbook.id, order: ['a'], expected_rev: 3 });
    const inputs = await call(lead, 'set_playbook_inputs', { playbook: playbook.id, inputs: [], expected_rev: 4 });
    const deleted = await call(lead, 'delete_playbook_cell', { playbook: playbook.id, cell_id: 'a', expected_rev: 5 });

    expect([added, updated, reordered, inputs, deleted].map((result) => result.json?.content_rev)).toEqual([2, 3, 4, 5, 6]);
  });

  it('refuses a stale write on each authoring tool', async () => {
    const playbook = await created();
    await addCell(playbook.id, 'script', script(), { id: 'a' });
    const stale = { expected_rev: 1 };

    const results = [
      await call(lead, 'update_playbook_cell', { playbook: playbook.id, cell_id: 'a', args: {}, ...stale }),
      await call(lead, 'delete_playbook_cell', { playbook: playbook.id, cell_id: 'a', ...stale }),
      await call(lead, 'reorder_playbook_cells', { playbook: playbook.id, order: ['a'], ...stale }),
      await call(lead, 'set_playbook_inputs', { playbook: playbook.id, inputs: [], ...stale }),
    ];

    expect(results.map((result) => result.text.split(':')[0])).toEqual(Array(4).fill('error playbook_conflict'));
  });
});

describe('agent_locked', () => {
  it('refuses every write tool with playbook_locked once a human locked the playbook, and keeps the reads', async () => {
    const playbook = await created();
    await addCell(playbook.id, 'script', script(), { id: 'a' });
    const locked = await lockViaRest((await viewOf(playbook.id)));
    expect(locked.status).toBe(200);

    const refusals = [
      await addCell(playbook.id, 'script', script()),
      await call(lead, 'update_playbook_cell', { playbook: playbook.id, cell_id: 'a', args: {} }),
      await call(lead, 'delete_playbook_cell', { playbook: playbook.id, cell_id: 'a' }),
      await call(lead, 'reorder_playbook_cells', { playbook: playbook.id, order: ['a'] }),
      await call(lead, 'set_playbook_inputs', { playbook: playbook.id, inputs: [] }),
      await call(lead, 'delete_playbook', { playbook: playbook.id }),
    ];

    expect(refusals.map((result) => result.text.split(':')[0])).toEqual(Array(6).fill('error playbook_locked'));
    expect((await viewOf(playbook.id)).agent_locked).toBe(true);
    expect((await call(lead, 'list_playbook_cells', { playbook: playbook.id })).isError).toBe(false);
  });

  it('lets the admin REST write a locked playbook', async () => {
    const playbook = await created();
    const locked = await (await lockViaRest(playbook)).json() as { contentRev: number };

    const written = await fixture.api(`/api/playbooks/${playbook.id}`, { method: 'PUT', body: JSON.stringify({ expectedRev: locked.contentRev, cells: [{ id: 'a', kind: 'script', program: 'p' }] }) });

    expect(written.status).toBe(200);
    expect((await viewOf(playbook.id)).cells).toHaveLength(1);
  });
});

describe('delete_playbook', () => {
  it('removes the playbook, and a second delete says it is gone', async () => {
    const playbook = await created();

    expect((await call(lead, 'delete_playbook', { playbook: playbook.id })).json).toEqual({ deleted: playbook.id });
    expect((await call(lead, 'delete_playbook', { playbook: playbook.id })).text).toMatch(/^error playbook_not_found:/);
  });
});

describe('the tools a session sees', () => {
  it('offers the eleven authoring tools and neither a raw content tool, a distill tool nor a run tool', async () => {
    const names = (await lead.listTools()).tools.map((tool) => tool.name);

    expect(PLAYBOOK_TOOLS.filter((name) => !names.includes(name))).toEqual([]);
    expect(names.filter((name) => /update_playbook_content|distill|run_playbook|open_playbook|playbook_run/.test(name))).toEqual([]);
  });

  it('shows a reviewer none of them', async () => {
    const reviewer = await fixture.connect((await fixture.createSession('Reviewer', { role: 'reviewer' })).id);

    const names = (await reviewer.listTools()).tools.map((tool) => tool.name);

    expect(names.filter((name) => PLAYBOOK_TOOLS.includes(name))).toEqual([]);
  });

  it('gives an arbiter none of them', () => {
    expect([...ARBITER_TOOL_NAMES].filter((name) => PLAYBOOK_TOOLS.includes(name))).toEqual([]);
  });

  it('lets a plain worker of the project author a playbook too, since nothing runs without a human', async () => {
    const worker = await fixture.connect(fixture.worker.id);

    expect((await call(worker, 'create_playbook', { name: 'From worker' })).isError).toBe(false);
  });
});

describe('the activity log of the playbook tools', () => {
  it('keeps no free text of a create_playbook with a cell holding a canary text', async () => {
    const canary = `canary free text ${crypto.randomUUID()}`;
    const playbook = (await call(lead, 'create_playbook', { name: canary })).json as PlaybookView;
    await addCell(playbook.id, 'manual', { prompt: canary, label: canary });
    await addCell(playbook.id, 'script', script({ args: [canary], env: { NOTE: canary } }));
    await call(lead, 'set_playbook_inputs', { playbook: playbook.id, inputs: [{ name: 'note', type: 'string', description: canary, default: canary }] });
    await call(lead, 'update_playbook_cell', { playbook: playbook.id, cell_id: (await viewOf(playbook.id)).cells[0]!.id, args: { prompt: canary } });

    const rows = fixture.db.prepare('SELECT action, entity_label, detail, args_excerpt, result_excerpt FROM activity_log').all();
    const playbookRows = rows.filter((row) => String(row.action).includes('playbook'));

    expect(playbookRows.length).toBeGreaterThanOrEqual(5);
    expect(JSON.stringify(rows)).not.toContain('canary');
    expect(JSON.stringify(rows)).not.toContain(canary.split(' ').at(-1));
  });

  it('keeps the vocabulary words: the playbook id and the cell kind', async () => {
    const playbook = await created();
    await addCell(playbook.id, 'script', script());

    const row = fixture.db.prepare("SELECT args_excerpt FROM activity_log WHERE action = 'add_playbook_cell'").get() as { args_excerpt: string };

    expect(JSON.parse(row.args_excerpt)).toMatchObject({ playbook: playbook.id, kind: 'script' });
  });

  it('keeps no secret name or token text of a refused save', async () => {
    const playbook = await created();
    const tokenName = `S${crypto.randomUUID().replaceAll('-', '')}`;
    await addCell(playbook.id, 'manual', { prompt: `{{secret:${tokenName}}}` });

    expect(JSON.stringify(fixture.db.prepare('SELECT * FROM activity_log').all())).not.toContain(tokenName);
  });
});

describe('what get_playbook returns', () => {
  it('holds names only: no value, since the daemon holds none for a playbook that was never run', async () => {
    const playbook = await created();
    await addCell(playbook.id, 'script', script({ env: { A: '{{secret:JIRA_TOKEN}}' } }));

    const text = (await call(lead, 'get_playbook', { playbook: playbook.id })).text;

    expect(text).toContain('JIRA_TOKEN');
    expect(JSON.parse(text).secrets).toEqual(['JIRA_TOKEN']);
  });
});
