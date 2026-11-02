import { afterEach, describe, expect, it } from 'vitest';
import { startGovernanceFixture, OWN_PROJECT_ID, type GovernanceFixture } from '../governance/governanceQueue.testkit.js';
import { canonicalDigestOf } from '../playbooks/kernel/canonicalDigest.js';
import type { HumanProofVerifier } from '../triggers/humanProofVerifier.js';

type RestTrigger = {
  id: string; projectId: string; ownerManagerId: string | null; title: string; contentRev: number; armedAt: string | null; approvedRev: number | null; approvedGraphDigest: string | null;
  when: unknown; conditions: unknown[]; run: unknown; policy: unknown;
};

const PROOF_HEADER = 'x-human-proof';
const proofFor = (triggerId: string) => `proof-for-${triggerId}`;

/** Accepts the proof minted for one trigger, once. */
const singleUseProofs = (): HumanProofVerifier => {
  const spent = new Set<string>();
  return {
    consume: (proof, { triggerId }) => {
      const isMinted = proof !== undefined && proof.startsWith(proofFor(triggerId)) && !spent.has(proof);
      if (isMinted) spent.add(proof);
      return isMinted;
    },
  };
};

let fixture: GovernanceFixture | undefined;
afterEach(async () => { await fixture?.close(); fixture = undefined; });

const boot = async (humanProof?: HumanProofVerifier) => {
  fixture = await startGovernanceFixture(humanProof === undefined ? {} : { humanProof });
  return fixture;
};
const jsonOf = async <T = RestTrigger>(response: Response) => await response.json() as T;
const createTrigger = async (f: GovernanceFixture, title = 'T1', ownerManagerId: string | null = null) =>
  jsonOf(await f.api('/api/triggers', { method: 'POST', body: JSON.stringify({ projectId: OWN_PROJECT_ID, ownerManagerId, title }) }));
const NO_PROOF = null;
const arm = (f: GovernanceFixture, id: string, approvedRev: number, proof: string | null = proofFor(id)) =>
  f.api(`/api/triggers/${id}/arm`, { method: 'POST', body: JSON.stringify({ approvedRev }), headers: proof === NO_PROOF ? {} : { [PROOF_HEADER]: proof } });
const fetchWith = (f: GovernanceFixture, path: string, authorization?: string, init: RequestInit = {}) =>
  fetch(`${f.daemon.server.url}${path}`, { ...init, headers: { 'content-type': 'application/json', ...(authorization === undefined ? {} : { authorization }) } });
const mcpTokenOf = (f: GovernanceFixture, sessionId: string) => (f.db.prepare('SELECT mcp_token FROM sessions WHERE id = ?').get(sessionId) as { mcp_token: string }).mcp_token;

describe('the trigger routes are behind the admin token', () => {
  it.each([
    ['GET', `/api/triggers?projectId=${OWN_PROJECT_ID}`],
    ['POST', '/api/triggers'],
    ['GET', '/api/triggers/x'],
    ['PUT', '/api/triggers/x'],
    ['DELETE', '/api/triggers/x'],
    ['POST', '/api/triggers/x/arm'],
    ['POST', '/api/triggers/x/disarm'],
  ])('answers 401 to %s %s with no token and with the MCP token of a session', async (method, path) => {
    const f = await boot(singleUseProofs());

    const withoutToken = await fetchWith(f, path, undefined, { method, body: method === 'GET' ? undefined : '{}' });
    const withSessionToken = await fetchWith(f, path, `Bearer ${mcpTokenOf(f, f.lead.id)}`, { method, body: method === 'GET' ? undefined : '{}' });

    expect([withoutToken.status, withSessionToken.status]).toEqual([401, 401]);
  });
});

describe('the CRUD of triggers', () => {
  it('creates, lists, reads, replaces with a revision and deletes', async () => {
    const f = await boot();
    const trigger = await createTrigger(f);

    const listed = await jsonOf<RestTrigger[]>(await f.api(`/api/triggers?projectId=${OWN_PROJECT_ID}`));
    const read = await jsonOf(await f.api(`/api/triggers/${trigger.id}`));
    const replaced = await jsonOf(await f.api(`/api/triggers/${trigger.id}`, { method: 'PUT', body: JSON.stringify({ expectedRev: 1, title: 'Renamed', when: { source: 'silent_run', minutes: 20 }, policy: { cooldownSeconds: 30 } }) }));
    const deleted = await f.api(`/api/triggers/${trigger.id}`, { method: 'DELETE' });

    expect(trigger).toMatchObject({ projectId: OWN_PROJECT_ID, title: 'T1', contentRev: 1, armedAt: null, approvedRev: null, approvedGraphDigest: null });
    expect(listed.map((listedTrigger) => listedTrigger.id)).toEqual([trigger.id]);
    expect(read).toEqual(trigger);
    expect(replaced).toMatchObject({ title: 'Renamed', contentRev: 2, when: { source: 'silent_run', minutes: 20 }, policy: { cooldownSeconds: 30, batchMode: 'per_event', backlogPolicy: 'fire_all' } });
    expect(deleted.status).toBe(200);
    expect((await f.api(`/api/triggers/${trigger.id}`)).status).toBe(404);
  });

  it('needs the owner of a trigger, a manager id or null, at creation', async () => {
    const f = await boot();
    const create = (body: object) => f.api('/api/triggers', { method: 'POST', body: JSON.stringify({ projectId: OWN_PROJECT_ID, ...body }) });

    const withoutOwner = await create({});
    const withBlankOwner = await create({ ownerManagerId: '' });
    const withOwner = await create({ ownerManagerId: f.lead.id });
    const withNullOwner = await create({ ownerManagerId: null });

    expect([withoutOwner.status, withBlankOwner.status, withOwner.status, withNullOwner.status]).toEqual([400, 400, 201, 201]);
    expect(await jsonOf(withOwner)).toMatchObject({ ownerManagerId: f.lead.id });
    expect(await jsonOf(withNullOwner)).toMatchObject({ ownerManagerId: null });
  });

  it('changing the owner of an armed trigger bumps the revision and clears the arming', async () => {
    const f = await boot(singleUseProofs());
    const trigger = await createTrigger(f, 'T1', f.lead.id);
    const armed = await jsonOf(await arm(f, trigger.id, 1));

    const replaced = await jsonOf(await f.api(`/api/triggers/${trigger.id}`, { method: 'PUT', body: JSON.stringify({ expectedRev: 1, ownerManagerId: null }) }));

    expect(armed.armedAt).toEqual(expect.any(String));
    expect(replaced).toMatchObject({ ownerManagerId: null, contentRev: 2, armedAt: null, approvedGraphDigest: null });
  });

  it('answers 409 stale_revision to a replacement made on an old revision', async () => {
    const f = await boot();
    const trigger = await createTrigger(f);
    await f.api(`/api/triggers/${trigger.id}`, { method: 'PUT', body: JSON.stringify({ expectedRev: 1, title: 'A' }) });

    const stale = await f.api(`/api/triggers/${trigger.id}`, { method: 'PUT', body: JSON.stringify({ expectedRev: 1, title: 'B' }) });

    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ error: 'stale_revision' });
  });

  it('answers 400 to a WHEN of an unknown source, to a wrong prefix and to 33 conditions', async () => {
    const f = await boot();
    const trigger = await createTrigger(f);
    const put = (body: object) => f.api(`/api/triggers/${trigger.id}`, { method: 'PUT', body: JSON.stringify({ expectedRev: 1, ...body }) });
    const conditions = (count: number) => Array.from({ length: count }, (_, position) => ({ lhs: `event.session.f${position}`, op: 'eq', rhs: 'x' }));

    const webhook = await put({ when: { source: 'webhook' } });
    const wrongPrefix = await put({ when: { source: 'data_store_query', storeId: 's', event: 'new_matching_rows' }, conditions: [{ lhs: 'event.record.x', op: 'eq', rhs: 'x' }] });
    const tooMany = await put({ conditions: conditions(33) });
    const cap = await put({ conditions: conditions(32) });

    expect(webhook.status).toBe(400);
    expect(await wrongPrefix.json()).toMatchObject({ error: 'trigger_field_prefix' });
    expect(await tooMany.json()).toMatchObject({ error: 'too_many_conditions' });
    expect(cap.status).toBe(200);
  });
});

describe('arming', () => {
  it('arms with the proof of a human: records the approved revision and the canonical digest of when, conditions, run and policy', async () => {
    const f = await boot(singleUseProofs());
    const trigger = await createTrigger(f);

    const response = await arm(f, trigger.id, 1);
    const armed = await jsonOf(response);

    expect(response.status).toBe(200);
    expect(armed.armedAt).toEqual(expect.any(String));
    expect(armed.approvedRev).toBe(1);
    expect(armed.approvedGraphDigest).toBe(canonicalDigestOf({ ownerManagerId: armed.ownerManagerId, when: armed.when, conditions: armed.conditions, run: armed.run, policy: armed.policy }));
  });

  it.each([
    ['no proof', NO_PROOF],
    ['a proof minted for another trigger', 'proof-for-someone-else'],
    ['an empty proof', ''],
  ])('answers 401 human_proof_required with %s and leaves the trigger unarmed', async (_name, proof) => {
    const f = await boot(singleUseProofs());
    const trigger = await createTrigger(f);

    const response = await arm(f, trigger.id, 1, proof);

    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ error: 'human_proof_required' });
    expect((await jsonOf(await f.api(`/api/triggers/${trigger.id}`))).armedAt).toBeNull();
  });

  it('spends the proof: the same proof arms nothing a second time', async () => {
    const f = await boot(singleUseProofs());
    const trigger = await createTrigger(f);
    await arm(f, trigger.id, 1);
    await f.api(`/api/triggers/${trigger.id}/disarm`, { method: 'POST', body: '{}' });

    const again = await arm(f, trigger.id, 1);

    expect(again.status).toBe(401);
  });

  it('refuses every arming when the daemon has no verifier of human proof', async () => {
    const f = await boot();
    const trigger = await createTrigger(f);

    const response = await arm(f, trigger.id, 1, proofFor(trigger.id));

    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ error: 'human_proof_required' });
  });

  it('answers 409 stale_revision when the approved revision is not the current one', async () => {
    const f = await boot(singleUseProofs());
    const trigger = await createTrigger(f);
    await f.api(`/api/triggers/${trigger.id}`, { method: 'PUT', body: JSON.stringify({ expectedRev: 1, title: 'Edited' }) });

    const response = await arm(f, trigger.id, 1);

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: 'stale_revision' });
  });

  it('disarms with the admin token alone, and disarming an unarmed trigger is harmless', async () => {
    const f = await boot(singleUseProofs());
    const trigger = await createTrigger(f);
    await arm(f, trigger.id, 1);

    const disarmed = await jsonOf(await f.api(`/api/triggers/${trigger.id}/disarm`, { method: 'POST', body: '{}' }));
    const again = await f.api(`/api/triggers/${trigger.id}/disarm`, { method: 'POST', body: '{}' });

    expect(disarmed).toMatchObject({ armedAt: null, approvedRev: null, approvedGraphDigest: null });
    expect(again.status).toBe(200);
  });

  it('gives a different digest to a different content', async () => {
    const f = await boot(singleUseProofs());
    const first = await createTrigger(f, 'First');
    const second = await createTrigger(f, 'Second');
    await f.api(`/api/triggers/${second.id}`, { method: 'PUT', body: JSON.stringify({ expectedRev: 1, policy: { cooldownSeconds: 5 } }) });

    const firstArmed = await jsonOf(await arm(f, first.id, 1));
    const secondArmed = await jsonOf(await arm(f, second.id, 2));

    expect(firstArmed.approvedGraphDigest).not.toBe(secondArmed.approvedGraphDigest);
  });

  it('records the arming as an action of the human in the activity log', async () => {
    const f = await boot(singleUseProofs());
    const trigger = await createTrigger(f);

    await arm(f, trigger.id, 1);

    expect(f.db.prepare("SELECT actor_kind, source, entity_kind, entity_id, outcome FROM activity_log WHERE action = 'trigger.arm'").all()).toEqual([
      { actor_kind: 'human', source: 'rest', entity_kind: 'trigger', entity_id: trigger.id, outcome: 'ok' },
    ]);
  });
});

describe('an edit clears the arming', () => {
  const EDITS: [string, (id: string) => { name: string; arguments: Record<string, unknown> }][] = [
    ['set_trigger_when', (id) => ({ name: 'set_trigger_when', arguments: { trigger: id, kind: 'silent_run', args: { minutes: 7 } } })],
    ['set_trigger_run', (id) => ({ name: 'set_trigger_run', arguments: { trigger: id, kind: 'notify', args: { title: 'a', message: 'b' } } })],
    ['set_trigger_policy', (id) => ({ name: 'set_trigger_policy', arguments: { trigger: id, cooldown_seconds: 9 } })],
    ['add_trigger_condition', (id) => ({ name: 'add_trigger_condition', arguments: { trigger: id, lhs: 'event.session.name', op: 'exists' } })],
  ];

  it.each(EDITS)('%s', async (_name, edit) => {
    const f = await boot(singleUseProofs());
    const trigger = await createTrigger(f);
    expect((await arm(f, trigger.id, 1)).status).toBe(200);
    const lead = await f.connect(f.lead.id);

    const result = await lead.callTool(edit(trigger.id));

    const after = await jsonOf(await f.api(`/api/triggers/${trigger.id}`));
    expect(result.isError).toBeFalsy();
    expect(after).toMatchObject({ contentRev: 2, armedAt: null, approvedRev: null, approvedGraphDigest: null });
  });

  it('update_trigger_condition and delete_trigger_condition', async () => {
    const f = await boot(singleUseProofs());
    const trigger = await createTrigger(f);
    const lead = await f.connect(f.lead.id);
    const added = JSON.parse(((await lead.callTool({ name: 'add_trigger_condition', arguments: { trigger: trigger.id, lhs: 'event.session.name', op: 'exists' } })).content as { text: string }[])[0]!.text);
    const conditionId = added.conditions[0].id as string;
    for (const [name, args] of [['update_trigger_condition', { op: 'not_exists' }], ['delete_trigger_condition', {}]] as const) {
      const current = await jsonOf(await f.api(`/api/triggers/${trigger.id}`));
      expect((await arm(f, trigger.id, current.contentRev, `${proofFor(trigger.id)}#${name}`)).status).toBe(200);

      await lead.callTool({ name, arguments: { trigger: trigger.id, condition_id: conditionId, ...args } });

      expect(await jsonOf(await f.api(`/api/triggers/${trigger.id}`))).toMatchObject({ armedAt: null, approvedGraphDigest: null });
    }
  });

  it('a REST replacement', async () => {
    const f = await boot(singleUseProofs());
    const trigger = await createTrigger(f);
    await arm(f, trigger.id, 1);

    const replaced = await jsonOf(await f.api(`/api/triggers/${trigger.id}`, { method: 'PUT', body: JSON.stringify({ expectedRev: 1, title: 'Edited' }) }));

    expect(replaced).toMatchObject({ armedAt: null, approvedRev: null, approvedGraphDigest: null });
  });

  it('is visible to an agent: get_trigger says armed false after the edit', async () => {
    const f = await boot(singleUseProofs());
    const trigger = await createTrigger(f);
    await arm(f, trigger.id, 1);
    const lead = await f.connect(f.lead.id);
    const armedView = JSON.parse(((await lead.callTool({ name: 'get_trigger', arguments: { trigger: trigger.id } })).content as { text: string }[])[0]!.text);

    await lead.callTool({ name: 'set_trigger_policy', arguments: { trigger: trigger.id, cooldown_seconds: 1 } });
    const editedView = JSON.parse(((await lead.callTool({ name: 'get_trigger', arguments: { trigger: trigger.id } })).content as { text: string }[])[0]!.text);

    expect([armedView.armed, editedView.armed]).toEqual([true, false]);
  });
});
