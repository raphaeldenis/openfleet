import { describe, expect, it } from 'vitest';
import { FIRE_PRUNE_BATCH_SIZE, FIRE_PRUNE_INTERVAL_MS, FireRetention } from './fireRetention.js';
import { isoDaysBefore, NOW_ISO } from './fireRetention.testkit.js';

const FULL_BATCH = FIRE_PRUNE_BATCH_SIZE;
const MORE_BATCHES_THAN_ANY_TEST_NEEDS = 50;

type ForgetInput = { settledBefore: string; afterRowid: number; batchSize: number };
type ForgetResult = { forgotten: number; lastRowid: number };

/** A ledger that answers the given batches in order, then nothing; it throws when asked more often than any test needs, so a loop that never stops fails by assertion. */
const ledgerAnswering = (forgottenPerBatch: number[]) => {
  const inputs: ForgetInput[] = [];
  return {
    inputs,
    forgetSettledEvents: (input: ForgetInput): ForgetResult => {
      if (inputs.length >= MORE_BATCHES_THAN_ANY_TEST_NEEDS) throw new Error('asked for more batches than any test needs');
      inputs.push(input);
      const forgotten = forgottenPerBatch[inputs.length - 1] ?? 0;
      return { forgotten, lastRowid: inputs.length * FULL_BATCH };
    },
  };
};

const retentionOver = (ledger: ReturnType<typeof ledgerAnswering>, overrides: { onFailure?: (error: unknown) => void } = {}) => {
  const failures: unknown[] = [];
  const timers: { callback: () => void; delayMs: number; isCancelled: boolean }[] = [];
  const retention = new FireRetention({
    ledger, clock: () => Date.parse(NOW_ISO), retentionDays: 90,
    schedule: (callback, delayMs) => { const timer = { callback, delayMs, isCancelled: false }; timers.push(timer); return () => { timer.isCancelled = true; }; },
    onFailure: overrides.onFailure ?? ((error) => failures.push(error)),
  });
  return { retention, failures, livingTimers: () => timers.filter((timer) => !timer.isCancelled) };
};

describe('forgetting the old events in batches', () => {
  it('asks for the fires that ended 90 days before now, from the start, then after the last row of each batch', async () => {
    const ledger = ledgerAnswering([FULL_BATCH, FULL_BATCH, 7]);
    const { retention } = retentionOver(ledger);

    await retention.forgetOldEvents();

    expect(ledger.inputs).toEqual([
      { settledBefore: isoDaysBefore(90), afterRowid: 0, batchSize: FULL_BATCH },
      { settledBefore: isoDaysBefore(90), afterRowid: FULL_BATCH, batchSize: FULL_BATCH },
      { settledBefore: isoDaysBefore(90), afterRowid: 2 * FULL_BATCH, batchSize: FULL_BATCH },
    ]);
  });

  it('stops at the first batch that is not full, and reports what it forgot', async () => {
    const { retention } = retentionOver(ledgerAnswering([FULL_BATCH, FULL_BATCH, 7]));

    const report = await retention.forgetOldEvents();

    expect(report).toEqual({ forgotten: 2 * FULL_BATCH + 7, batches: 3 });
  });

  it('stops at an empty batch that follows full ones', async () => {
    const ledger = ledgerAnswering([FULL_BATCH, FULL_BATCH, 0]);
    const { retention, failures } = retentionOver(ledger);

    const report = await retention.forgetOldEvents();

    expect(failures).toEqual([]);
    expect(report).toEqual({ forgotten: 2 * FULL_BATCH, batches: 3 });
  });

  it('runs one batch when the ledger has nothing to forget', async () => {
    const ledger = ledgerAnswering([]);
    const { retention } = retentionOver(ledger);

    const report = await retention.forgetOldEvents();

    expect(report).toEqual({ forgotten: 0, batches: 1 });
  });

  it('lets the event loop run between two batches', async () => {
    const batchesToForget = 20;
    const ledger = ledgerAnswering([...Array.from({ length: batchesToForget }, () => FULL_BATCH), 0]);
    const { retention } = retentionOver(ledger);
    let turnsOfTheEventLoopDuringThePurge = 0;
    let isPurging = true;
    const probe = () => { if (!isPurging) return; turnsOfTheEventLoopDuringThePurge += 1; setImmediate(probe); };
    setImmediate(probe);

    await retention.forgetOldEvents();
    isPurging = false;

    expect(turnsOfTheEventLoopDuringThePurge).toBeGreaterThanOrEqual(batchesToForget);
  });

  it('logs a failure of the ledger, forgets nothing more and does not throw', async () => {
    const failure = new Error('database is locked');
    const { retention, failures } = retentionOver({ inputs: [], forgetSettledEvents: () => { throw failure; } });

    const report = await retention.forgetOldEvents();

    expect(failures).toEqual([failure]);
    expect(report).toEqual({ forgotten: 0, batches: 0 });
  });

  it('stops between two batches once it is stopped', async () => {
    const ledger = ledgerAnswering([FULL_BATCH, FULL_BATCH, FULL_BATCH, 0]);
    const { retention } = retentionOver(ledger);

    const purge = retention.forgetOldEvents();
    retention.stop();
    await purge;

    expect(ledger.inputs).toHaveLength(1);
  });
});

describe('forgetting every day', () => {
  it('arms a timer of one day when it starts, and none before', () => {
    const { retention, livingTimers } = retentionOver(ledgerAnswering([]));
    expect(livingTimers()).toHaveLength(0);

    retention.start();

    expect(livingTimers().map((timer) => timer.delayMs)).toEqual([FIRE_PRUNE_INTERVAL_MS]);
    expect(FIRE_PRUNE_INTERVAL_MS).toBe(24 * 60 * 60 * 1000);
  });

  it('forgets when the timer fires and arms the next day', async () => {
    const ledger = ledgerAnswering([]);
    const { retention, livingTimers } = retentionOver(ledger);
    retention.start();

    livingTimers()[0]!.callback();
    await new Promise((resolve) => setImmediate(resolve));

    expect(ledger.inputs).toHaveLength(1);
    expect(livingTimers().map((timer) => timer.delayMs)).toEqual([FIRE_PRUNE_INTERVAL_MS, FIRE_PRUNE_INTERVAL_MS]);
  });

  it('cancels the pending timer when it stops, and arms no other', async () => {
    const ledger = ledgerAnswering([]);
    const { retention, livingTimers } = retentionOver(ledger);
    retention.start();

    retention.stop();
    await retention.forgetOldEvents();

    expect(livingTimers()).toHaveLength(0);
    expect(ledger.inputs).toHaveLength(0);
  });
});
