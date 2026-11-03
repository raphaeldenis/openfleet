import { afterEach, describe, expect, it, vi } from 'vitest';

import { MINUTE_MS, startTriggerWorld, type TriggerWorld } from './triggerWorld.testkit.js';

let world: TriggerWorld | undefined;
afterEach(async () => { await world?.close(); world = undefined; });

const SECOND_MS = 1000;
const HOUR_MS = 60 * MINUTE_MS;
const eventOf = (sessionId: string) => ({ session: { id: sessionId, name: 'Worker', state: 'closed_with_error' } });

const worldWithTrigger = async (policy: Record<string, unknown>) => {
  world = await startTriggerWorld();
  const lead = await world.createSession('Lead', { manager: world.managerSpec });
  const triggerId = await world.createArmedTrigger({ run: { kind: 'prompt_manager', managerId: lead.id, prompt: 'Look.' }, policy });
  const fire = (dedupKey: string, sessionId = 'worker') => world!.engine.submit({ triggerId, dedupKey, event: eventOf(sessionId) });
  const states = () => world!.firesOf(triggerId).map((row) => [row.dedup_key, row.ledger_state, row.settle_reason]);
  return { world, lead, triggerId, fire, states };
};

describe('the cooldown', () => {
  it('cancels a fire inside the cooldown and lets one through once it has ended', async () => {
    const { world, lead, fire, states } = await worldWithTrigger({ cooldownSeconds: 60 });

    fire('k1');
    world.advanceMs(30 * SECOND_MS);
    fire('k2');
    world.advanceMs(31 * SECOND_MS);
    fire('k3');

    expect(states()).toEqual([['k1', 'completed', null], ['k2', 'cancelled', 'cooldown'], ['k3', 'completed', null]]);
    expect(world.messagesTo(lead.id)).toHaveLength(2);
  });
});

describe('maxFiresPerDay', () => {
  it('cancels the fire past the cap in the local day, and fires again the next local day', async () => {
    const { world, lead, fire, states } = await worldWithTrigger({ maxFiresPerDay: 2 });

    fire('k1');
    fire('k2');
    fire('k3');
    world.advanceMs(25 * HOUR_MS);
    fire('k4');

    expect(states()).toEqual([['k1', 'completed', null], ['k2', 'completed', null], ['k3', 'cancelled', 'daily_cap'], ['k4', 'completed', null]]);
    expect(world.messagesTo(lead.id)).toHaveLength(3);
  });

  describe('around local midnight', () => {
    const initialTimeZone = process.env.TZ;
    afterEach(() => {
      if (initialTimeZone === undefined) delete process.env.TZ;
      else process.env.TZ = initialTimeZone;
    });

    it('counts a fire held across midnight on the day its effect starts: three effects never land on one local day', async () => {
      process.env.TZ = 'Europe/Paris';
      const { world, lead, fire, states } = await worldWithTrigger({ maxFiresPerDay: 2, cooldownSeconds: 60, batchMode: 'per_batch' });
      const moveClockTo = (isoInstant: string) => world.advanceMs(Date.parse(isoInstant) - world.nowMs);

      moveClockTo('2026-06-10T21:59:50Z');
      fire('before-midnight');
      moveClockTo('2026-06-10T21:59:55Z');
      fire('held-over-midnight');
      moveClockTo('2026-06-10T22:00:50Z');
      world.fireLivingTimers();
      moveClockTo('2026-06-10T22:02:00Z');
      fire('after-midnight-1');
      moveClockTo('2026-06-10T22:04:00Z');
      fire('after-midnight-2');

      expect(states()).toEqual([
        ['before-midnight', 'completed', null], ['held-over-midnight', 'completed', null], ['after-midnight-1', 'completed', null], ['after-midnight-2', 'cancelled', 'daily_cap'],
      ]);
      expect(world.messagesTo(lead.id)).toHaveLength(3);
    });
  });
});

describe('batchMode per_batch', () => {
  it('holds the fires of a cooldown and sends one message for them when it ends', async () => {
    const { world, lead, fire, states } = await worldWithTrigger({ cooldownSeconds: 60, batchMode: 'per_batch' });
    fire('k1');

    world.advanceMs(10 * SECOND_MS);
    fire('k2');
    fire('k3');
    const heldMessages = world.messagesTo(lead.id).length;
    const [drain] = world.livingTimers();
    world.advanceMs(50 * SECOND_MS);
    world.fireLivingTimers();

    expect(heldMessages).toBe(1);
    expect(drain!.delayMs).toBe(50 * SECOND_MS);
    expect(states()).toEqual([['k1', 'completed', null], ['k2', 'cancelled', 'batched'], ['k3', 'completed', null]]);
    expect(world.messagesTo(lead.id)).toHaveLength(2);
  });
});

describe('the fire breaker', () => {
  it('lets 30 fires through in a minute, cancels the 31st, disarms the trigger and raises the alert of the Inbox', async () => {
    const { world, lead, triggerId, fire, states } = await worldWithTrigger({});
    const socket = await world.openSocket();

    for (let number = 1; number <= 31; number += 1) fire(`k${number}`);

    const rows = states();
    expect(rows.filter(([, state]) => state === 'completed')).toHaveLength(30);
    expect(rows.at(-1)).toEqual(['k31', 'cancelled', 'breaker_open']);
    expect(world.messagesTo(lead.id)).toHaveLength(30);
    expect((await world.json<{ armedAt: string | null }>(await world.api(`/api/triggers/${triggerId}`))).armedAt).toBeNull();
    expect(fire('k32').outcome).toBe('not_armed');
    await vi.waitFor(() => expect(socket.framesOfType('error')).toEqual([expect.objectContaining({ scope: 'broadcast', error: expect.objectContaining({ error: 'breaker_open' }) })]));
  });

  it('counts the fires of every trigger together and forgets them after a minute', async () => {
    world = await startTriggerWorld();
    const lead = await world.createSession('Lead', { manager: world.managerSpec });
    const first = await world.createArmedTrigger({ title: 'A', run: { kind: 'prompt_manager', managerId: lead.id, prompt: 'a' } });
    const second = await world.createArmedTrigger({ title: 'B', run: { kind: 'prompt_manager', managerId: lead.id, prompt: 'b' } });
    for (let number = 1; number <= 30; number += 1) world.engine.submit({ triggerId: first, dedupKey: `k${number}`, event: eventOf('w') });

    const insideTheMinute = world.engine.submit({ triggerId: second, dedupKey: 'x', event: eventOf('w') });
    world.advanceMs(MINUTE_MS + 1);
    const afterTheMinute = world.engine.submit({ triggerId: first, dedupKey: 'again', event: eventOf('w') });

    expect(insideTheMinute).toMatchObject({ outcome: 'fired', ledgerState: 'cancelled' });
    expect(world.firesOf(second)[0]).toMatchObject({ settle_reason: 'breaker_open' });
    expect(afterTheMinute).toMatchObject({ outcome: 'fired', ledgerState: 'completed' });
  });
});

describe('the depth of a chain', () => {
  it('lets a fire caused by a fire start another, and refuses a third', async () => {
    world = await startTriggerWorld();
    const lead = await world.createSession('Lead', { manager: world.managerSpec });
    const prompt = (title: string) => world!.createArmedTrigger({ title, run: { kind: 'prompt_manager', managerId: lead.id, prompt: title } });
    const [first, second, third] = [await prompt('first'), await prompt('second'), await prompt('third')];

    world.engine.submit({ triggerId: first, dedupKey: 'k', event: eventOf('a-worker') });
    world.engine.submit({ triggerId: second, dedupKey: 'k', event: eventOf(lead.id) });
    world.engine.submit({ triggerId: third, dedupKey: 'k', event: eventOf(lead.id) });

    expect(world.firesOf(first)[0]).toMatchObject({ ledger_state: 'completed' });
    expect(world.firesOf(second)[0]).toMatchObject({ ledger_state: 'completed' });
    expect(world.firesOf(third)[0]).toMatchObject({ ledger_state: 'cancelled', settle_reason: 'chain_depth' });
    expect(world.messagesTo(lead.id)).toHaveLength(2);
  });
});
