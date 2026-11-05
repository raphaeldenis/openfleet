import { afterEach, describe, expect, it } from 'vitest';
import { forgottenFireIds, isoDaysBefore, leaveFires, remainingFireIds } from './fireRetention.testkit.js';
import { MINUTE_MS, startTriggerWorld, type TriggerWorld } from './triggerWorld.testkit.js';

let world: TriggerWorld | undefined;
afterEach(async () => { await world?.close(); world = undefined; });

const DAY_MS = 24 * 60 * MINUTE_MS;

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

describe('the ledger forgets the events of old fires at boot', () => {
  it('forgets the event of the completed and cancelled fires that ended more than 90 days ago, and keeps the others', async () => {
    const { world, triggerId } = await worldWithATrigger();

    const [completed91, cancelled120, ...recent] = await rebootAfterLeaving(triggerId, [
      settled('completed', 91), settled('cancelled', 120), settled('completed', 89), settled('cancelled', 1),
    ]);

    expect(forgottenFireIds(world.db)).toEqual([completed91, cancelled120]);
    expect(remainingFireIds(world.db)).toEqual([completed91, cancelled120, ...recent]);
  });

  it('keeps the event of a fire that needs a review or was attempted, however old', async () => {
    const { world, triggerId } = await worldWithATrigger();

    const ids = await rebootAfterLeaving(triggerId, [settled('needs_review', 400), settled('attempted', 400), settled('completed', 400)]);

    expect(forgottenFireIds(world.db)).toEqual([ids[2]]);
    expect(world.firesOf(triggerId).map((fire) => fire.ledger_state)).toEqual(['needs_review', 'needs_review', 'completed']);
  });

  it('counts the 90 days on the clock of the daemon: an event kept yesterday is forgotten once the daemon has been stopped long enough', async () => {
    const { world, triggerId } = await worldWithATrigger();
    await rebootAfterLeaving(triggerId, [settled('completed', 80)]);
    expect(forgottenFireIds(world.db)).toEqual([]);

    await world.restart({ stoppedForMs: 11 * DAY_MS });

    expect(forgottenFireIds(world.db)).toHaveLength(1);
  });

  it('follows triggers.fireRetentionDays of config.json', async () => {
    const { world, triggerId } = await worldWithATrigger({ triggers: { fireRetentionDays: 30 } });

    const [forgottenAt31Days] = await rebootAfterLeaving(triggerId, [settled('completed', 31), settled('completed', 29)]);

    expect(forgottenFireIds(world.db)).toEqual([forgottenAt31Days]);
  });

  it('refuses to boot on a retention that is not a whole number of days', async () => {
    await expect(startTriggerWorld({ configJson: { triggers: { fireRetentionDays: 0 } } })).rejects.toThrow(/fireRetentionDays/);
  });
});
