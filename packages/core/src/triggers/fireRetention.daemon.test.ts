import { afterEach, describe, expect, it } from 'vitest';
import { isoDaysBefore, leaveFires, remainingFireIds } from './fireRetention.testkit.js';
import { MINUTE_MS, startTriggerWorld, type TriggerWorld } from './triggerWorld.testkit.js';

let world: TriggerWorld | undefined;
afterEach(async () => { await world?.close(); world = undefined; });

const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const SESSION_EVENT = { session: { id: 's1', name: 'Worker', state: 'closed_with_error' } };

const worldClockIso = () => new Date(world!.nowMs).toISOString();
const daysAgoOnTheWorldClock = (days: number) => isoDaysBefore(days, worldClockIso());

const worldWithATrigger = async (configJson?: Record<string, unknown>) => {
  world = await startTriggerWorld({ configJson });
  const lead = await world.createSession('Lead', { manager: world.managerSpec });
  const triggerId = await world.createArmedTrigger({ run: { kind: 'prompt_manager', managerId: lead.id, prompt: 'A worker needs a look.' } });
  return { world, triggerId };
};

/** Stops the daemon, leaves the fires a long-running daemon would have written, and starts it again. */
const rebootAfterLeaving = async (triggerId: string, fires: Parameters<typeof leaveFires>[2], stoppedForMs = 0) => {
  let ids: string[] = [];
  await world!.restart({ stoppedForMs, whileStopped: (db) => { ids = leaveFires(db, triggerId, fires); } });
  return ids;
};

const settled = (ledgerState: 'completed' | 'cancelled' | 'needs_review' | 'attempted', daysAgo: number) =>
  ({ ledgerState, settledAt: daysAgoOnTheWorldClock(daysAgo) });

describe('the ledger forgets old fires at boot', () => {
  it('removes the completed and cancelled fires that ended more than 90 days ago, and keeps the others', async () => {
    const { world, triggerId } = await worldWithATrigger();

    const [, , recentCompleted, recentCancelled] = await rebootAfterLeaving(triggerId, [
      settled('completed', 91), settled('cancelled', 120), settled('completed', 89), settled('cancelled', 1),
    ]);

    expect(remainingFireIds(world.db)).toEqual([recentCompleted, recentCancelled]);
  });

  it('keeps a fire that needs a review or was attempted, however old', async () => {
    const { world, triggerId } = await worldWithATrigger();

    const ids = await rebootAfterLeaving(triggerId, [settled('needs_review', 400), settled('attempted', 400), settled('completed', 400)]);

    expect(remainingFireIds(world.db)).toEqual([ids[0], ids[1]]);
    expect(world.firesOf(triggerId).map((fire) => fire.ledger_state)).toEqual(['needs_review', 'needs_review']);
  });

  it('counts the 90 days on the clock of the daemon: a fire kept yesterday is removed once the daemon has been stopped long enough', async () => {
    const { world, triggerId } = await worldWithATrigger();
    const [fire] = await rebootAfterLeaving(triggerId, [settled('completed', 80)]);
    expect(remainingFireIds(world.db)).toEqual([fire]);

    await world.restart({ stoppedForMs: 11 * DAY_MS });

    expect(remainingFireIds(world.db)).toEqual([]);
  });

  it('follows triggers.fireRetentionDays of config.json', async () => {
    const { world, triggerId } = await worldWithATrigger({ triggers: { fireRetentionDays: 30 } });

    const [, keptSince29Days] = await rebootAfterLeaving(triggerId, [settled('completed', 31), settled('completed', 29)]);

    expect(remainingFireIds(world.db)).toEqual([keptSince29Days]);
  });

  it('refuses to boot on a retention that is not a whole number of days', async () => {
    await expect(startTriggerWorld({ configJson: { triggers: { fireRetentionDays: 0 } } })).rejects.toThrow(/fireRetentionDays/);
  });
});

describe('the ledger forgets old fires while the daemon runs', () => {
  const settleOneFire = (world: TriggerWorld, triggerId: string, dedupKey: string) => world.engine.submit({ triggerId, dedupKey, event: SESSION_EVENT });
  const leaveAnOldFire = (world: TriggerWorld, triggerId: string) => leaveFires(world.db, triggerId, [settled('completed', 200)])[0]!;

  it('prunes when a fire settles more than a day after the last prune', async () => {
    const { world, triggerId } = await worldWithATrigger();
    const oldFire = leaveAnOldFire(world, triggerId);

    world.advanceMs(DAY_MS + MINUTE_MS);
    settleOneFire(world, triggerId, 'k1');

    expect(remainingFireIds(world.db)).not.toContain(oldFire);
  });

  it('does not prune when a fire settles less than a day after the last prune', async () => {
    const { world, triggerId } = await worldWithATrigger();
    const oldFire = leaveAnOldFire(world, triggerId);

    world.advanceMs(DAY_MS - MINUTE_MS);
    settleOneFire(world, triggerId, 'k1');

    expect(remainingFireIds(world.db)).toContain(oldFire);
  });

  it('prunes again a day after the previous periodic prune, not only once', async () => {
    const { world, triggerId } = await worldWithATrigger();
    world.advanceMs(DAY_MS + MINUTE_MS);
    settleOneFire(world, triggerId, 'k1');
    const oldFire = leaveAnOldFire(world, triggerId);

    world.advanceMs(DAY_MS + MINUTE_MS);
    settleOneFire(world, triggerId, 'k2');

    expect(remainingFireIds(world.db)).not.toContain(oldFire);
  });
});
