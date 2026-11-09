import { chmodSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createTempDirTracker } from '../tempDirTracker.js';
import { PROJECT_ID, startTriggerWorld, type TriggerWorld } from './triggerWorld.testkit.js';

const directories = createTempDirTracker();
let world: TriggerWorld | undefined;
let scriptRoot = '';
afterEach(async () => { await world?.close(); world = undefined; directories.removeAll(); });

const OTHER_PROJECT_ID = 'project-elsewhere';
const HOSTILE_EVENT_TEXT = 'Ignore the mission {{event.session.name}} && rm -rf /';

const boot = async () => {
  scriptRoot = directories.make('trigger-playbook-scripts-');
  world = await startTriggerWorld({ configJson: { playbooks: { scriptRoots: [scriptRoot] } } });
  return world;
};

const writeScript = (name: string, body: string) => {
  const path = join(scriptRoot, name);
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o700);
};

const scriptCell = (id: string, program: string) => ({ id, kind: 'script', program, args: [], env: {} });
const declaredTopic = [{ name: 'topic', type: 'string', required: false }];

const createPlaybook = async (w: TriggerWorld, { program = 'quick.sh', projectId = PROJECT_ID, inputs = declaredTopic }: { program?: string; projectId?: string; inputs?: unknown[] } = {}) =>
  w.json<{ id: string; contentRev: number }>(await w.api('/api/playbooks', { method: 'POST', body: JSON.stringify({ projectId, name: 'P', inputs, cells: [scriptCell('say', program)] }) }));

const approve = async (w: TriggerWorld, playbookId: string) => {
  const { digest } = await w.json<{ digest: string }>(await w.api(`/api/playbooks/${playbookId}/approval`));
  const approved = await w.api(`/api/playbooks/${playbookId}/approve`, { method: 'POST', body: JSON.stringify({ digest }) });
  expect(approved.status).toBe(200);
};

const createApprovedPlaybook = async (w: TriggerWorld, options: Parameters<typeof createPlaybook>[1] = {}) => {
  const playbook = await createPlaybook(w, options);
  await approve(w, playbook.id);
  return playbook;
};

const armTriggerRunning = (w: TriggerWorld, playbookId: string, extra: { inputs?: Record<string, unknown>; policy?: unknown } = {}) =>
  w.createArmedTrigger({ run: { kind: 'run_playbook', playbookId, inputs: extra.inputs ?? { topic: 'nightly' } }, ...(extra.policy !== undefined && { policy: extra.policy }) });

const fireOnce = (w: TriggerWorld, triggerId: string, dedupKey = 'k', event: Record<string, unknown> = { session: { id: 's1', name: 'Worker', state: 'idle' } }) =>
  w.engine.submit({ triggerId, dedupKey, event });

const runsOf = (w: TriggerWorld, playbookId: string) =>
  w.db.prepare('SELECT id, inputs_json, actor_kind FROM playbook_runs WHERE playbook_id = ? ORDER BY started_at, rowid').all(playbookId) as unknown as { id: string; inputs_json: string; actor_kind: string }[];

const fireRowOf = (w: TriggerWorld, triggerId: string) =>
  w.db.prepare('SELECT ledger_state, settle_reason, run_id FROM trigger_fires WHERE trigger_id = ? ORDER BY fired_at, rowid').all(triggerId) as unknown as { ledger_state: string; settle_reason: string | null; run_id: string | null }[];

const settle = () => new Promise((resolve) => setImmediate(resolve));
const untilSettled = async (w: TriggerWorld, triggerId: string, fireCount: number) => {
  while (fireRowOf(w, triggerId).filter((fire) => fire.ledger_state !== 'attempted').length < fireCount) await settle();
};

const triggerOf = async (w: TriggerWorld, triggerId: string) => w.json<{ contentRev: number; armedAt: string | null }>(await w.api(`/api/triggers/${triggerId}`));
const rearm = (w: TriggerWorld, triggerId: string, approvedRev: number) =>
  w.api(`/api/triggers/${triggerId}/arm`, { method: 'POST', body: JSON.stringify({ approvedRev }), headers: { 'x-human-proof': 'proof' } });
const editPlaybook = (w: TriggerWorld, playbook: { id: string; contentRev: number }, changes: Record<string, unknown>) =>
  w.api(`/api/playbooks/${playbook.id}`, { method: 'PUT', body: JSON.stringify({ expectedRev: playbook.contentRev, ...changes }) });

describe('the RUN run_playbook starts the approved playbook the trigger names', () => {
  it('starts one run with the inputs of the trigger and links it to the fire', async () => {
    const w = await boot();
    writeScript('quick.sh', 'printf done');
    const playbook = await createApprovedPlaybook(w);
    const triggerId = await armTriggerRunning(w, playbook.id);

    const result = fireOnce(w, triggerId);

    await untilSettled(w, triggerId, 1);
    const [run] = runsOf(w, playbook.id);
    expect(result).toMatchObject({ outcome: 'fired', ledgerState: 'attempted' });
    expect(runsOf(w, playbook.id)).toHaveLength(1);
    expect(JSON.parse(run!.inputs_json)).toEqual({ topic: 'nightly' });
    expect(fireRowOf(w, triggerId)).toEqual([{ ledger_state: 'completed', settle_reason: null, run_id: run!.id }]);
  });

  it('never lets the text of the event reach the inputs of the run', async () => {
    const w = await boot();
    writeScript('quick.sh', 'printf done');
    const playbook = await createApprovedPlaybook(w);
    const triggerId = await armTriggerRunning(w, playbook.id, { inputs: { topic: '{{event.session.name}}' } });

    fireOnce(w, triggerId, 'k', { session: { id: 's1', name: HOSTILE_EVENT_TEXT, topic: HOSTILE_EVENT_TEXT } });

    await untilSettled(w, triggerId, 1);
    expect(JSON.parse(runsOf(w, playbook.id)[0]!.inputs_json)).toEqual({ topic: '{{event.session.name}}' });
    expect(JSON.stringify(w.db.prepare('SELECT * FROM playbook_runs').all())).not.toContain(HOSTILE_EVENT_TEXT);
  });

  it('writes no free text to the activity log', async () => {
    const w = await boot();
    writeScript('quick.sh', 'printf done');
    const playbook = await createApprovedPlaybook(w);
    const triggerId = await armTriggerRunning(w, playbook.id, { inputs: { topic: 'sk-live-secret-looking-value' } });

    fireOnce(w, triggerId, 'k', { session: { id: 's1', name: HOSTILE_EVENT_TEXT } });

    await untilSettled(w, triggerId, 1);
    const activity = JSON.stringify(w.db.prepare('SELECT * FROM activity_log').all());
    expect(activity).not.toContain('sk-live-secret-looking-value');
    expect(activity).not.toContain(HOSTILE_EVENT_TEXT);
  });

  it('starts one run only when the source offers the same event twice', async () => {
    const w = await boot();
    writeScript('quick.sh', 'printf done');
    const playbook = await createApprovedPlaybook(w);
    const triggerId = await armTriggerRunning(w, playbook.id);

    fireOnce(w, triggerId, 'same-event');
    const second = fireOnce(w, triggerId, 'same-event');

    await untilSettled(w, triggerId, 1);
    expect(second).toMatchObject({ outcome: 'duplicate' });
    expect(runsOf(w, playbook.id)).toHaveLength(1);
  });

  it('runs as the admin that armed it: the run table knows no other actor', async () => {
    const w = await boot();
    writeScript('quick.sh', 'printf done');
    const playbook = await createApprovedPlaybook(w);
    const triggerId = await armTriggerRunning(w, playbook.id);

    fireOnce(w, triggerId);

    await untilSettled(w, triggerId, 1);
    expect(runsOf(w, playbook.id)[0]!.actor_kind).toBe('admin');
  });
});

describe('a refusal of the runner is a typed cancellation, and no run is written', () => {
  it('cancels playbook_unapproved for a playbook no human approved', async () => {
    const w = await boot();
    writeScript('quick.sh', 'printf done');
    const playbook = await createPlaybook(w);
    const triggerId = await armTriggerRunning(w, playbook.id);

    fireOnce(w, triggerId);

    await untilSettled(w, triggerId, 1);
    expect(fireRowOf(w, triggerId)).toEqual([{ ledger_state: 'cancelled', settle_reason: 'playbook_unapproved', run_id: null }]);
    expect(runsOf(w, playbook.id)).toEqual([]);
  });

  it('cancels playbook_unapproved when a script file is no longer the approved one', async () => {
    const w = await boot();
    writeScript('quick.sh', 'printf done');
    const playbook = await createApprovedPlaybook(w);
    const triggerId = await armTriggerRunning(w, playbook.id);
    writeScript('quick.sh', 'printf swapped');

    fireOnce(w, triggerId);

    await untilSettled(w, triggerId, 1);
    expect(fireRowOf(w, triggerId)[0]).toMatchObject({ ledger_state: 'cancelled', settle_reason: 'playbook_unapproved' });
    expect(runsOf(w, playbook.id)).toEqual([]);
  });

  it('cancels playbook_unavailable for a playbook that does not exist', async () => {
    const w = await boot();
    const triggerId = await armTriggerRunning(w, 'no-such-playbook');

    fireOnce(w, triggerId);

    await untilSettled(w, triggerId, 1);
    expect(fireRowOf(w, triggerId)[0]).toMatchObject({ ledger_state: 'cancelled', settle_reason: 'playbook_unavailable' });
  });

  it('cancels playbook_unavailable for an approved playbook of another project, and starts nothing', async () => {
    const w = await boot();
    writeScript('quick.sh', 'printf done');
    w.db.prepare("INSERT INTO projects (id, name, created_at) VALUES (?, 'Elsewhere', 'now')").run(OTHER_PROJECT_ID);
    const foreign = await createApprovedPlaybook(w, { projectId: OTHER_PROJECT_ID });
    const triggerId = await armTriggerRunning(w, foreign.id);

    fireOnce(w, triggerId);

    await untilSettled(w, triggerId, 1);
    expect(fireRowOf(w, triggerId)[0]).toMatchObject({ ledger_state: 'cancelled', settle_reason: 'playbook_unavailable' });
    expect(runsOf(w, foreign.id)).toEqual([]);
  });

  it('cancels playbook_inputs_invalid for an input the playbook does not declare', async () => {
    const w = await boot();
    writeScript('quick.sh', 'printf done');
    const playbook = await createApprovedPlaybook(w);
    const triggerId = await armTriggerRunning(w, playbook.id, { inputs: { undeclared: 'x' } });

    fireOnce(w, triggerId);

    await untilSettled(w, triggerId, 1);
    expect(fireRowOf(w, triggerId)[0]).toMatchObject({ ledger_state: 'cancelled', settle_reason: 'playbook_inputs_invalid' });
    expect(runsOf(w, playbook.id)).toEqual([]);
  });

  it('cancels playbook_busy for the second fire while the playbook is still running, and keeps the first run', async () => {
    const w = await boot();
    writeScript('quick.sh', 'sleep 60');
    const playbook = await createApprovedPlaybook(w);
    const triggerId = await armTriggerRunning(w, playbook.id);

    fireOnce(w, triggerId, 'first');
    await untilSettled(w, triggerId, 1);
    fireOnce(w, triggerId, 'second');
    await untilSettled(w, triggerId, 2);

    expect(fireRowOf(w, triggerId).map((fire) => [fire.ledger_state, fire.settle_reason])).toEqual([['completed', null], ['cancelled', 'playbook_busy']]);
    expect(runsOf(w, playbook.id)).toHaveLength(1);
  });
});

describe('the engine guards apply to run_playbook as to every other RUN', () => {
  it('opens the breaker at the 31st fire of the minute, disarms the trigger and starts no run for it', async () => {
    const w = await boot();
    writeScript('quick.sh', 'printf done');
    const playbook = await createApprovedPlaybook(w);
    const triggerId = await armTriggerRunning(w, playbook.id);

    for (let index = 0; index < 31; index += 1) fireOnce(w, triggerId, `burst-${index}`);

    await untilSettled(w, triggerId, 31);
    const fires = fireRowOf(w, triggerId);
    expect(fires.at(-1)).toMatchObject({ ledger_state: 'cancelled', settle_reason: 'breaker_open' });
    expect(fires.filter((fire) => fire.ledger_state === 'completed')).toHaveLength(runsOf(w, playbook.id).length);
    expect((await triggerOf(w, triggerId)).armedAt).toBeNull();
  });

  it('holds the fire back under the cooldown without starting a run', async () => {
    const w = await boot();
    writeScript('quick.sh', 'printf done');
    const playbook = await createApprovedPlaybook(w);
    const triggerId = await armTriggerRunning(w, playbook.id, { policy: { cooldownSeconds: 600 } });

    fireOnce(w, triggerId, 'first');
    await untilSettled(w, triggerId, 1);
    fireOnce(w, triggerId, 'second');

    expect(fireRowOf(w, triggerId).map((fire) => [fire.ledger_state, fire.settle_reason])).toEqual([['completed', null], ['cancelled', 'cooldown']]);
    expect(runsOf(w, playbook.id)).toHaveLength(1);
  });
});

describe('an edit of a playbook disarms the armed triggers that run it', () => {
  it('disarms, and the trigger no longer fires, after the playbook is edited', async () => {
    const w = await boot();
    writeScript('quick.sh', 'printf done');
    const playbook = await createApprovedPlaybook(w);
    const triggerId = await armTriggerRunning(w, playbook.id);

    const edited = await editPlaybook(w, playbook, { name: 'Renamed' });

    expect(edited.status).toBe(200);
    expect((await triggerOf(w, triggerId)).armedAt).toBeNull();
    expect(fireOnce(w, triggerId)).toEqual({ outcome: 'not_armed' });
    expect(fireRowOf(w, triggerId)).toEqual([]);
    expect(runsOf(w, playbook.id)).toEqual([]);
  });

  it('disarms when a cell is edited, not only when the name changes', async () => {
    const w = await boot();
    writeScript('quick.sh', 'printf done');
    const playbook = await createApprovedPlaybook(w);
    const triggerId = await armTriggerRunning(w, playbook.id);

    const edited = await editPlaybook(w, playbook, { cells: [{ ...scriptCell('say', 'quick.sh'), args: ['--changed'] }] });

    expect(edited.status).toBe(200);
    expect((await triggerOf(w, triggerId)).armedAt).toBeNull();
  });

  it('disarms when a kept version is restored', async () => {
    const w = await boot();
    writeScript('quick.sh', 'printf done');
    const playbook = await createApprovedPlaybook(w);
    const afterEdit = await w.json<{ contentRev: number }>(await editPlaybook(w, playbook, { name: 'Second' }));
    const triggerId = await armTriggerRunning(w, playbook.id);
    expect((await triggerOf(w, triggerId)).armedAt).not.toBeNull();

    const restored = await w.api(`/api/playbooks/${playbook.id}/versions/${playbook.contentRev}/restore`, { method: 'POST', body: JSON.stringify({ expectedRev: afterEdit.contentRev }) });

    expect(restored.status).toBe(200);
    expect((await triggerOf(w, triggerId)).armedAt).toBeNull();
  });

  it('disarms when the playbook is deleted', async () => {
    const w = await boot();
    writeScript('quick.sh', 'printf done');
    const playbook = await createApprovedPlaybook(w);
    const triggerId = await armTriggerRunning(w, playbook.id);

    const deleted = await w.api(`/api/playbooks/${playbook.id}?expectedRev=${playbook.contentRev}`, { method: 'DELETE' });

    expect(deleted.status).toBe(200);
    expect((await triggerOf(w, triggerId)).armedAt).toBeNull();
  });

  it('keeps the history of the trigger: the fires it made before the edit stay', async () => {
    const w = await boot();
    writeScript('quick.sh', 'printf done');
    const playbook = await createApprovedPlaybook(w);
    const triggerId = await armTriggerRunning(w, playbook.id);
    fireOnce(w, triggerId, 'before-the-edit');
    await untilSettled(w, triggerId, 1);

    await editPlaybook(w, playbook, { name: 'Renamed' });

    expect(fireRowOf(w, triggerId)).toHaveLength(1);
    expect(fireRowOf(w, triggerId)[0]).toMatchObject({ ledger_state: 'completed' });
    expect((await triggerOf(w, triggerId)).contentRev).toBeGreaterThan(1);
  });

  it('leaves alone the triggers that run another playbook, run another kind of RUN, or are not armed', async () => {
    const w = await boot();
    writeScript('quick.sh', 'printf done');
    const edited = await createApprovedPlaybook(w);
    const other = await createApprovedPlaybook(w);
    const runsOther = await armTriggerRunning(w, other.id);
    const notifies = await w.createArmedTrigger({ run: { kind: 'notify', title: 'T', message: 'M' } });
    const alreadyDisarmed = await armTriggerRunning(w, edited.id);
    await w.api(`/api/triggers/${alreadyDisarmed}/disarm`, { method: 'POST' });
    const revBefore = (await triggerOf(w, alreadyDisarmed)).contentRev;

    await editPlaybook(w, edited, { name: 'Renamed' });

    expect((await triggerOf(w, runsOther)).armedAt).not.toBeNull();
    expect((await triggerOf(w, notifies)).armedAt).not.toBeNull();
    expect((await triggerOf(w, alreadyDisarmed)).contentRev).toBe(revBefore);
  });

  it('does not disarm when the write leaves the content alone (a lock only)', async () => {
    const w = await boot();
    writeScript('quick.sh', 'printf done');
    const playbook = await createApprovedPlaybook(w);
    const triggerId = await armTriggerRunning(w, playbook.id);

    const locked = await editPlaybook(w, playbook, { agentLocked: true });

    expect(locked.status).toBe(200);
    expect((await triggerOf(w, triggerId)).armedAt).not.toBeNull();
  });

  it('asks for a new review: arming at the revision read before the edit is refused, at the new revision it is accepted', async () => {
    const w = await boot();
    writeScript('quick.sh', 'printf done');
    const playbook = await createApprovedPlaybook(w);
    const triggerId = await armTriggerRunning(w, playbook.id);
    const revisionTheHumanReviewed = (await triggerOf(w, triggerId)).contentRev;

    await editPlaybook(w, playbook, { name: 'Renamed' });

    const staleArming = await rearm(w, triggerId, revisionTheHumanReviewed);
    const newRevision = (await triggerOf(w, triggerId)).contentRev;
    const freshArming = await rearm(w, triggerId, newRevision);
    expect(staleArming.status).toBe(409);
    expect(await staleArming.json()).toMatchObject({ error: 'stale_revision' });
    expect(freshArming.status).toBe(200);
  });

  it('tells the desktop with the error code trigger_playbook_changed, by ids only', async () => {
    const w = await boot();
    writeScript('quick.sh', 'printf done');
    const playbook = await createApprovedPlaybook(w);
    const triggerId = await armTriggerRunning(w, playbook.id);
    const socket = await w.openSocket();

    await editPlaybook(w, playbook, { name: 'A name that must not travel' });
    await settle();

    const [frame] = socket.framesOfType('error');
    expect(JSON.stringify(frame)).toContain('trigger_playbook_changed');
    expect(JSON.stringify(frame)).not.toContain('A name that must not travel');
    const activity = w.db.prepare("SELECT entity_kind, entity_id, outcome FROM activity_log WHERE action = 'trigger.disarmed_by_playbook'").all();
    expect(activity).toEqual([{ entity_kind: 'trigger', entity_id: triggerId, outcome: 'denied' }]);
  });

  it('is one transaction: a disarm that fails leaves the playbook as it was', async () => {
    const w = await boot();
    writeScript('quick.sh', 'printf done');
    const playbook = await createApprovedPlaybook(w);
    const triggerId = await armTriggerRunning(w, playbook.id);
    w.db.exec("CREATE TRIGGER refuse_disarm BEFORE UPDATE ON triggers BEGIN SELECT RAISE(ABORT, 'disarm refused'); END");

    const edited = await editPlaybook(w, playbook, { name: 'Renamed' });

    w.db.exec('DROP TRIGGER refuse_disarm');
    const unchanged = await w.json<{ name: string; contentRev: number }>(await w.api(`/api/playbooks/${playbook.id}`));
    expect(edited.status).toBeGreaterThanOrEqual(500);
    expect(unchanged).toMatchObject({ name: 'P', contentRev: playbook.contentRev });
    expect((await triggerOf(w, triggerId)).armedAt).not.toBeNull();
  });
});
