import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MAX_PLAYBOOK_VERSIONS } from '@openfleet/shared';
import { startGovernanceFixture, OTHER_PROJECT_ID, type GovernanceFixture } from '../governance/governanceQueue.testkit.js';
import { ARBITER_TOOL_NAMES } from './arbiterTools.js';

type Client = Awaited<ReturnType<GovernanceFixture['connect']>>;
type PlaybookView = { id: string; name: string; content_rev: number; agent_locked: boolean; origin: string; approved: boolean; inputs: { name: string }[]; cells: Record<string, any>[]; secrets: string[] };
type VersionSummary = { rev: number; name: string; sha256: string; source: string; cell_count: number; created_at: string; approved: boolean };

const VERSION_TOOLS = ['list_playbook_versions', 'get_playbook_version', 'restore_playbook_version'];
const WRITE_VERSION_TOOLS = ['restore_playbook_version'];

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
const addScript = async (playbook: PlaybookView, id: string, extra: Record<string, unknown> = {}) => {
  const current = await viewOf(playbook.id);
  return call(lead, 'add_playbook_cell', { playbook: playbook.id, kind: 'script', args: { program: 'scripts/verify.sh', ...extra }, id, expected_rev: current.content_rev });
};
const rename = async (playbook: PlaybookView, name: string) => {
  const current = await viewOf(playbook.id);
  return fixture.api(`/api/playbooks/${playbook.id}`, { method: 'PUT', body: JSON.stringify({ expectedRev: current.content_rev, name }) });
};
const versionsOf = async (playbook: string, client = lead) => (await call(client, 'list_playbook_versions', { playbook })).json as { current_content_rev: number; versions: VersionSummary[] };
const restore = async (playbook: PlaybookView, rev: number, extra: Record<string, unknown> = {}) =>
  call(lead, 'restore_playbook_version', { playbook: playbook.id, rev, expected_rev: (await viewOf(playbook.id)).content_rev, ...extra });
const approveViaSql = (playbookId: string) => fixture.db.prepare("UPDATE playbooks SET approved_digest = 'digest-1', approved_by = 'human', approved_at = 'now' WHERE id = ?").run(playbookId);
const lock = async (playbook: PlaybookView) => fixture.api(`/api/playbooks/${playbook.id}`, { method: 'PUT', body: JSON.stringify({ expectedRev: (await viewOf(playbook.id)).content_rev, agentLocked: true }) });

describe('the snapshot taken at every replacement of the content', () => {
  it('keeps the content that each edit replaces, newest first, with the revision it had', async () => {
    const playbook = await created('First');
    await addScript(playbook, 'a');
    await rename(playbook, 'Second');

    const { current_content_rev, versions } = await versionsOf(playbook.id);

    expect(current_content_rev).toBe(3);
    expect(versions.map((version) => [version.rev, version.name, version.cell_count, version.source])).toEqual([[2, 'First', 1, 'edit'], [1, 'First', 0, 'edit']]);
    expect(versions[0]!.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(versions[0]!.sha256).not.toBe(versions[1]!.sha256);
  });

  it('keeps nothing for a playbook that was never edited', async () => {
    const playbook = await created();

    expect((await versionsOf(playbook.id)).versions).toEqual([]);
  });

  it('keeps nothing when only the lock changes, since the content did not', async () => {
    const playbook = await created();

    await lock(playbook);

    expect((await versionsOf(playbook.id)).versions).toEqual([]);
  });

  it('keeps nothing for an edit that is refused', async () => {
    const playbook = await created();

    const refused = await call(lead, 'add_playbook_cell', { playbook: playbook.id, kind: 'script', args: { program: 'p', args: ['{{secret:LEAK}}'] }, expected_rev: 1 });

    expect(refused.isError).toBe(true);
    expect((await versionsOf(playbook.id)).versions).toEqual([]);
  });

  it('keeps at most the cap, dropping the oldest', async () => {
    const playbook = await created();
    for (let position = 0; position < MAX_PLAYBOOK_VERSIONS + 3; position += 1) await addScript(playbook, `c${position}`);

    const { versions } = await versionsOf(playbook.id);

    expect(versions).toHaveLength(MAX_PLAYBOOK_VERSIONS);
    expect(versions[0]!.rev).toBe(MAX_PLAYBOOK_VERSIONS + 3);
    expect(versions.at(-1)!.rev).toBe(4);
  });

  it('never purges the last version that was approved, even when it is the oldest', async () => {
    const playbook = await created();
    await addScript(playbook, 'a');
    approveViaSql(playbook.id);
    await addScript(playbook, 'b');
    for (let position = 0; position < MAX_PLAYBOOK_VERSIONS + 2; position += 1) await addScript(playbook, `c${position}`);

    const { versions } = await versionsOf(playbook.id);

    expect(versions).toHaveLength(MAX_PLAYBOOK_VERSIONS);
    expect(versions.filter((version) => version.approved).map((version) => version.rev)).toEqual([2]);
  });
});

describe('get_playbook_version', () => {
  it('returns the content of one past revision, with secret names and tokens only', async () => {
    const playbook = await created('Old');
    await addScript(playbook, 'build', { env: { TOKEN: '{{secret:JIRA_TOKEN}}' } });
    await rename(playbook, 'New');

    const { json } = await call(lead, 'get_playbook_version', { playbook: playbook.id, rev: 2 });

    expect(json).toMatchObject({ rev: 2, name: 'Old', secrets: ['JIRA_TOKEN'], inputs: [] });
    expect(json.cells[0]).toMatchObject({ id: 'build', env: { TOKEN: '{{secret:JIRA_TOKEN}}' } });
    expect(JSON.stringify(json)).not.toMatch(/api_key|password/i);
  });

  it('answers playbook_version_not_found for a revision that was never kept or was purged', async () => {
    const playbook = await created();
    await addScript(playbook, 'a');

    expect((await call(lead, 'get_playbook_version', { playbook: playbook.id, rev: 99 })).text).toMatch(/^error playbook_version_not_found:/);
    expect((await call(lead, 'get_playbook_version', { playbook: playbook.id, rev: 2 })).text).toMatch(/^error playbook_version_not_found:/);
  });

  it('does not show the versions of a playbook of another project', async () => {
    const foreign = await (await fixture.api('/api/playbooks', { method: 'POST', body: JSON.stringify({ projectId: OTHER_PROJECT_ID, name: 'Foreign' }) })).json() as { id: string };
    await fixture.api(`/api/playbooks/${foreign.id}`, { method: 'PUT', body: JSON.stringify({ expectedRev: 1, name: 'Renamed' }) });

    expect((await call(lead, 'list_playbook_versions', { playbook: foreign.id })).text).toMatch(/^error playbook_not_found:/);
    expect((await call(lead, 'get_playbook_version', { playbook: foreign.id, rev: 1 })).text).toMatch(/^error playbook_not_found:/);
    expect((await call(lead, 'restore_playbook_version', { playbook: foreign.id, rev: 1, expected_rev: 2 })).text).toMatch(/^error playbook_not_found:/);
  });

  it('can be read on a playbook locked to agents', async () => {
    const playbook = await created();
    await addScript(playbook, 'a');
    await lock(playbook);

    expect((await call(lead, 'list_playbook_versions', { playbook: playbook.id })).isError).toBe(false);
    expect((await call(lead, 'get_playbook_version', { playbook: playbook.id, rev: 1 })).isError).toBe(false);
  });
});

describe('restore_playbook_version', () => {
  it('puts the old content back as a new revision, snapshots the current content first, and keeps the history', async () => {
    const playbook = await created('Original');
    await addScript(playbook, 'a');
    await rename(playbook, 'Edited');
    const before = await versionsOf(playbook.id);

    const restored = (await restore(playbook, 2)).json as PlaybookView;
    const after = await versionsOf(playbook.id);

    expect(restored).toMatchObject({ name: 'Original', content_rev: 4, origin: 'agent' });
    expect(restored.cells.map((cell) => cell.id)).toEqual(['a']);
    expect(after.versions.map((version) => [version.rev, version.source])).toEqual([[3, 'restore'], ...before.versions.map((version): [number, string] => [version.rev, version.source])]);
    expect(after.versions.find((version) => version.rev === 3)!.name).toBe('Edited');
  });

  it('invalidates the approval: the restored content is inert until a human approves its digest', async () => {
    const playbook = await created();
    await addScript(playbook, 'a');
    await addScript(playbook, 'b');
    approveViaSql(playbook.id);
    expect((await viewOf(playbook.id)).approved).toBe(true);

    await restore(playbook, 2);

    expect((await viewOf(playbook.id)).approved).toBe(false);
    expect(fixture.db.prepare('SELECT approved_digest, approved_by, approved_at FROM playbooks WHERE id = ?').get(playbook.id)).toEqual({ approved_digest: null, approved_by: null, approved_at: null });
  });

  it('requires expected_rev and refuses a stale one with playbook_conflict, writing nothing', async () => {
    const playbook = await created();
    await addScript(playbook, 'a');
    const before = await viewOf(playbook.id);

    const missing = await call(lead, 'restore_playbook_version', { playbook: playbook.id, rev: 1 });
    const stale = await call(lead, 'restore_playbook_version', { playbook: playbook.id, rev: 1, expected_rev: 1 });

    expect(missing.isError).toBe(true);
    expect(missing.text).toMatch(/expected_rev/);
    expect(stale.text).toMatch(/^error playbook_conflict: .*current rev: 2/);
    expect(await viewOf(playbook.id)).toEqual(before);
  });

  it('refuses a revision that is not kept', async () => {
    const playbook = await created();

    expect((await restore(playbook, 7)).text).toMatch(/^error playbook_version_not_found:/);
  });

  it('is refused with playbook_locked on a locked playbook, and allowed to the admin REST', async () => {
    const playbook = await created();
    await addScript(playbook, 'a');
    await lock(playbook);

    const refused = await restore(playbook, 1);
    const throughRest = await fixture.api(`/api/playbooks/${playbook.id}/versions/1/restore`, { method: 'POST', body: JSON.stringify({ expectedRev: (await viewOf(playbook.id)).content_rev }) });

    expect(refused.text).toMatch(/^error playbook_locked:/);
    expect(throughRest.status).toBe(200);
  });

  it('runs the same validation as a write: a version that the rules now refuse is not restored', async () => {
    const playbook = await created();
    await addScript(playbook, 'a');
    await addScript(playbook, 'b');
    fixture.db.prepare("UPDATE playbook_versions SET flow_json = ? WHERE playbook_id = ? AND rev = 2").run(JSON.stringify({ cells: [{ id: 'a', kind: 'manual', prompt: '{{secret:LEAK}}' }] }), playbook.id);
    const before = await viewOf(playbook.id);

    const refused = await restore(playbook, 2);

    expect(refused.text).toMatch(/^error secret_not_allowed_here:/);
    expect(await viewOf(playbook.id)).toEqual(before);
  });

  it('keeps the secret declarations equal to the secrets of the restored content', async () => {
    const playbook = await created();
    await addScript(playbook, 'a', { env: { A: '{{secret:OLD_KEY}}' } });
    const current = await viewOf(playbook.id);
    await call(lead, 'update_playbook_cell', { playbook: playbook.id, cell_id: 'a', args: { env: { A: '{{secret:NEW_KEY}}' } }, expected_rev: current.content_rev });

    await restore(playbook, 2);

    expect((await viewOf(playbook.id)).secrets).toEqual(['OLD_KEY']);
    expect(fixture.db.prepare("SELECT name FROM secret_refs WHERE scope_id = ? ORDER BY name").all(playbook.id)).toEqual([{ name: 'OLD_KEY' }]);
  });
});

describe('the REST versions of a playbook', () => {
  it('lists, reads and restores a version behind the admin token', async () => {
    const playbook = await created('Original');
    await rename(playbook, 'Edited');

    const listed = await (await fixture.api(`/api/playbooks/${playbook.id}/versions`)).json() as { versions: VersionSummary[] };
    const read = await (await fixture.api(`/api/playbooks/${playbook.id}/versions/1`)).json() as { name: string };
    const restored = await fixture.api(`/api/playbooks/${playbook.id}/versions/1/restore`, { method: 'POST', body: JSON.stringify({ expectedRev: 2 }) });

    expect(listed.versions.map((version) => version.rev)).toEqual([1]);
    expect(read.name).toBe('Original');
    expect(restored.status).toBe(200);
    expect((await viewOf(playbook.id)).name).toBe('Original');
  });

  it('answers 409 playbook_conflict to a stale restore and 404 to a revision that is not kept', async () => {
    const playbook = await created();
    await rename(playbook, 'Edited');

    const stale = await fixture.api(`/api/playbooks/${playbook.id}/versions/1/restore`, { method: 'POST', body: JSON.stringify({ expectedRev: 1 }) });
    const unknown = await fixture.api(`/api/playbooks/${playbook.id}/versions/9`);

    expect(stale.status).toBe(409);
    expect(unknown.status).toBe(404);
  });
});

describe('the tools a session sees', () => {
  it('offers the three version tools to a manager, and none to a reviewer or an arbiter', async () => {
    const reviewer = await fixture.connect((await fixture.createSession('Reviewer', { role: 'reviewer' })).id);

    const managerNames = (await lead.listTools()).tools.map((tool) => tool.name);
    const reviewerNames = (await reviewer.listTools()).tools.map((tool) => tool.name);

    expect(VERSION_TOOLS.filter((name) => !managerNames.includes(name))).toEqual([]);
    expect(reviewerNames.filter((name) => VERSION_TOOLS.includes(name))).toEqual([]);
    expect([...ARBITER_TOOL_NAMES].filter((name) => VERSION_TOOLS.includes(name) || WRITE_VERSION_TOOLS.includes(name))).toEqual([]);
  });
});

describe('the activity log of the version tools', () => {
  it('keeps the ids and the revision of a restore and no free text', async () => {
    const canary = `canary ${crypto.randomUUID()}`;
    const playbook = await created(canary);
    await addScript(playbook, 'a', { label: canary });
    await restore(playbook, 1);

    const rows = fixture.db.prepare('SELECT action, args_excerpt, result_excerpt, detail, entity_label FROM activity_log').all();

    expect(rows.some((row) => row.action === 'restore_playbook_version')).toBe(true);
    expect(JSON.stringify(rows)).not.toContain('canary');
  });
});
