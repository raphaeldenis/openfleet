import { afterEach, describe, expect, it, vi } from 'vitest';
import { openDatabase } from '../db/database.js';
import { FakeHarness } from '../harness/fakeHarness.js';
import { EventBus } from '../events/eventBus.js';
import { SessionService, SUBMIT_KEYSTROKE_DELAY_MS } from './sessionService.js';

const DAEMON_LINES = [
  ['[pulse]', '[pulse] Re-read your mission and continue.'],
  ['[scheduled event', '[scheduled event "Nightly", due 2026-10-31T09:30:00] check the build'],
  ['[child_restarted]', '[child_restarted] "Dev" was restarted after a crash (restart 1 of 3).'],
  ['[child_restart_exhausted]', '[child_restart_exhausted] "Dev" crashed again after 3 restarts in 10 minutes: it stays closed.'],
  ['[harness_exited]', '[harness_exited] "Dev" crashed and could not be restarted: it stays closed.'],
  ['[sleep]', '[sleep] Note where things stand in your journal, schedule an event for everything that needs follow-up, then stop.'],
] as const;

const hook = (session_id: string, event: object) => ({ kind: 'hook' as const, event: { session_id, ...event } as never });

async function idleManager() {
  vi.useFakeTimers();
  const harness = new FakeHarness();
  const service = new SessionService({ db: openDatabase(':memory:'), bus: new EventBus(), harnesses: [harness], baseUrl: 'http://127.0.0.1:7331', worktreesRoot: '/tmp/of-wt' });
  const session = await service.create({ directory: '/tmp', name: 'M', harness: 'fake', emoji: '🤖' });
  const hookOf = (event: object) => service.applyInput(session.id, hook(session.id, event));
  hookOf({ hook_event_name: 'SessionStart' });
  const tell = (body: string) => service.sendMessage({ sessionId: session.id, body });
  const elapse = () => vi.advanceTimersByTimeAsync(SUBMIT_KEYSTROKE_DELAY_MS * 2);
  const hasTyped = (body: string) => harness.handles[0]!.written.some((chunk) => chunk.includes(body));
  const startWaitingOnTheHuman = () => hookOf({ hook_event_name: 'Notification', notification_type: 'agent_needs_input' });
  const humanAnswers = () => hookOf({ hook_event_name: 'Stop' });
  return { tell, elapse, hasTyped, startWaitingOnTheHuman, humanAnswers };
}

afterEach(() => vi.useRealTimers());

describe('a daemon line reaching a manager', () => {
  it.each(DAEMON_LINES)('types %s into an idle manager', async (_prefix, body) => {
    const { tell, elapse, hasTyped } = await idleManager();

    tell(body);
    await elapse();

    expect(hasTyped(body)).toBe(true);
  });

  it.each(DAEMON_LINES)('holds %s while the manager waits on the human', async (_prefix, body) => {
    const { tell, elapse, hasTyped, startWaitingOnTheHuman } = await idleManager();
    startWaitingOnTheHuman();

    tell(body);
    await elapse();

    expect(hasTyped(body)).toBe(false);
  });

  it.each(DAEMON_LINES)('types the held %s once the manager leaves waiting_input', async (_prefix, body) => {
    const { tell, elapse, hasTyped, startWaitingOnTheHuman, humanAnswers } = await idleManager();
    startWaitingOnTheHuman();
    tell(body);
    await elapse();

    humanAnswers();
    await elapse();

    expect(hasTyped(body)).toBe(true);
  });

  it('still types a human message to a manager waiting on the human', async () => {
    const { tell, elapse, hasTyped, startWaitingOnTheHuman } = await idleManager();
    startWaitingOnTheHuman();

    tell('yes, go ahead');
    await elapse();

    expect(hasTyped('yes, go ahead')).toBe(true);
  });
});
