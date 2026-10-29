import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../db/database.js';
import { MessageQueue } from './messageQueue.js';

const databases: ReturnType<typeof openDatabase>[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });

const aQueueWith = (bodies: string[]) => {
  const db = openDatabase(':memory:');
  databases.push(db);
  db.prepare("INSERT INTO sessions (id, name, emoji, directory, harness, state, state_since, created_at, hook_token, mcp_token) VALUES ('s1', 'S', 'x', '/tmp', 'fake', 'waiting_input', 'now', 'now', 'h', 't')").run();
  const queue = new MessageQueue(db);
  for (const body of bodies) queue.enqueue({ sessionId: 's1', body });
  return queue;
};

describe('the daemon lines a session waiting on the human skips', () => {
  it('skips a [pulse] line and a [scheduled event line, and still finds a human message behind them', () => {
    const queue = aQueueWith(['[pulse] wake up', '[scheduled event "Nightly", due 2026-10-31T09:30:00] check', 'human hello']);

    const next = queue.nextPending('s1', { skipDaemonLines: true });

    expect(next?.body).toBe('human hello');
  });

  it('returns a scheduled event line when daemon lines are not skipped', () => {
    const queue = aQueueWith(['[scheduled event due 2026-10-31T09:30:00] check']);

    expect(queue.nextPending('s1')?.body).toContain('[scheduled event');
  });
});
