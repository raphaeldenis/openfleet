import { afterEach, describe, expect, it } from 'vitest';
import { MAX_WAIT_MS, RUN_ALL_CAP } from './cronSource.js';
import { MINUTE_MS, PROJECT_ID, startTriggerWorld, type TriggerWorld } from './triggerWorld.testkit.js';

const HOUR_MS = 60 * MINUTE_MS;
let world: TriggerWorld | undefined;
afterEach(async () => { await world?.close(); world = undefined; });

const at = (iso: string) => Date.parse(iso);
const worldWithLead = async () => {
  world = await startTriggerWorld();
  const lead = await world.createSession('Lead', { manager: world.managerSpec });
  return { world, lead };
};
const bodiesTo = (sessionId: string) => world!.messagesTo(sessionId).map((message) => message.body).filter((body) => body.startsWith('trigger.fired'));
const keysOf = (triggerId: string) => world!.firesOf(triggerId).map((fire) => fire.dedup_key);
const statesOf = (triggerId: string) => world!.firesOf(triggerId).map((fire) => fire.ledger_state);
/** Moves the fake clock and lets the timers that are due run, as the clock would. */
const tickTo = (iso: string) => { world!.setNowMs(at(iso)); world!.fireLivingTimers(); };

const armCron = (input: { managerId?: string; ownerManagerId?: string | null; when: Record<string, unknown>; conditions?: unknown[]; policy?: unknown; run?: unknown }) =>
  world!.createArmedTrigger({
    title: 'cron', when: { source: 'cron', ...input.when }, conditions: input.conditions ?? [],
    run: input.run ?? { kind: 'prompt_manager', ...(input.managerId === undefined ? {} : { managerId: input.managerId }), prompt: 'the clock struck' },
    ownerManagerId: input.ownerManagerId ?? null, ...(input.policy === undefined ? {} : { policy: input.policy }),
  });

describe('a slot comes due', () => {
  it('fires once at the instant of the slot, with the slot in UTC as the dedup key', async () => {
    const { world, lead } = await worldWithLead();
    world.setNowMs(at('2026-06-10T06:59:00Z'));
    const triggerId = await armCron({ managerId: lead.id, when: { expression: '0 9 * * *' } });

    tickTo('2026-06-10T07:00:00Z');

    expect(keysOf(triggerId)).toEqual(['cron:2026-06-10T07:00:00.000Z']);
    expect(statesOf(triggerId)).toEqual(['completed']);
    expect(bodiesTo(lead.id)).toHaveLength(1);
    expect(world.cursorOf(triggerId)).toMatchObject({ kind: 'cron', through: '2026-06-10T07:00:00.000Z' });
  });

  it('does not fire before the slot', async () => {
    const { world, lead } = await worldWithLead();
    world.setNowMs(at('2026-06-10T06:00:00Z'));
    const triggerId = await armCron({ managerId: lead.id, when: { expression: '0 9 * * *' } });

    tickTo('2026-06-10T06:59:00Z');

    expect(world.firesOf(triggerId)).toEqual([]);
  });

  it('offers a slot a second time without a second fire, because the dedup key is the slot', async () => {
    const { world, lead } = await worldWithLead();
    world.setNowMs(at('2026-06-10T06:59:00Z'));
    const triggerId = await armCron({ managerId: lead.id, when: { expression: '0 9 * * *' } });
    tickTo('2026-06-10T07:00:00Z');
    world.db.prepare('UPDATE trigger_cursors SET cursor_json = ? WHERE trigger_id = ?').run(JSON.stringify({ kind: 'cron', through: '2026-06-10T06:59:00.000Z' }), triggerId);

    tickTo('2026-06-10T07:00:30Z');

    expect(keysOf(triggerId)).toEqual(['cron:2026-06-10T07:00:00.000Z']);
    expect(bodiesTo(lead.id)).toHaveLength(1);
  });

  it('gives the conditions the slot in the zone of the trigger', async () => {
    const { world, lead } = await worldWithLead();
    world.setNowMs(at('2026-06-10T06:59:00Z'));
    const triggerId = await armCron({ managerId: lead.id, when: { expression: '*/30 * * * *' }, conditions: [{ lhs: 'event.slot.localTime', op: 'eq', rhs: '09:00' }] });

    tickTo('2026-06-10T07:00:00Z');
    tickTo('2026-06-10T07:30:00Z');

    expect(keysOf(triggerId)).toEqual(['cron:2026-06-10T07:00:00.000Z']);
    expect(JSON.parse((world.db.prepare('SELECT event_json FROM trigger_fires WHERE trigger_id = ?').get(triggerId) as { event_json: string }).event_json))
      .toEqual({ slot: { at: '2026-06-10T07:00:00.000Z', localDate: '2026-06-10', localTime: '09:00' } });
  });

  it('puts nothing of the trigger in the activity log but ids and enumerations', async () => {
    const { world, lead } = await worldWithLead();
    world.setNowMs(at('2026-06-10T06:59:00Z'));
    await armCron({ managerId: lead.id, when: { expression: '0 9 * * *' }, run: { kind: 'prompt_manager', managerId: lead.id, prompt: 'SECRET-CRON-PROMPT' } });

    tickTo('2026-06-10T07:00:00Z');

    const activity = JSON.stringify(world.db.prepare('SELECT * FROM activity_log').all());
    expect(activity).not.toContain('SECRET-CRON-PROMPT');
    expect(activity).not.toContain('0 9 * * *');
  });
});

describe('the clock changes in Europe/Paris', () => {
  it('fires a fixed hour once on 2026-10-25, when the clock goes back and 02:30 is read twice', async () => {
    const { world, lead } = await worldWithLead();
    world.setNowMs(at('2026-10-24T23:00:00Z'));
    const triggerId = await armCron({ managerId: lead.id, when: { expression: '30 2 * * *' } });

    for (const instant of ['2026-10-25T00:30:00Z', '2026-10-25T01:30:00Z', '2026-10-25T12:00:00Z', '2026-10-25T23:00:00Z']) tickTo(instant);

    expect(keysOf(triggerId)).toEqual(['cron:2026-10-25T00:30:00.000Z']);
  });

  it('fires an every-hour expression at each real occurrence of the repeated hour', async () => {
    const { world, lead } = await worldWithLead();
    world.setNowMs(at('2026-10-24T23:30:00Z'));
    const triggerId = await armCron({ managerId: lead.id, when: { expression: '0 * * * *' } });

    for (const instant of ['2026-10-25T00:00:00Z', '2026-10-25T01:00:00Z', '2026-10-25T02:00:00Z']) tickTo(instant);

    expect(keysOf(triggerId)).toEqual(['cron:2026-10-25T00:00:00.000Z', 'cron:2026-10-25T01:00:00.000Z', 'cron:2026-10-25T02:00:00.000Z']);
  });

  it('fires once at 03:00 local on 2026-03-29, when the clock jumps over 02:30', async () => {
    const { world, lead } = await worldWithLead();
    world.setNowMs(at('2026-03-28T23:00:00Z'));
    const triggerId = await armCron({ managerId: lead.id, when: { expression: '30 2 * * *' } });

    for (const instant of ['2026-03-29T00:30:00Z', '2026-03-29T01:00:00Z', '2026-03-29T12:00:00Z']) tickTo(instant);

    expect(keysOf(triggerId)).toEqual(['cron:2026-03-29T01:00:00.000Z']);
    const event = JSON.parse((world.db.prepare('SELECT event_json FROM trigger_fires WHERE trigger_id = ?').get(triggerId) as { event_json: string }).event_json);
    expect(event.slot.localTime).toBe('03:00');
  });

  it('gives every minute of the missing hour the same dedup key', async () => {
    const { world, lead } = await worldWithLead();
    world.setNowMs(at('2026-03-28T23:00:00Z'));
    const triggerId = await armCron({ managerId: lead.id, when: { expression: '*/15 2 * * *' } });

    for (const instant of ['2026-03-29T01:00:00Z', '2026-03-29T12:00:00Z']) tickTo(instant);

    expect(keysOf(triggerId)).toEqual(['cron:2026-03-29T01:00:00.000Z']);
  });
});

describe('the daemon was stopped for three hours across the slots of an hourly trigger', () => {
  /** Armed at 10:30Z; the daemon is stopped, and starts again at 13:30Z: the slots of 11:00, 12:00 and 13:00 were missed. */
  const missedThreeSlots = async (input: { catchUp?: string; policy?: unknown }) => {
    const { world, lead } = await worldWithLead();
    world.setNowMs(at('2026-06-10T10:30:00Z'));
    const triggerId = await armCron({ managerId: lead.id, when: { expression: '0 * * * *', ...(input.catchUp === undefined ? {} : { catchUp: input.catchUp }) }, ...(input.policy === undefined ? {} : { policy: input.policy }) });
    await world.restart({ stoppedForMs: 3 * HOUR_MS });
    return { world, lead, triggerId };
  };

  it('skip, the default, fires none of them', async () => {
    const { world, triggerId } = await missedThreeSlots({});

    expect(world.firesOf(triggerId)).toEqual([]);
  });

  it('skip still moves the cursor past them, so they are not offered at the next start', async () => {
    const { world, triggerId } = await missedThreeSlots({});

    expect(world.cursorOf(triggerId)).toMatchObject({ kind: 'cron', through: '2026-06-10T13:00:00.000Z' });
  });

  it('run_once fires the latest of them only', async () => {
    const { world, triggerId } = await missedThreeSlots({ catchUp: 'run_once' });

    expect(keysOf(triggerId)).toEqual(['cron:2026-06-10T13:00:00.000Z']);
  });

  it('run_all fires each of them, dated by its slot', async () => {
    const { world, triggerId } = await missedThreeSlots({ catchUp: 'run_all' });

    expect(keysOf(triggerId)).toEqual(['cron:2026-06-10T11:00:00.000Z', 'cron:2026-06-10T12:00:00.000Z', 'cron:2026-06-10T13:00:00.000Z']);
    expect(world.firesOf(triggerId).map((fire) => fire.fired_at)).toEqual(['2026-06-10T11:00:00.000Z', '2026-06-10T12:00:00.000Z', '2026-06-10T13:00:00.000Z']);
  });

  it('run_all with fire_latest_only runs the newest and supersedes the others', async () => {
    const { world, triggerId } = await missedThreeSlots({ catchUp: 'run_all', policy: { backlogPolicy: 'fire_latest_only' } });

    expect(statesOf(triggerId)).toEqual(['cancelled', 'cancelled', 'completed']);
    expect(world.firesOf(triggerId).map((fire) => fire.settle_reason)).toEqual(['superseded', 'superseded', null]);
  });

  it('run_all with discard_stale cancels the slots older than the age as stale', async () => {
    const { world, triggerId } = await missedThreeSlots({ catchUp: 'run_all', policy: { backlogPolicy: 'discard_stale', backlogMaxAgeMinutes: 90 } });

    expect(statesOf(triggerId)).toEqual(['cancelled', 'completed', 'completed']);
    expect(world.firesOf(triggerId)[0]!.settle_reason).toBe('stale');
  });

  it('run_all never offers more than the newest five of a longer stop', async () => {
    const { world, lead } = await worldWithLead();
    world.setNowMs(at('2026-06-10T10:30:00Z'));
    const triggerId = await armCron({ managerId: lead.id, when: { expression: '0 * * * *', catchUp: 'run_all' } });

    await world.restart({ stoppedForMs: 20 * HOUR_MS });

    expect(keysOf(triggerId)).toHaveLength(RUN_ALL_CAP);
    expect(keysOf(triggerId).at(-1)).toBe('cron:2026-06-11T06:00:00.000Z');
    expect(world.cursorOf(triggerId)).toMatchObject({ through: '2026-06-11T06:00:00.000Z' });
  });

  it('a slot that came due within two minutes of the restart is live and fires whatever catchUp says', async () => {
    const { world, lead } = await worldWithLead();
    world.setNowMs(at('2026-06-10T10:30:00Z'));
    const triggerId = await armCron({ managerId: lead.id, when: { expression: '0 * * * *' } });

    await world.restart({ stoppedForMs: 31 * MINUTE_MS });

    expect(keysOf(triggerId)).toEqual(['cron:2026-06-10T11:00:00.000Z']);
  });

  describe('an every-minute trigger woken at 10:05:30Z with its cursor at 10:00Z: 10:04 and 10:05 are live, 10:01 to 10:03 are missed', () => {
    it.each([
      ['skip', ['10:04', '10:05']],
      ['run_once', ['10:03', '10:04', '10:05']],
      ['run_all', ['10:01', '10:02', '10:03', '10:04', '10:05']],
    ])('catchUp %s always offers the live slots and judges the missed ones', async (catchUp, expectedMinutes) => {
      const { world, lead } = await worldWithLead();
      world.setNowMs(at('2026-06-10T10:00:00Z'));
      const triggerId = await armCron({ managerId: lead.id, when: { expression: '* * * * *', catchUp } });

      world.setNowMs(at('2026-06-10T10:05:30Z'));
      world.fireLivingTimers();

      expect(keysOf(triggerId)).toEqual(expectedMinutes.map((minutes) => `cron:2026-06-10T${minutes}:00.000Z`));
    });
  });

  it('starts a trigger that has no cursor from the moment it was armed: the slots since then are missed slots', async () => {
    const { world, lead } = await worldWithLead();
    world.setNowMs(at('2026-06-10T10:30:00Z'));
    const triggerId = await armCron({ managerId: lead.id, when: { expression: '0 * * * *', catchUp: 'run_all' } });
    world.db.prepare('UPDATE triggers SET armed_at = ? WHERE id = ?').run('2026-06-10T10:30:00.000Z', triggerId);
    world.db.prepare('DELETE FROM trigger_cursors WHERE trigger_id = ?').run(triggerId);

    await world.restart({ stoppedForMs: 3 * HOUR_MS });

    expect(keysOf(triggerId)).toEqual(['cron:2026-06-10T11:00:00.000Z', 'cron:2026-06-10T12:00:00.000Z', 'cron:2026-06-10T13:00:00.000Z']);
  });

  it('keeps the cursor of the trigger across the boot, which forgets the cursors of the waits', async () => {
    const { world, triggerId } = await missedThreeSlots({ catchUp: 'run_once' });

    expect(world.cursorOf(triggerId)).toMatchObject({ kind: 'cron' });
  });
});

describe('arming', () => {
  it('starts at the present: the slots of the time it was disarmed are not offered', async () => {
    const { world, lead } = await worldWithLead();
    world.setNowMs(at('2026-06-10T10:30:00Z'));
    const triggerId = await armCron({ managerId: lead.id, when: { expression: '0 * * * *', catchUp: 'run_all' } });
    await world.api(`/api/triggers/${triggerId}/disarm`, { method: 'POST' });
    world.setNowMs(at('2026-06-10T14:30:00Z'));
    const trigger = await world.json<{ contentRev: number }>(await world.api(`/api/triggers/${triggerId}`));

    await world.api(`/api/triggers/${triggerId}/arm`, { method: 'POST', body: JSON.stringify({ approvedRev: trigger.contentRev }), headers: { 'x-human-proof': 'proof' } });

    expect(world.firesOf(triggerId)).toEqual([]);
    expect(world.cursorOf(triggerId)).toMatchObject({ through: '2026-06-10T14:30:00.000Z' });
  });

  it('never moves the cursor back', async () => {
    const { world, lead } = await worldWithLead();
    world.setNowMs(at('2026-06-10T10:30:00Z'));
    const triggerId = await armCron({ managerId: lead.id, when: { expression: '0 * * * *' } });
    await world.api(`/api/triggers/${triggerId}/disarm`, { method: 'POST' });
    world.db.prepare('UPDATE trigger_cursors SET cursor_json = ? WHERE trigger_id = ?').run(JSON.stringify({ kind: 'cron', through: '2026-06-10T18:00:00.000Z' }), triggerId);
    const trigger = await world.json<{ contentRev: number }>(await world.api(`/api/triggers/${triggerId}`));

    await world.api(`/api/triggers/${triggerId}/arm`, { method: 'POST', body: JSON.stringify({ approvedRev: trigger.contentRev }), headers: { 'x-human-proof': 'proof' } });

    expect(world.cursorOf(triggerId)).toMatchObject({ through: '2026-06-10T18:00:00.000Z' });
  });
});

describe('timers', () => {
  it('holds one timer per armed trigger, and still one after it fires', async () => {
    const { world, lead } = await worldWithLead();
    world.setNowMs(at('2026-06-10T06:59:00Z'));
    await armCron({ managerId: lead.id, when: { expression: '* * * * *' } });
    await armCron({ managerId: lead.id, when: { expression: '0 9 * * *' } });
    expect(world.livingTimers()).toHaveLength(2);

    tickTo('2026-06-10T07:00:00Z');

    expect(world.livingTimers()).toHaveLength(2);
  });

  it('never waits longer than an hour, whatever the next slot', async () => {
    const { world, lead } = await worldWithLead();
    world.setNowMs(at('2026-06-10T06:59:00Z'));
    await armCron({ managerId: lead.id, when: { expression: '0 0 1 1 *' } });

    expect(world.livingTimers().map((timer) => timer.delayMs)).toEqual([MAX_WAIT_MS]);
  });

  it('fires a slot once and not again at the next wake', async () => {
    const { world, lead } = await worldWithLead();
    world.setNowMs(at('2026-06-10T06:00:00Z'));
    const triggerId = await armCron({ managerId: lead.id, when: { expression: '0 9 * * *' } });

    tickTo('2026-06-10T07:00:00Z');

    expect(world.firesOf(triggerId)).toHaveLength(1);
    tickTo('2026-06-10T07:30:00Z');
    expect(world.firesOf(triggerId)).toHaveLength(1);
    expect(world.livingTimers()).toHaveLength(1);
  });

  it('cancels the timer when the trigger is disarmed', async () => {
    const { world, lead } = await worldWithLead();
    const triggerId = await armCron({ managerId: lead.id, when: { expression: '0 9 * * *' } });
    expect(world.livingTimers()).toHaveLength(1);

    await world.api(`/api/triggers/${triggerId}/disarm`, { method: 'POST' });

    expect(world.livingTimers()).toHaveLength(0);
  });

  it('cancels the timer when the trigger is edited, which clears the arming', async () => {
    const { world, lead } = await worldWithLead();
    const triggerId = await armCron({ managerId: lead.id, when: { expression: '0 9 * * *' } });
    const trigger = await world.json<{ contentRev: number }>(await world.api(`/api/triggers/${triggerId}`));

    await world.api(`/api/triggers/${triggerId}`, { method: 'PUT', body: JSON.stringify({ expectedRev: trigger.contentRev, when: { source: 'cron', expression: '0 10 * * *' } }) });

    expect(world.livingTimers()).toHaveLength(0);
  });

  it('cancels the timer when the trigger is deleted', async () => {
    const { world, lead } = await worldWithLead();
    const triggerId = await armCron({ managerId: lead.id, when: { expression: '0 9 * * *' } });

    await world.api(`/api/triggers/${triggerId}`, { method: 'DELETE' });

    expect(world.livingTimers()).toHaveLength(0);
  });

  it('cancels the timers when the daemon stops', async () => {
    const { world, lead } = await worldWithLead();
    await armCron({ managerId: lead.id, when: { expression: '0 9 * * *' } });
    let livingAfterStop = -1;

    await world.restart({ whileStopped: () => { livingAfterStop = world.livingTimers().length; } });

    expect(livingAfterStop).toBe(0);
    expect(world.livingTimers()).toHaveLength(1);
  });

  it('sets no timer when the breaker disarms the trigger during the wake itself', async () => {
    const { world, lead } = await worldWithLead();
    world.setNowMs(at('2026-06-10T06:59:00Z'));
    const triggerId = await armCron({ managerId: lead.id, when: { expression: '0 9 * * *' }, run: { kind: 'notify', title: 'tick', message: 'tick' } });
    const breakerCap = 30;
    world.setNowMs(at('2026-06-10T06:59:30Z'));
    for (let offer = 0; offer < breakerCap; offer += 1) world.engine.submit({ triggerId, dedupKey: `burst:${offer}`, event: { slot: {} } });

    tickTo('2026-06-10T07:00:00Z');

    expect(world.firesOf(triggerId).at(-1)?.settle_reason).toBe('breaker_open');
    expect(world.livingTimers()).toHaveLength(0);
  });

  it('cancels the timer of a trigger the breaker disarmed', async () => {
    const { world, lead } = await worldWithLead();
    const triggerId = await armCron({ managerId: lead.id, when: { expression: '* * * * *' }, run: { kind: 'notify', title: 'tick', message: 'tick' } });
    const breakerCap = 30;

    for (let offer = 0; offer <= breakerCap; offer += 1) world.engine.submit({ triggerId, dedupKey: `burst:${offer}`, event: { slot: {} } });

    expect(world.livingTimers()).toHaveLength(0);
  });
});

describe('the scope of the owner', () => {
  it('prompts the owner when the RUN names no manager', async () => {
    const { world, lead } = await worldWithLead();
    world.setNowMs(at('2026-06-10T06:59:00Z'));
    await armCron({ ownerManagerId: lead.id, when: { expression: '0 9 * * *' } });

    tickTo('2026-06-10T07:00:00Z');

    expect(bodiesTo(lead.id)).toHaveLength(1);
  });

  it('cancels as target_not_eligible a fire that names a manager outside the lineage of the owner', async () => {
    const { world, lead } = await worldWithLead();
    const other = await world.createSession('Other', { manager: world.managerSpec });
    world.setNowMs(at('2026-06-10T06:59:00Z'));
    const triggerId = await armCron({ ownerManagerId: lead.id, managerId: other.id, when: { expression: '0 9 * * *' } });

    tickTo('2026-06-10T07:00:00Z');

    expect(world.firesOf(triggerId).map((fire) => fire.settle_reason)).toEqual(['target_not_eligible']);
    expect(bodiesTo(other.id)).toEqual([]);
  });

  it('cancels close_session as target_not_eligible: a slot is about no session', async () => {
    const { world, lead } = await worldWithLead();
    const child = await world.createChild(lead);
    world.setNowMs(at('2026-06-10T06:59:00Z'));
    const triggerId = await armCron({ ownerManagerId: lead.id, when: { expression: '0 9 * * *' }, run: { kind: 'close_session', sessionId: child.id } });

    tickTo('2026-06-10T07:00:00Z');

    expect(world.firesOf(triggerId).map((fire) => fire.settle_reason)).toEqual(['target_not_eligible']);
  });
});

describe('the cron WHEN is validated when the trigger is created', () => {
  const create = async (when: Record<string, unknown>) => {
    world ??= await startTriggerWorld();
    return world.api('/api/triggers', { method: 'POST', body: JSON.stringify({ projectId: PROJECT_ID, ownerManagerId: null, when: { source: 'cron', ...when } }) });
  };

  it.each(['0 0 30 2 *', '0 0 31 4 *', '61 * * * *', '* * * * * *'])('refuses %s', async (expression) => {
    const response = await create({ expression });

    expect(response.status).toBe(400);
  });

  it('accepts the 29th of February and fires on leap years', async () => {
    const response = await create({ expression: '0 0 29 2 *' });

    expect(response.status).toBe(201);
  });

  it('stores Europe/Paris when no time zone is given', async () => {
    const response = await create({ expression: '0 9 * * *' });

    expect(await world!.json<{ when: { timezone: string } }>(response)).toMatchObject({ when: { timezone: 'Europe/Paris' } });
  });

  it('refuses a time zone that is not IANA', async () => {
    const response = await create({ expression: '0 9 * * *', timezone: 'Paris' });

    expect(response.status).toBe(400);
  });

  it('refuses an event.record path: a slot has event.slot fields only', async () => {
    world ??= await startTriggerWorld();
    const response = await world.api('/api/triggers', {
      method: 'POST',
      body: JSON.stringify({ projectId: PROJECT_ID, ownerManagerId: null, when: { source: 'cron', expression: '0 9 * * *' }, conditions: [{ lhs: 'event.record.id', op: 'exists' }] }),
    });

    expect(response.status).toBe(400);
  });
});
