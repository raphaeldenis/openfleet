import { afterEach, describe, expect, it, vi } from 'vitest';
import { FIRE_PRUNE_BATCH_SIZE } from './fireRetention.js';
import { forgottenFireIds, isoDaysBefore, leaveFires } from './fireRetention.testkit.js';
import { MINUTE_MS, PROJECT_ID, startTriggerWorld, type TriggerWorld } from './triggerWorld.testkit.js';

let world: TriggerWorld | undefined;
afterEach(async () => { await world?.close(); world = undefined; });

const DAY_MS = 24 * 60 * MINUTE_MS;
const SECONDS_PER_DAY = 24 * 60 * 60;
const CRASH_EVENT = { session: { id: 'worker', name: 'Worker', state: 'closed_with_error' } };

const worldWithAManagerAndATrigger = async ({ policy, configJson, letTheEventLoopRun }: { policy?: Record<string, unknown>; configJson?: Record<string, unknown>; letTheEventLoopRun?: () => Promise<void> } = {}) => {
  world = await startTriggerWorld({ configJson, letTheEventLoopRun });
  const lead = await world.createSession('Lead', { manager: world.managerSpec });
  const triggerId = await world.createArmedTrigger({
    when: { source: 'session_state', state: 'closed_with_error' }, run: { kind: 'prompt_manager', managerId: lead.id, prompt: 'A worker crashed: {{event.session.name}}' }, policy,
  });
  return { world, lead, triggerId };
};

const messagesTheTriggerSent = (sessionId: string) => world!.messagesTo(sessionId).filter((message) => message.body.startsWith('trigger.fired'));
const retentionTimer = () => world!.livingRetentionTimers();

describe('forgetting a fire never reopens its event', () => {
  it('does not run again the crash of a session that stays closed in error, when the daemon boots 91 days after the fire', async () => {
    const { world, lead, triggerId } = await worldWithAManagerAndATrigger({ policy: { backlogPolicy: 'fire_all', cooldownSeconds: 0 } });
    const child = await world.createChild(lead, 'Crashy');
    world.crash(child.id);
    await vi.waitFor(() => expect(world.firesOf(triggerId)).toEqual([expect.objectContaining({ ledger_state: 'completed' })]));
    const [firstFire] = world.firesOf(triggerId);

    await world.restart({ stoppedForMs: 91 * DAY_MS });

    expect(world.firesOf(triggerId)).toEqual([firstFire]);
    expect(messagesTheTriggerSent(lead.id)).toHaveLength(1);
  });

  it('keeps the dedup key of a forgotten fire: the same key submitted again is the fire already settled', async () => {
    const { world, triggerId } = await worldWithAManagerAndATrigger();
    world.engine.submit({ triggerId, dedupKey: 'event-1', event: CRASH_EVENT });
    const [firstFire] = world.firesOf(triggerId);

    await world.restart({ stoppedForMs: 91 * DAY_MS });
    world.engine.submit({ triggerId, dedupKey: 'event-1', event: CRASH_EVENT });

    expect(world.firesOf(triggerId)).toEqual([firstFire]);
    expect(forgottenFireIds(world.db)).toEqual([firstFire!.id]);
  });
});

describe('forgetting a fire never shortens a cooldown', () => {
  it('holds a cooldown of 120 days past the 90 days of retention', async () => {
    const { world, triggerId } = await worldWithAManagerAndATrigger({ policy: { cooldownSeconds: 120 * SECONDS_PER_DAY } });
    world.engine.submit({ triggerId, dedupKey: 'k1', event: CRASH_EVENT });

    await world.restart({ stoppedForMs: 91 * DAY_MS });
    world.engine.submit({ triggerId, dedupKey: 'k2', event: CRASH_EVENT });

    expect(world.firesOf(triggerId).map((fire) => [fire.dedup_key, fire.ledger_state, fire.settle_reason])).toEqual([['k1', 'completed', null], ['k2', 'cancelled', 'cooldown']]);
  });

  it('holds a cooldown of 2 days under a retention of 1 day', async () => {
    const { world, triggerId } = await worldWithAManagerAndATrigger({ policy: { cooldownSeconds: 2 * SECONDS_PER_DAY }, configJson: { triggers: { fireRetentionDays: 1 } } });
    world.engine.submit({ triggerId, dedupKey: 'k1', event: CRASH_EVENT });

    await world.restart({ stoppedForMs: DAY_MS + MINUTE_MS });
    world.engine.submit({ triggerId, dedupKey: 'k2', event: CRASH_EVENT });

    expect(forgottenFireIds(world.db)).toHaveLength(1);
    expect(world.firesOf(triggerId).map((fire) => [fire.dedup_key, fire.ledger_state, fire.settle_reason])).toEqual([['k1', 'completed', null], ['k2', 'cancelled', 'cooldown']]);
  });
});

describe('the daemon forgets old fires every day, whether or not a fire settles', () => {
  const leaveAnOldFire = (triggerId: string) => leaveFires(world!.db, triggerId, [{ ledgerState: 'completed', settledAt: isoDaysBefore(200, new Date(world!.nowMs).toISOString()) }])[0]!;

  it('arms one daily timer, which forgets the old fires and arms the next day', async () => {
    const { world, triggerId } = await worldWithAManagerAndATrigger();
    const oldFire = leaveAnOldFire(triggerId);
    expect(retentionTimer()).toHaveLength(1);

    world.advanceMs(DAY_MS);
    retentionTimer()[0]!.callback();

    await vi.waitFor(() => expect(forgottenFireIds(world.db)).toEqual([oldFire]));
    expect(retentionTimer()).toHaveLength(2);
  });

  it('forgets nothing before the timer is due', async () => {
    const { world, triggerId } = await worldWithAManagerAndATrigger();
    leaveAnOldFire(triggerId);

    expect(forgottenFireIds(world.db)).toEqual([]);
  });

  it('cancels its timer when the daemon stops', async () => {
    const { world } = await worldWithAManagerAndATrigger();

    await world.restart();

    expect(retentionTimer().length).toBe(1);
  });
});

describe('the daemon stays responsive while it forgets a large ledger', () => {
  const BATCHES_OF_OLD_FIRES = 3;
  const FIRES_TO_FORGET = BATCHES_OF_OLD_FIRES * FIRE_PRUNE_BATCH_SIZE;

  /** A purge that, once suspension starts, stays suspended at every yield until the test resumes it; the purge of the boot is not suspended. */
  const suspendedPurgeYields = () => {
    const suspendedYields: Array<() => void> = [];
    let isSuspending = false;
    const letTheEventLoopRun = () => (isSuspending ? new Promise<void>((resolve) => { suspendedYields.push(resolve); }) : Promise.resolve());
    const startSuspending = () => { isSuspending = true; };
    const resumeThePurge = () => suspendedYields.splice(0).forEach((resume) => resume());
    return { letTheEventLoopRun, startSuspending, suspendedYields, resumeThePurge };
  };

  it('answers a request while the purge is suspended between two batches, and goes on with the next batch afterwards', async () => {
    const purge = suspendedPurgeYields();
    const { world, triggerId } = await worldWithAManagerAndATrigger({ letTheEventLoopRun: purge.letTheEventLoopRun });
    const longAgo = isoDaysBefore(200, new Date(world.nowMs).toISOString());
    leaveFires(world.db, triggerId, Array.from({ length: FIRES_TO_FORGET }, () => ({ ledgerState: 'completed' as const, settledAt: longAgo })));
    world.advanceMs(DAY_MS);
    purge.startSuspending();

    retentionTimer()[0]!.callback();
    const response = await world.api(`/api/triggers?projectId=${PROJECT_ID}`);
    const eventsForgottenWhenTheResponseArrived = forgottenFireIds(world.db).length;
    purge.resumeThePurge();
    await vi.waitFor(() => expect(forgottenFireIds(world.db)).toHaveLength(2 * FIRE_PRUNE_BATCH_SIZE));

    expect(response.status).toBe(200);
    expect(eventsForgottenWhenTheResponseArrived).toBe(FIRE_PRUNE_BATCH_SIZE);
    expect(purge.suspendedYields).toHaveLength(1);
  });
});
