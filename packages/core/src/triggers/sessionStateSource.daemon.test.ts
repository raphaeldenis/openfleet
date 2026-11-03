import { afterEach, describe, expect, it, vi } from 'vitest';
import { MINUTE_MS, startTriggerWorld, type TriggerWorld } from './triggerWorld.testkit.js';

let world: TriggerWorld | undefined;
afterEach(async () => { await world?.close(); world = undefined; });

/** The state of a session is stamped by the real clock a moment after the fake one started: a deadline is crossed with some room. */
const MARGIN_MS = 30_000;
const SESSION_START = { hook_event_name: 'SessionStart', source: 'startup' };
const ASK_PERMISSION = { hook_event_name: 'Notification', notification_type: 'permission_prompt' };
const START_TURN = { hook_event_name: 'UserPromptSubmit', prompt: 'work' };

const worldWithLead = async () => {
  world = await startTriggerWorld();
  const lead = await world.createSession('Lead', { manager: world.managerSpec });
  return { world, lead };
};
const promptLead = (title: string, when: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  world!.createArmedTrigger({ title, when, run: { kind: 'prompt_manager', prompt: `${title} {{event.session.name}}` }, ...extra });
/** What the triggers sent: the manager also receives the lines the daemon writes on its own, such as the one for an exited harness. */
const bodiesTo = (sessionId: string) => world!.messagesTo(sessionId).map((message) => message.body).filter((body) => body.startsWith('trigger.fired'));

describe('closed_with_error', () => {
  it('fires once for a child of a manager whose process crashed, and the manager is prompted with the name of the child', async () => {
    const { world, lead } = await worldWithLead();
    const child = await world.createChild(lead, 'Crashy');
    const triggerId = await promptLead('crash', { source: 'session_state', state: 'closed_with_error' });

    world.crash(child.id);

    await vi.waitFor(() => expect(world.firesOf(triggerId)).toEqual([expect.objectContaining({ ledger_state: 'completed' })]));
    expect(bodiesTo(lead.id)).toHaveLength(1);
    expect(bodiesTo(lead.id)[0]).toContain('crash Crashy');
  });

  it('does not fire for a session closed by the user, nor for a session that has no manager', async () => {
    const { world, lead } = await worldWithLead();
    const child = await world.createChild(lead, 'Closed by user');
    const orphan = await world.createSession('Orphan');
    const triggerId = await promptLead('crash', { source: 'session_state', state: 'closed_with_error' });

    await world.api(`/api/sessions/${child.id}/close`, { method: 'POST', body: '{}' });
    world.crash(orphan.id);
    await vi.waitFor(() => expect((world.db.prepare('SELECT state FROM sessions WHERE id = ?').get(orphan.id) as { state: string }).state).toBe('closed'));

    expect(world.firesOf(triggerId)).toEqual([]);
  });

  it('stays inside the project of the trigger', async () => {
    const { world, lead } = await worldWithLead();
    const child = await world.createChild(lead);
    world.db.prepare("INSERT INTO projects (id, name, created_at) VALUES ('other', 'Other', 'now')").run();
    const triggerId = await promptLead('crash', { source: 'session_state', state: 'closed_with_error' });
    world.db.prepare("UPDATE sessions SET project_id = 'other' WHERE id = ?").run(child.id);

    world.crash(child.id);
    await vi.waitFor(() => expect((world.db.prepare('SELECT state FROM sessions WHERE id = ?').get(child.id) as { state: string }).state).toBe('closed'));

    expect(world.firesOf(triggerId)).toEqual([]);
  });
});

describe('idle for more than N minutes', () => {
  it('fires when the child has been idle for the minutes, not before', async () => {
    const { world, lead } = await worldWithLead();
    const child = await world.createChild(lead);
    await world.postHook(child.id, SESSION_START);
    const triggerId = await promptLead('idle', { source: 'session_state', state: 'idle', minutes: 10 });

    world.advanceMs(9 * MINUTE_MS);
    const beforeDeadline = world.firesOf(triggerId).length;
    world.advanceMs(MINUTE_MS + MARGIN_MS);
    world.fireLivingTimers();

    expect(beforeDeadline).toBe(0);
    expect(world.firesOf(triggerId)).toEqual([expect.objectContaining({ ledger_state: 'completed' })]);
    expect(bodiesTo(lead.id)).toHaveLength(1);
  });

  it('forgets the wait when the child works again before the deadline', async () => {
    const { world, lead } = await worldWithLead();
    const child = await world.createChild(lead);
    await world.postHook(child.id, SESSION_START);
    const triggerId = await promptLead('idle', { source: 'session_state', state: 'idle', minutes: 10 });
    world.advanceMs(5 * MINUTE_MS);

    await world.postHook(child.id, START_TURN);
    const waitsLeftWhenItWorks = world.livingTimers().length;
    world.advanceMs(10 * MINUTE_MS);
    world.fireLivingTimers();

    expect(waitsLeftWhenItWorks).toBe(0);
    expect(world.firesOf(triggerId)).toEqual([]);
  });

  it('does not repeat the episode that fired when the daemon restarts: the ledger keeps its dedup key', async () => {
    const { world, lead } = await worldWithLead();
    const child = await world.createChild(lead);
    await world.postHook(child.id, SESSION_START);
    const triggerId = await promptLead('idle', { source: 'session_state', state: 'idle', minutes: 10 });
    world.advanceMs(10 * MINUTE_MS + MARGIN_MS);
    world.fireLivingTimers();
    const [firstEpisode] = world.firesOf(triggerId);

    await world.restart({ stoppedForMs: MINUTE_MS });

    const firesOfFirstEpisode = world.firesOf(triggerId).filter((fire) => fire.dedup_key === firstEpisode!.dedup_key);
    expect(firesOfFirstEpisode).toHaveLength(1);
    expect(bodiesTo(lead.id).length).toBeGreaterThanOrEqual(1);
  });

  it('starts counting when a trigger is armed after the child went idle', async () => {
    const { world, lead } = await worldWithLead();
    const child = await world.createChild(lead);
    await world.postHook(child.id, SESSION_START);
    world.advanceMs(20 * MINUTE_MS);

    const triggerId = await promptLead('idle', { source: 'session_state', state: 'idle', minutes: 10 });

    expect(world.firesOf(triggerId)).toEqual([expect.objectContaining({ ledger_state: 'completed' })]);
  });
});

describe('a deadline that came due while the daemon was stopped', () => {
  /** A child idle for 10 minutes, a 15-minute trigger, and a daemon that stays stopped for 20 minutes: the deadline fell 15 minutes before the boot. */
  const idleChildWithDeadlineMissed = async (policy: Record<string, unknown> = {}) => {
    const { world, lead } = await worldWithLead();
    const child = await world.createChild(lead);
    await world.postHook(child.id, SESSION_START);
    const triggerId = await promptLead('idle', { source: 'session_state', state: 'idle', minutes: 15 }, { policy });
    world.advanceMs(10 * MINUTE_MS);
    return { world, lead, child, triggerId };
  };
  const stateSinceOf = (sessionId: string) => (world!.db.prepare('SELECT state_since FROM sessions WHERE id = ?').get(sessionId) as { state_since: string }).state_since;

  it('fires once on the next boot, and not again on the boot after', async () => {
    const { world, lead, triggerId } = await idleChildWithDeadlineMissed();

    await world.restart({ stoppedForMs: 20 * MINUTE_MS });
    const afterFirstBoot = world.firesOf(triggerId).map((fire) => fire.ledger_state);
    await world.restart({ stoppedForMs: MINUTE_MS });

    expect(afterFirstBoot).toEqual(['completed']);
    expect(world.firesOf(triggerId)).toHaveLength(1);
    expect(bodiesTo(lead.id)).toHaveLength(1);
  });

  it('fires once when the daemon was killed, so the row still says idle since the start of the episode', async () => {
    const { world, lead, child, triggerId } = await idleChildWithDeadlineMissed();
    const episodeStart = stateSinceOf(child.id);

    await world.restart({
      stoppedForMs: 20 * MINUTE_MS,
      whileStopped: (db) => {
        db.prepare('DELETE FROM trigger_cursors').run();
        db.prepare("DELETE FROM session_events WHERE kind = 'daemon_shutdown' AND session_id = ?").run(child.id);
        db.prepare("UPDATE sessions SET state = 'idle', state_since = ?, closed_at = NULL, close_reason = NULL WHERE id = ?").run(episodeStart, child.id);
      },
    });

    expect(world.firesOf(triggerId)).toEqual([expect.objectContaining({ ledger_state: 'completed', dedup_key: `idle:${child.id}:${episodeStart}` })]);
    expect(bodiesTo(lead.id)).toHaveLength(1);
  });

  it('does not fire a deadline that has not come due: the episode is lost with the restart of the session, as before', async () => {
    const { world, triggerId } = await idleChildWithDeadlineMissed();

    await world.restart({ stoppedForMs: MINUTE_MS });

    expect(world.firesOf(triggerId)).toEqual([]);
  });

  it('measures the age of the backlog from the real deadline: discard_stale cancels it as stale and sends nothing', async () => {
    const { world, lead, triggerId } = await idleChildWithDeadlineMissed({ backlogPolicy: 'discard_stale', backlogMaxAgeMinutes: 5 });

    await world.restart({ stoppedForMs: 20 * MINUTE_MS });

    expect(world.firesOf(triggerId)).toEqual([expect.objectContaining({ ledger_state: 'cancelled', settle_reason: 'stale' })]);
    expect(bodiesTo(lead.id)).toEqual([]);
  });

  it('keeps only the latest episode with fire_latest_only and supersedes the others', async () => {
    const { world, lead, triggerId } = await idleChildWithDeadlineMissed({ backlogPolicy: 'fire_latest_only' });
    const secondChild = await world.createChild(lead, 'Second');
    await world.postHook(secondChild.id, SESSION_START);
    world.advanceMs(MINUTE_MS);

    await world.restart({ stoppedForMs: 20 * MINUTE_MS });

    expect(world.firesOf(triggerId).map((fire) => [fire.ledger_state, fire.settle_reason]).sort()).toEqual([['cancelled', 'superseded'], ['completed', null]]);
    expect(bodiesTo(lead.id)).toHaveLength(1);
  });

  describe('the cursors it was remembered with', () => {
    const cursorRowOf = (triggerId: string) => world!.db.prepare('SELECT cursor_json FROM trigger_cursors WHERE trigger_id = ?').get(triggerId) as { cursor_json: string } | undefined;

    it('keeps the episodes of the other triggers when one cursor is not valid JSON, and leaves that cursor in place', async () => {
      const { world, triggerId } = await idleChildWithDeadlineMissed();
      const triggerWithCorruptedCursor = await promptLead('other', { source: 'session_state', state: 'closed_with_error' });
      const corruptedJson = '{"episodes": [';

      await world.restart({
        stoppedForMs: 20 * MINUTE_MS,
        whileStopped: (db) => { db.prepare('INSERT INTO trigger_cursors (trigger_id, cursor_json) VALUES (?, ?)').run(triggerWithCorruptedCursor, corruptedJson); },
      });

      expect(world.firesOf(triggerId)).toEqual([expect.objectContaining({ ledger_state: 'completed' })]);
      expect(cursorRowOf(triggerWithCorruptedCursor)?.cursor_json).toBe(corruptedJson);
    });

    it('gives the episode of a cursor to the trigger it was written for, and to no other', async () => {
      const { world, lead, triggerId: rememberingTrigger } = await idleChildWithDeadlineMissed();
      const otherTrigger = await promptLead('idle too', { source: 'session_state', state: 'idle', minutes: 15 });

      await world.restart({
        stoppedForMs: 20 * MINUTE_MS,
        whileStopped: (db) => { db.prepare('DELETE FROM trigger_cursors WHERE trigger_id = ?').run(otherTrigger); },
      });

      expect(world.firesOf(rememberingTrigger)).toEqual([expect.objectContaining({ ledger_state: 'completed' })]);
      expect(world.firesOf(otherTrigger)).toEqual([]);
      expect(bodiesTo(lead.id)).toHaveLength(1);
    });

    it('ignores an episode whose date is not an ISO date, even one that Date.parse understands', async () => {
      const { world, child, triggerId } = await idleChildWithDeadlineMissed();
      const cursorWithLooseDate = JSON.stringify({ episodes: [{ sessionId: child.id, state: 'idle', stateSince: 'Jan 1 2020 00:00:00' }] });

      await world.restart({
        stoppedForMs: 20 * MINUTE_MS,
        whileStopped: (db) => { db.prepare('UPDATE trigger_cursors SET cursor_json = ? WHERE trigger_id = ?').run(cursorWithLooseDate, triggerId); },
      });

      expect(world.firesOf(triggerId)).toEqual([]);
    });
  });

  it('fires once for a child whose process closed with an error while the daemon was stopped', async () => {
    const { world, lead } = await worldWithLead();
    const child = await world.createChild(lead, 'Crashy');
    const triggerId = await promptLead('crash', { source: 'session_state', state: 'closed_with_error' });

    await world.restart({
      stoppedForMs: MINUTE_MS,
      whileStopped: (db) => {
        db.prepare("DELETE FROM session_events WHERE kind = 'daemon_shutdown' AND session_id = ?").run(child.id);
        db.prepare("UPDATE sessions SET state = 'closed', close_reason = 'harness_exit', closed_at = ? WHERE id = ?").run(new Date(world.nowMs + 30_000).toISOString(), child.id);
      },
    });
    await world.restart({ stoppedForMs: MINUTE_MS });

    expect(world.firesOf(triggerId)).toEqual([expect.objectContaining({ ledger_state: 'completed' })]);
    expect(bodiesTo(lead.id)).toHaveLength(1);
  });
});

describe('waiting_permission for more than N minutes', () => {
  it('fires when the child sits on a permission prompt for the minutes', async () => {
    const { world, lead } = await worldWithLead();
    const child = await world.createChild(lead);
    await world.postHook(child.id, SESSION_START);
    await world.postHook(child.id, START_TURN);
    await world.postHook(child.id, ASK_PERMISSION);
    expect((world.db.prepare('SELECT state FROM sessions WHERE id = ?').get(child.id) as { state: string }).state).toBe('waiting_permission');
    const triggerId = await promptLead('blocked', { source: 'session_state', state: 'waiting_permission', minutes: 5 });

    world.advanceMs(5 * MINUTE_MS + MARGIN_MS);
    world.fireLivingTimers();

    expect(world.firesOf(triggerId)).toEqual([expect.objectContaining({ ledger_state: 'completed' })]);
    expect(bodiesTo(lead.id)[0]).toContain('state=waiting_permission');
  });
});
