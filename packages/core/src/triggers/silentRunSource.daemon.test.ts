import { afterEach, describe, expect, it } from 'vitest';
import { FakeHarness } from '../harness/fakeHarness.js';
import { MAX_OFFERS_PER_TICK, SILENT_RUN_POLL_MS, SLEEP_GAP_MS } from './silentRunSource.js';
import { MINUTE_MS, startTriggerWorld, type TriggerWorld } from './triggerWorld.testkit.js';

let world: TriggerWorld | undefined;
afterEach(async () => { await world?.close(); world = undefined; });

const SESSION_START = { hook_event_name: 'SessionStart', source: 'startup' };
const START_TURN = { hook_event_name: 'UserPromptSubmit', prompt: 'work' };
const USE_TOOL = { hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'ls' } };
const SILENT_MINUTES = 5;

const worldWithLead = async () => {
  world = await startTriggerWorld();
  const lead = await world.createSession('Lead', { manager: world.managerSpec });
  return { world, lead };
};
const generatingChild = async (lead: { id: string }, name = 'Worker') => {
  const child = await world!.createChild(lead as never, name);
  await world!.postHook(child.id, SESSION_START);
  await world!.postHook(child.id, START_TURN);
  return child;
};
const promptLeadOnSilence = (minutes = SILENT_MINUTES, extra: Record<string, unknown> = {}) =>
  world!.createArmedTrigger({ title: 'silent', when: { source: 'silent_run', minutes }, run: { kind: 'prompt_manager', prompt: 'silent {{event.session.name}}' }, ...extra });
/** Time passes as the poll of the source sees it: one step at a time, since a long jump reads as a sleep. */
const letSilenceLast = (minutes: number) => {
  for (let elapsedMs = 0; elapsedMs < minutes * MINUTE_MS; elapsedMs += SILENT_RUN_POLL_MS) {
    world!.advanceMs(SILENT_RUN_POLL_MS);
    world!.fireLivingTimers();
  }
};
const bodiesTo = (sessionId: string) => world!.messagesTo(sessionId).map((message) => message.body).filter((body) => body.startsWith('trigger.fired'));
const handleOf = (sessionId: string) => {
  const fakeHarness = world!.daemon.harnesses.find((harness) => harness instanceof FakeHarness) as FakeHarness;
  return fakeHarness.handles[fakeHarness.launches.map((launch) => launch.sessionId).lastIndexOf(sessionId)]!;
};

describe('a generating child with no sign of life', () => {
  it('fires once the child has been silent for the minutes, not before, and prompts the manager with ids and the name', async () => {
    const { world, lead } = await worldWithLead();
    await generatingChild(lead, 'Quiet');
    const triggerId = await promptLeadOnSilence();

    letSilenceLast(SILENT_MINUTES - 1);
    const firesBeforeTheDeadline = world.firesOf(triggerId).length;
    letSilenceLast(1 + 1);

    expect(firesBeforeTheDeadline).toBe(0);
    expect(world.firesOf(triggerId)).toEqual([expect.objectContaining({ ledger_state: 'completed' })]);
    expect(bodiesTo(lead.id)).toHaveLength(1);
    expect(bodiesTo(lead.id)[0]).toContain('source=silent_run');
    expect(bodiesTo(lead.id)[0]).toContain('silent Quiet');
  });

  it('fires once for the whole episode however long the silence lasts', async () => {
    const { world, lead } = await worldWithLead();
    await generatingChild(lead);
    const triggerId = await promptLeadOnSilence();

    letSilenceLast(SILENT_MINUTES * 6);

    expect(world.firesOf(triggerId)).toHaveLength(1);
  });

  it('does not fire when a hook shows the child alive before the deadline, and counts the silence again from that hook', async () => {
    const { world, lead } = await worldWithLead();
    const child = await generatingChild(lead);
    const triggerId = await promptLeadOnSilence();

    letSilenceLast(SILENT_MINUTES - 2);
    await world.postHook(child.id, USE_TOOL);
    letSilenceLast(SILENT_MINUTES - 2);
    const firesWhileItWorks = world.firesOf(triggerId).length;
    letSilenceLast(3);

    expect(firesWhileItWorks).toBe(0);
    expect(world.firesOf(triggerId)).toHaveLength(1);
  });

  it('does not fire when the transcript of the child grows without any hook', async () => {
    const { world, lead } = await worldWithLead();
    const child = await generatingChild(lead);
    handleOf(child.id).transcriptCursor = { identity: 'transcript', offset: 10 };
    const triggerId = await promptLeadOnSilence();

    for (let minute = 0; minute < SILENT_MINUTES * 3; minute += 1) {
      handleOf(child.id).transcriptCursor = { identity: 'transcript', offset: 20 + minute };
      letSilenceLast(1);
    }

    expect(world.firesOf(triggerId)).toEqual([]);
  });

  it('is armed again by a sign of life: the next silence is a new episode and fires again', async () => {
    const { world, lead } = await worldWithLead();
    const child = await generatingChild(lead);
    const triggerId = await promptLeadOnSilence();
    letSilenceLast(SILENT_MINUTES + 1);

    await world.postHook(child.id, USE_TOOL);
    letSilenceLast(SILENT_MINUTES + 1);

    const fires = world.firesOf(triggerId);
    expect(fires).toHaveLength(2);
    expect(new Set(fires.map((fire) => fire.dedup_key)).size).toBe(2);
  });

  it('does not fire for a child that is idle, nor for one that closed while it was silent', async () => {
    const { world, lead } = await worldWithLead();
    const idleChild = await world.createChild(lead, 'Idle');
    await world.postHook(idleChild.id, SESSION_START);
    const closingChild = await generatingChild(lead, 'Closing');
    const triggerId = await promptLeadOnSilence();

    letSilenceLast(SILENT_MINUTES - 1);
    await world.api(`/api/sessions/${closingChild.id}/close`, { method: 'POST', body: '{}' });
    letSilenceLast(SILENT_MINUTES * 2);

    expect(world.firesOf(triggerId)).toEqual([]);
  });

  it('counts the silence from the first look: a trigger armed on a child that has been generating for an hour waits for the minutes', async () => {
    const { world, lead } = await worldWithLead();
    await generatingChild(lead);
    world.advanceMs(60 * MINUTE_MS);

    const triggerId = await promptLeadOnSilence();

    expect(world.firesOf(triggerId)).toEqual([]);
    letSilenceLast(SILENT_MINUTES + 1);
    expect(world.firesOf(triggerId)).toHaveLength(1);
  });

  it('restarts the count after a sleep: a long gap between two polls is not silence', async () => {
    const { world, lead } = await worldWithLead();
    await generatingChild(lead);
    const triggerId = await promptLeadOnSilence();
    letSilenceLast(SILENT_MINUTES - 2);

    world.advanceMs(SLEEP_GAP_MS + MINUTE_MS);
    world.fireLivingTimers();

    expect(world.firesOf(triggerId)).toEqual([]);
    letSilenceLast(SILENT_MINUTES - 1);
    expect(world.firesOf(triggerId)).toEqual([]);
    letSilenceLast(2);
    expect(world.firesOf(triggerId)).toHaveLength(1);
  });

  it('does not repeat the episode that fired when the sleep ends', async () => {
    const { world, lead } = await worldWithLead();
    await generatingChild(lead);
    const triggerId = await promptLeadOnSilence();
    letSilenceLast(SILENT_MINUTES + 1);

    world.advanceMs(SLEEP_GAP_MS + MINUTE_MS);
    world.fireLivingTimers();
    letSilenceLast(SILENT_MINUTES * 3);

    expect(world.firesOf(triggerId)).toHaveLength(1);
  });
});

describe('the transcript of the child', () => {
  const ONE_MINUTE = 1;
  const POLL_IN_MINUTES = SILENT_RUN_POLL_MS / MINUTE_MS;
  const letOnePollPass = () => letSilenceLast(POLL_IN_MINUTES);
  const setTranscriptOf = (child: { id: string }, cursor: { identity: string; offset: number } | undefined) => { handleOf(child.id).transcriptCursor = cursor; };

  it('takes a transcript that appears after the first look as the base: what it grows by afterwards is a sign of life', async () => {
    const { world, lead } = await worldWithLead();
    const child = await generatingChild(lead);
    const triggerId = await promptLeadOnSilence(ONE_MINUTE);

    for (const offset of [100, 200, 300, 400]) {
      setTranscriptOf(child, { identity: 'transcript', offset });
      letOnePollPass();
    }

    expect(world.firesOf(triggerId)).toEqual([]);
  });

  it('does not take the appearance of the transcript for a sign of life', async () => {
    const { world, lead } = await worldWithLead();
    const child = await generatingChild(lead);
    const triggerId = await promptLeadOnSilence(ONE_MINUTE);

    setTranscriptOf(child, { identity: 'transcript', offset: 100 });
    letOnePollPass();
    letOnePollPass();

    expect(world.firesOf(triggerId)).toHaveLength(1);
  });

  it('takes a transcript file that changes identity as a new base: not a silence reset, not a sign of life', async () => {
    const { world, lead } = await worldWithLead();
    const child = await generatingChild(lead);
    setTranscriptOf(child, { identity: 'first-file', offset: 10 });
    const triggerId = await promptLeadOnSilence(ONE_MINUTE);

    setTranscriptOf(child, { identity: 'second-file', offset: 500 });
    letOnePollPass();
    letOnePollPass();

    expect(world.firesOf(triggerId)).toHaveLength(1);
  });

  it('sees a sign of life in the growth of the file that replaced the first one', async () => {
    const { world, lead } = await worldWithLead();
    const child = await generatingChild(lead);
    setTranscriptOf(child, { identity: 'first-file', offset: 10 });
    const triggerId = await promptLeadOnSilence(ONE_MINUTE);

    setTranscriptOf(child, { identity: 'second-file', offset: 500 });
    letOnePollPass();
    setTranscriptOf(child, { identity: 'second-file', offset: 600 });
    letOnePollPass();

    expect(world.firesOf(triggerId)).toEqual([]);
  });
});

describe('the clock', () => {
  it('goes back without a sign of life: the silence ends when the clock passes its end again', async () => {
    const { world, lead } = await worldWithLead();
    await generatingChild(lead);
    const triggerId = await promptLeadOnSilence();
    letSilenceLast(SILENT_MINUTES - 1);

    world.setNowMs(world.nowMs - 10 * MINUTE_MS);
    letSilenceLast(SILENT_MINUTES);
    const firesWhileTheClockCatchesUp = world.firesOf(triggerId).length;
    letSilenceLast(SILENT_MINUTES + 2);

    expect(firesWhileTheClockCatchesUp).toBe(0);
    expect(world.firesOf(triggerId)).toHaveLength(1);
  });
});

describe('scope', () => {
  it('stays inside the project of the trigger', async () => {
    const { world, lead } = await worldWithLead();
    const child = await generatingChild(lead);
    world.db.prepare("INSERT INTO projects (id, name, created_at) VALUES ('other', 'Other', 'now')").run();
    world.db.prepare("UPDATE sessions SET project_id = 'other' WHERE id = ?").run(child.id);
    const triggerId = await promptLeadOnSilence();

    letSilenceLast(SILENT_MINUTES * 2);

    expect(world.firesOf(triggerId)).toEqual([]);
  });

  it('ignores a generating session that has no manager', async () => {
    const { world } = await worldWithLead();
    const orphan = await world.createSession('Orphan');
    await world.postHook(orphan.id, SESSION_START);
    await world.postHook(orphan.id, START_TURN);
    const triggerId = await promptLeadOnSilence();

    letSilenceLast(SILENT_MINUTES * 2);

    expect(world.firesOf(triggerId)).toEqual([]);
  });

  it('watches only the lineage of its owner', async () => {
    const { world, lead } = await worldWithLead();
    const otherLead = await world.createSession('Other lead', { manager: world.managerSpec });
    await generatingChild(otherLead, 'Not mine');
    const triggerId = await promptLeadOnSilence(SILENT_MINUTES, { ownerManagerId: lead.id });

    letSilenceLast(SILENT_MINUTES * 2);

    expect(world.firesOf(triggerId)).toEqual([]);
  });

  it('ignores a child whose lineage reaches a deleted owner through a living intermediate manager', async () => {
    const { world, lead: owner } = await worldWithLead();
    const intermediate = await world.createSession('Intermediate', { manager: world.managerSpec });
    world.db.prepare('UPDATE sessions SET parent_id = ? WHERE id = ?').run(owner.id, intermediate.id);
    await generatingChild(intermediate, 'Orphaned lineage');
    const triggerId = await promptLeadOnSilence(SILENT_MINUTES, { ownerManagerId: owner.id });
    world.db.prepare('UPDATE sessions SET parent_id = NULL WHERE parent_id = ? AND id != ?').run(owner.id, intermediate.id);
    world.db.prepare('PRAGMA foreign_keys = OFF').run();
    world.db.prepare('DELETE FROM sessions WHERE id = ?').run(owner.id);

    letSilenceLast(SILENT_MINUTES * 2);

    expect(world.firesOf(triggerId)).toEqual([]);
  });

  it('watches only the children of the manager the RUN names', async () => {
    const { world, lead } = await worldWithLead();
    const otherLead = await world.createSession('Other lead', { manager: world.managerSpec });
    await generatingChild(otherLead, 'Not named');
    const triggerId = await world.createArmedTrigger({ when: { source: 'silent_run', minutes: SILENT_MINUTES }, run: { kind: 'prompt_manager', managerId: lead.id, prompt: 'silent' } });

    letSilenceLast(SILENT_MINUTES * 2);

    expect(world.firesOf(triggerId)).toEqual([]);
  });
});

describe('the budget of a poll', () => {
  it('offers at most the budget in one poll and the rest at the next ones, each silent child once', async () => {
    const { world, lead } = await worldWithLead();
    const childCount = MAX_OFFERS_PER_TICK + 3;
    for (let index = 0; index < childCount; index += 1) await generatingChild(lead, `Worker ${index}`);
    const triggerId = await world.createArmedTrigger({ when: { source: 'silent_run', minutes: SILENT_MINUTES }, run: { kind: 'notify', title: 'Silent', message: 'A child is silent.' } });

    letSilenceLast(SILENT_MINUTES);
    const firesAtTheFirstPollOfTheDeadline = world.firesOf(triggerId).length;
    letSilenceLast(1);

    expect(firesAtTheFirstPollOfTheDeadline).toBe(MAX_OFFERS_PER_TICK);
    expect(world.firesOf(triggerId)).toHaveLength(childCount);
  });
});

describe('the cause of the silence', () => {
  it('does not fire again for a child the message of the same trigger set going', async () => {
    const { world, lead } = await worldWithLead();
    const child = await generatingChild(lead);
    const triggerId = await world.createArmedTrigger({
      when: { source: 'silent_run', minutes: SILENT_MINUTES }, ownerManagerId: lead.id, run: { kind: 'prompt_session', sessionId: child.id, prompt: 'report' },
    });
    letSilenceLast(SILENT_MINUTES + 1);

    await world.postHook(child.id, USE_TOOL);
    letSilenceLast(SILENT_MINUTES + 1);

    expect(world.firesOf(triggerId)).toHaveLength(1);
    expect(world.messagesTo(child.id).filter((message) => message.body.startsWith('trigger.fired'))).toHaveLength(1);
  });

  it('still fires for a child that a message of another trigger set going', async () => {
    const { world, lead } = await worldWithLead();
    const child = await generatingChild(lead);
    await world.createArmedTrigger({ title: 'other', when: { source: 'session_state', state: 'closed_with_error' }, ownerManagerId: lead.id, run: { kind: 'prompt_session', sessionId: child.id, prompt: 'hello' } });
    const triggerId = await promptLeadOnSilence();
    letSilenceLast(SILENT_MINUTES + 1);

    await world.postHook(child.id, USE_TOOL);
    letSilenceLast(SILENT_MINUTES + 1);

    expect(world.firesOf(triggerId).length).toBeGreaterThanOrEqual(1);
  });

  it('cancels the close of a silent child that is still generating: only an idle session is closed', async () => {
    const { world, lead } = await worldWithLead();
    const child = await generatingChild(lead);
    const triggerId = await world.createArmedTrigger({ when: { source: 'silent_run', minutes: SILENT_MINUTES }, ownerManagerId: lead.id, run: { kind: 'close_session', sessionId: child.id } });

    letSilenceLast(SILENT_MINUTES + 1);

    expect(world.firesOf(triggerId)).toEqual([expect.objectContaining({ ledger_state: 'cancelled', settle_reason: 'target_not_eligible' })]);
  });
});

describe('a slow cycle between two triggers', () => {
  const SLOW_MINUTES = 61;
  /** The message queue stamps the real clock; the ledger and the source live on the fake one. */
  const dateTriggerMessagesByTheFakeClock = () =>
    world!.db.prepare('UPDATE message_queue SET created_at = (SELECT fired_at FROM trigger_fires WHERE trigger_fires.id = message_queue.id) WHERE id IN (SELECT id FROM trigger_fires)').run();

  it('keeps the depth of the chain across silences longer than the hour the engine looks back on, and stops at the ceiling', async () => {
    const { world, lead } = await worldWithLead();
    const first = await generatingChild(lead, 'First');
    const second = await world.createChild(lead, 'Second');
    await world.postHook(second.id, SESSION_START);
    const promptTheOtherOnSilenceOf = (silent: { id: string }, other: { id: string }) => world.createArmedTrigger({
      when: { source: 'silent_run', minutes: SLOW_MINUTES }, conditions: [{ lhs: 'event.session.id', op: 'eq', rhs: silent.id }],
      ownerManagerId: lead.id, run: { kind: 'prompt_session', sessionId: other.id, prompt: 'look' },
    });
    const triggerOnFirst = await promptTheOtherOnSilenceOf(first, second);
    const triggerOnSecond = await promptTheOtherOnSilenceOf(second, first);

    letSilenceLast(SLOW_MINUTES + 1);
    dateTriggerMessagesByTheFakeClock();
    await world.postHook(second.id, START_TURN);
    letSilenceLast(SLOW_MINUTES + 1);
    dateTriggerMessagesByTheFakeClock();
    await world.postHook(first.id, USE_TOOL);
    letSilenceLast(SLOW_MINUTES + 1);

    expect(world.firesOf(triggerOnSecond)).toEqual([expect.objectContaining({ ledger_state: 'completed' })]);
    expect(world.firesOf(triggerOnFirst)).toEqual([
      expect.objectContaining({ ledger_state: 'completed' }), expect.objectContaining({ ledger_state: 'cancelled', settle_reason: 'chain_depth' }),
    ]);
    expect(bodiesTo(second.id)).toHaveLength(1);
  });
});

describe('the timer', () => {
  it('is one per armed trigger and none once the trigger is disarmed, edited or deleted', async () => {
    const { world, lead } = await worldWithLead();
    await generatingChild(lead);
    const first = await promptLeadOnSilence();
    const second = await promptLeadOnSilence(SILENT_MINUTES + 1);
    const countOfTimers = () => world.livingTimers().length;
    const withTwo = countOfTimers();

    await world.api(`/api/triggers/${first}/disarm`, { method: 'POST', body: '{}' });
    const afterDisarm = countOfTimers();
    await world.api(`/api/triggers/${second}`, { method: 'DELETE' });
    const afterDelete = countOfTimers();

    expect(withTwo).toBe(2);
    expect(afterDisarm).toBe(1);
    expect(afterDelete).toBe(0);
  });

  it('never stacks timers: a poll leaves exactly one', async () => {
    const { world, lead } = await worldWithLead();
    await generatingChild(lead);
    await promptLeadOnSilence();

    letSilenceLast(3);

    expect(world.livingTimers()).toHaveLength(1);
  });

  it('is set again at boot for an armed trigger, and the silence is counted from the boot', async () => {
    const { world, lead } = await worldWithLead();
    await generatingChild(lead);
    const triggerId = await promptLeadOnSilence();
    letSilenceLast(SILENT_MINUTES - 1);

    await world.restart({ stoppedForMs: 30 * MINUTE_MS });

    expect(world.livingTimers().length).toBeGreaterThanOrEqual(1);
    expect(world.firesOf(triggerId)).toEqual([]);
  });
});

describe('what the fire carries', () => {
  it('holds ids and closed values in the activity log, no name of a session', async () => {
    const { world, lead } = await worldWithLead();
    await generatingChild(lead, 'SecretNameOfTheWorker');
    await promptLeadOnSilence();

    letSilenceLast(SILENT_MINUTES + 1);

    const lines = JSON.stringify(world.db.prepare('SELECT * FROM activity_log').all());
    expect(lines).not.toContain('SecretNameOfTheWorker');
  });
});
