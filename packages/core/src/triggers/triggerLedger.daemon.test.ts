import { afterEach, describe, expect, it } from 'vitest';
import { MINUTE_MS, startTriggerWorld, type TriggerWorld } from './triggerWorld.testkit.js';

let world: TriggerWorld | undefined;
afterEach(async () => { await world?.close(); world = undefined; });

const SESSION_EVENT = { session: { id: 's1', name: 'Worker', state: 'closed_with_error' } };

/** A manager and a trigger that prompts it; the trigger is armed. */
const worldWithPromptingTrigger = async (policy: Record<string, unknown> = {}) => {
  world = await startTriggerWorld();
  const lead = await world.createSession('Lead', { manager: world.managerSpec });
  const triggerId = await world.createArmedTrigger({ run: { kind: 'prompt_manager', managerId: lead.id, prompt: 'A worker needs a look.' }, policy });
  return { world, lead, triggerId };
};

describe('the ledger writes ahead of every effect', () => {
  it('has inserted the fire and marked it attempted at the instant the message is queued, then completes it', async () => {
    const { world, lead, triggerId } = await worldWithPromptingTrigger();
    world.db.exec("CREATE TABLE ledger_witness (message_id TEXT, ledger_state TEXT)");
    world.db.exec("CREATE TRIGGER witness AFTER INSERT ON message_queue BEGIN INSERT INTO ledger_witness SELECT NEW.id, ledger_state FROM trigger_fires WHERE id = NEW.id; END");

    const result = world.engine.submit({ triggerId, dedupKey: 'k1', event: SESSION_EVENT });

    expect(result).toMatchObject({ outcome: 'fired', ledgerState: 'completed' });
    const [fire] = world.firesOf(triggerId);
    expect(fire).toMatchObject({ dedup_key: 'k1', ledger_state: 'completed' });
    expect(world.db.prepare('SELECT message_id, ledger_state FROM ledger_witness').all()).toEqual([{ message_id: fire!.id, ledger_state: 'attempted' }]);
    expect(world.messagesTo(lead.id).map((message) => message.id)).toEqual([fire!.id]);
  });

  it('fires once for a dedup key offered twice', async () => {
    const { world, lead, triggerId } = await worldWithPromptingTrigger();

    const first = world.engine.submit({ triggerId, dedupKey: 'same', event: SESSION_EVENT });
    const second = world.engine.submit({ triggerId, dedupKey: 'same', event: SESSION_EVENT });

    expect(first.outcome).toBe('fired');
    expect(second).toMatchObject({ outcome: 'duplicate', fireId: world.firesOf(triggerId)[0]!.id });
    expect(world.firesOf(triggerId)).toHaveLength(1);
    expect(world.messagesTo(lead.id)).toHaveLength(1);
  });

  it('keeps the dedup key after a restart: the same key is still a duplicate', async () => {
    const { world, lead, triggerId } = await worldWithPromptingTrigger();
    world.engine.submit({ triggerId, dedupKey: 'same', event: SESSION_EVENT });

    await world.restart();
    const again = world.engine.submit({ triggerId, dedupKey: 'same', event: SESSION_EVENT });

    expect(again.outcome).toBe('duplicate');
    expect(world.messagesTo(lead.id)).toHaveLength(1);
  });

  it('writes nothing for a trigger that is not armed, and nothing for an event its conditions refuse', async () => {
    world = await startTriggerWorld();
    const lead = await world.createSession('Lead', { manager: world.managerSpec });
    const created = await world.json<{ id: string }>(await world.api('/api/triggers', { method: 'POST', body: JSON.stringify({ projectId: 'project-triggers', ownerManagerId: null, run: { kind: 'prompt_manager', managerId: lead.id, prompt: 'p' } }) }));
    const armedId = await world.createArmedTrigger({
      run: { kind: 'prompt_manager', managerId: lead.id, prompt: 'p' }, conditions: [{ lhs: 'event.session.name', op: 'eq', rhs: 'Expected' }],
    });

    const unarmed = world.engine.submit({ triggerId: created.id, dedupKey: 'k', event: SESSION_EVENT });
    const refused = world.engine.submit({ triggerId: armedId, dedupKey: 'k', event: SESSION_EVENT });

    expect([unarmed.outcome, refused.outcome]).toEqual(['not_armed', 'filtered']);
    expect(world.db.prepare('SELECT COUNT(*) AS n FROM trigger_fires').get()).toEqual({ n: 0 });
    expect(world.messagesTo(lead.id)).toEqual([]);
  });

  it('cancels, with the reason, a fire whose manager is gone, and still leaves its row', async () => {
    world = await startTriggerWorld();
    const triggerId = await world.createArmedTrigger({ run: { kind: 'prompt_manager', managerId: 'no-such-session', prompt: 'p' } });

    const result = world.engine.submit({ triggerId, dedupKey: 'k', event: SESSION_EVENT });

    expect(result).toMatchObject({ outcome: 'fired', ledgerState: 'cancelled' });
    expect(world.firesOf(triggerId)[0]).toMatchObject({ ledger_state: 'cancelled', settle_reason: 'target_unavailable' });
  });
});

describe('a restart settles what the stopped daemon left', () => {
  const leaveFire = (world: TriggerWorld, triggerId: string, state: 'accepted' | 'attempted', options: { id: string; firedAtMs: number; dedupKey?: string }) =>
    world.db.prepare("INSERT INTO trigger_fires (id, trigger_id, dedup_key, ledger_state, fired_at, event_json) VALUES (?, ?, ?, ?, ?, ?)")
      .run(options.id, triggerId, options.dedupKey ?? options.id, state, new Date(options.firedAtMs).toISOString(), JSON.stringify(SESSION_EVENT));

  it('turns a fire attempted when the daemon stopped into needs_review and sends no message for it, at this boot and the next', async () => {
    const { world, lead, triggerId } = await worldWithPromptingTrigger();
    leaveFire(world, triggerId, 'attempted', { id: 'crashed-fire', firedAtMs: world.nowMs });

    await world.restart({ stoppedForMs: MINUTE_MS });
    await world.restart({ stoppedForMs: MINUTE_MS });

    expect(world.firesOf(triggerId)).toEqual([expect.objectContaining({ id: 'crashed-fire', ledger_state: 'needs_review', settle_reason: 'interrupted' })]);
    expect(world.messagesTo(lead.id)).toEqual([]);
  });

  it('does not queue a second message when a message was already queued before the stop', async () => {
    const { world, lead, triggerId } = await worldWithPromptingTrigger();
    world.engine.submit({ triggerId, dedupKey: 'k', event: SESSION_EVENT });
    const [fire] = world.firesOf(triggerId);
    world.db.prepare("UPDATE trigger_fires SET ledger_state = 'attempted', settled_at = NULL WHERE id = ?").run(fire!.id);

    await world.restart({ stoppedForMs: MINUTE_MS });

    expect(world.firesOf(triggerId)[0]).toMatchObject({ ledger_state: 'needs_review' });
    expect(world.messagesTo(lead.id)).toHaveLength(1);
  });

  it('replays an accepted fire that is within its backlog age, once, and completes it', async () => {
    const { world, lead, triggerId } = await worldWithPromptingTrigger({ backlogPolicy: 'fire_all', backlogMaxAgeMinutes: 30 });
    leaveFire(world, triggerId, 'accepted', { id: 'waiting-fire', firedAtMs: world.nowMs });

    await world.restart({ stoppedForMs: 10 * MINUTE_MS });
    await world.restart({ stoppedForMs: MINUTE_MS });

    expect(world.firesOf(triggerId)).toEqual([expect.objectContaining({ id: 'waiting-fire', ledger_state: 'completed' })]);
    expect(world.messagesTo(lead.id).map((message) => message.id)).toEqual(['waiting-fire']);
  });

  it('cancels an accepted fire older than backlogMaxAgeMinutes as stale', async () => {
    const { world, lead, triggerId } = await worldWithPromptingTrigger({ backlogPolicy: 'fire_all', backlogMaxAgeMinutes: 30 });
    leaveFire(world, triggerId, 'accepted', { id: 'old-fire', firedAtMs: world.nowMs });

    await world.restart({ stoppedForMs: 31 * MINUTE_MS });

    expect(world.firesOf(triggerId)[0]).toMatchObject({ ledger_state: 'cancelled', settle_reason: 'stale' });
    expect(world.messagesTo(lead.id)).toEqual([]);
  });

  it('replays only the newest accepted fire under fire_latest_only and cancels the others as superseded', async () => {
    const { world, lead, triggerId } = await worldWithPromptingTrigger({ backlogPolicy: 'fire_latest_only' });
    leaveFire(world, triggerId, 'accepted', { id: 'first', firedAtMs: world.nowMs });
    leaveFire(world, triggerId, 'accepted', { id: 'second', firedAtMs: world.nowMs + MINUTE_MS });
    leaveFire(world, triggerId, 'accepted', { id: 'third', firedAtMs: world.nowMs + 2 * MINUTE_MS });

    await world.restart({ stoppedForMs: 5 * MINUTE_MS });

    expect(world.firesOf(triggerId).map((fire) => [fire.id, fire.ledger_state, fire.settle_reason])).toEqual([
      ['first', 'cancelled', 'superseded'], ['second', 'cancelled', 'superseded'], ['third', 'completed', null],
    ]);
    expect(world.messagesTo(lead.id).map((message) => message.id)).toEqual(['third']);
  });

  it('replays under discard_stale only the fires of the last hour when no age is given', async () => {
    const { world, lead, triggerId } = await worldWithPromptingTrigger({ backlogPolicy: 'discard_stale' });
    leaveFire(world, triggerId, 'accepted', { id: 'old', firedAtMs: world.nowMs - 30 * MINUTE_MS });
    leaveFire(world, triggerId, 'accepted', { id: 'recent', firedAtMs: world.nowMs + 20 * MINUTE_MS });

    await world.restart({ stoppedForMs: 50 * MINUTE_MS });

    expect(world.firesOf(triggerId).map((fire) => [fire.id, fire.ledger_state])).toEqual([['old', 'cancelled'], ['recent', 'completed']]);
    expect(world.messagesTo(lead.id).map((message) => message.id)).toEqual(['recent']);
  });

  it('cancels the accepted fires of a trigger that is not armed any more as disarmed', async () => {
    const { world, lead, triggerId } = await worldWithPromptingTrigger();
    leaveFire(world, triggerId, 'accepted', { id: 'waiting-fire', firedAtMs: world.nowMs });
    await world.api(`/api/triggers/${triggerId}/disarm`, { method: 'POST', body: '{}' });

    await world.restart({ stoppedForMs: MINUTE_MS });

    expect(world.firesOf(triggerId)[0]).toMatchObject({ ledger_state: 'cancelled', settle_reason: 'disarmed' });
    expect(world.messagesTo(lead.id)).toEqual([]);
  });
});
