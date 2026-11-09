import { afterEach, describe, expect, it } from 'vitest';
import { startGovernanceFixture, OWN_PROJECT_ID, type GovernanceFixture } from '../governance/governanceQueue.testkit.js';
import { canonicalDigestOf } from '../playbooks/kernel/canonicalDigest.js';
import type { HumanProofVerifier } from '../triggers/humanProofVerifier.js';

type RestTrigger = {
  id: string; contentRev: number; armedAt: string | null; approvedRev: number | null; approvedGraphDigest: string | null; reviewDigest?: string;
  ownerManagerId: string | null; when: unknown; conditions: unknown[]; run: unknown; policy: unknown;
};

const everyProofIsAccepted: HumanProofVerifier = { consume: () => true };

let fixture: GovernanceFixture | undefined;
afterEach(async () => { await fixture?.close(); fixture = undefined; });

const boot = async () => {
  fixture = await startGovernanceFixture({ humanProof: everyProofIsAccepted });
  return fixture;
};
const jsonOf = async <T = RestTrigger>(response: Response) => await response.json() as T;
const createTrigger = async (f: GovernanceFixture) =>
  jsonOf(await f.api('/api/triggers', { method: 'POST', body: JSON.stringify({ projectId: OWN_PROJECT_ID, ownerManagerId: null, title: 'Digest' }) }));
const read = async (f: GovernanceFixture, id: string) => jsonOf(await f.api(`/api/triggers/${id}`));
const replace = (f: GovernanceFixture, id: string, expectedRev: number, content: object) =>
  f.api(`/api/triggers/${id}`, { method: 'PUT', body: JSON.stringify({ expectedRev, ...content }) });
const arm = async (f: GovernanceFixture, id: string, approvedRev: number) =>
  jsonOf(await f.api(`/api/triggers/${id}/arm`, { method: 'POST', body: JSON.stringify({ approvedRev }), headers: { 'x-human-proof': 'a-human-gesture' } }));
const listed = async (f: GovernanceFixture) => jsonOf<RestTrigger[]>(await f.api(`/api/triggers?projectId=${OWN_PROJECT_ID}`));

const CONTENT_EDITS: [string, (f: GovernanceFixture) => object][] = [
  ['the owner', (f) => ({ ownerManagerId: f.lead.id })],
  ['the source of the WHEN', () => ({ when: { source: 'silent_run', minutes: 20 } })],
  ['a condition', () => ({ conditions: [{ lhs: 'event.session.state', op: 'eq', rhs: 'idle' }] })],
  ['the target of the RUN', () => ({ run: { kind: 'close_session', sessionId: 'another-session' } })],
  ['the playbook the RUN launches', () => ({ run: { kind: 'run_playbook', playbookId: 'another-playbook' } })],
  ['the policy', () => ({ policy: { cooldownSeconds: 30 } })],
];

describe('the review digest of a trigger, read before arming', () => {
  it('is the digest that arming records, on the content as it stands', async () => {
    const f = await boot();
    const trigger = await createTrigger(f);

    const digestBeforeArming = (await read(f, trigger.id)).reviewDigest;
    const armed = await arm(f, trigger.id, 1);

    expect(digestBeforeArming).toBe(armed.approvedGraphDigest);
    expect(digestBeforeArming).toBe(canonicalDigestOf({ ownerManagerId: armed.ownerManagerId, when: armed.when, conditions: armed.conditions, run: armed.run, policy: armed.policy }));
  });

  it('is on the list and on the detail alike', async () => {
    const f = await boot();
    const trigger = await createTrigger(f);

    const [inTheList] = await listed(f);
    const inTheDetail = await read(f, trigger.id);

    expect(inTheList?.reviewDigest).toEqual(expect.any(String));
    expect(inTheList?.reviewDigest).toBe(inTheDetail.reviewDigest);
  });

  it('stays equal to the approved digest of an armed trigger read again', async () => {
    const f = await boot();
    const trigger = await createTrigger(f);
    await arm(f, trigger.id, 1);

    const [armedInTheList] = await listed(f);

    expect(armedInTheList?.reviewDigest).toBe(armedInTheList?.approvedGraphDigest);
  });

  it.each(CONTENT_EDITS)('changes when %s changes', async (_name, editOf) => {
    const f = await boot();
    const trigger = await createTrigger(f);
    const digestBefore = (await read(f, trigger.id)).reviewDigest;

    const replaced = await replace(f, trigger.id, 1, editOf(f));
    const digestAfter = (await read(f, trigger.id)).reviewDigest;

    expect(replaced.status).toBe(200);
    expect(digestAfter).toEqual(expect.any(String));
    expect(digestAfter).not.toBe(digestBefore);
  });

  it('differs from the approved digest once the armed trigger is edited, then matches the next arming', async () => {
    const f = await boot();
    const trigger = await createTrigger(f);
    const armed = await arm(f, trigger.id, 1);

    await replace(f, trigger.id, 1, { policy: { cooldownSeconds: 30 } });
    const edited = await read(f, trigger.id);
    const rearmed = await arm(f, trigger.id, 2);

    expect(edited.reviewDigest).not.toBe(armed.approvedGraphDigest);
    expect(rearmed.approvedGraphDigest).toBe(edited.reviewDigest);
  });

  it('ignores the title, which no arming approves', async () => {
    const f = await boot();
    const trigger = await createTrigger(f);
    const digestBefore = (await read(f, trigger.id)).reviewDigest;

    await replace(f, trigger.id, 1, { title: 'Renamed' });

    expect((await read(f, trigger.id)).reviewDigest).toBe(digestBefore);
  });

  it('is read only: reading changes neither the revision nor the arming', async () => {
    const f = await boot();
    const trigger = await createTrigger(f);
    const armed = await arm(f, trigger.id, 1);

    await read(f, trigger.id);
    await listed(f);
    const afterReading = await read(f, trigger.id);

    expect(afterReading).toMatchObject({ contentRev: armed.contentRev, armedAt: armed.armedAt, approvedRev: armed.approvedRev, approvedGraphDigest: armed.approvedGraphDigest });
  });

  it('writes nothing to the activity log when read', async () => {
    const f = await boot();
    const trigger = await createTrigger(f);
    const rowsBefore = f.db.prepare('SELECT COUNT(*) AS count FROM activity_log').get();

    await read(f, trigger.id);
    await listed(f);

    expect(f.db.prepare('SELECT COUNT(*) AS count FROM activity_log').get()).toEqual(rowsBefore);
  });

  it('is absent for a deleted trigger and for one that never existed', async () => {
    const f = await boot();
    const trigger = await createTrigger(f);
    await f.api(`/api/triggers/${trigger.id}`, { method: 'DELETE' });

    const deleted = await f.api(`/api/triggers/${trigger.id}`);
    const neverExisted = await f.api('/api/triggers/never-existed');

    expect([deleted.status, neverExisted.status]).toEqual([404, 404]);
    expect(await deleted.json()).not.toHaveProperty('reviewDigest');
    expect(await neverExisted.json()).not.toHaveProperty('reviewDigest');
    expect(await listed(f)).toEqual([]);
  });
});
