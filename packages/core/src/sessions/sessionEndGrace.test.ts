import { afterEach, describe, expect, it, vi } from 'vitest';
import { openDatabase } from '../db/database.js';
import { EventBus } from '../events/eventBus.js';
import { FakeHarness } from '../harness/fakeHarness.js';
import { SessionService } from './sessionService.js';

const LONG_GRACE_MS = 60_000;
const spec = { name: 'a', emoji: '🤖', directory: '/tmp', harness: 'fake' } as const;

afterEach(() => vi.useRealTimers());

async function bootWithLongGrace() {
  const harness = new FakeHarness();
  const sessions = new SessionService({ db: openDatabase(':memory:'), bus: new EventBus(), harnesses: [harness],
    baseUrl: 'http://127.0.0.1:0', worktreesRoot: '/tmp/of-wt', sessionEndExitGraceMs: LONG_GRACE_MS, clearFlushGraceMs: 0 });
  const session = await sessions.create(spec);
  harness.handles[0]!.exitsAsynchronously = true;
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  sessions.applyInput(session.id, { kind: 'hook', event: { session_id: session.id, hook_event_name: 'SessionEnd' } as never });
  return { sessions, session, handle: harness.handles[0]! };
}

describe('a SessionEnd grace that another close cuts short', () => {
  it.each([
    { label: 'a user close', close: (sessions: SessionService, id: string) => sessions.close(id) },
    { label: 'a daemon shutdown', close: (sessions: SessionService) => sessions.closeAll() },
  ])('ends at once on $label: one kill, and only the kill escalation timer is left waiting', async ({ close }) => {
    const { sessions, session, handle } = await bootWithLongGrace();
    handle.ignoresGracefulKill = true;
    const killEscalationTimers = 1;

    void close(sessions, session.id);
    await vi.advanceTimersByTimeAsync(1);

    expect(handle.killCount).toBe(1);
    expect(vi.getTimerCount()).toBe(killEscalationTimers);
  });
});
