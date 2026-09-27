import { describe, expect, it } from 'vitest';
import { openDatabase } from '../db/database.js';
import { MessageQueue } from './messageQueue.js';

describe('MessageQueue.countPending', () => {
  it('counts only queued messages for the given session', () => {
    const db = openDatabase(':memory:');
    db.prepare(`INSERT INTO sessions (id, name, directory, harness, state, state_since, hook_token, mcp_token, created_at) VALUES ('s1','G','/tmp','fake','idle','t','h1','m1','t')`).run();
    const queue = new MessageQueue(db);
    const first = queue.enqueue({ sessionId: 's1', body: 'a' });
    queue.enqueue({ sessionId: 's1', body: 'b' });
    expect(queue.countPending('s1')).toBe(2);
    queue.markDelivered(first.id);
    expect(queue.countPending('s1')).toBe(1);
  });

  it('is zero for a session with no queued messages', () => {
    const db = openDatabase(':memory:');
    expect(new MessageQueue(db).countPending('nope')).toBe(0);
  });
});

describe('MessageQueue.enqueue with an explicit id', () => {
  it('stores the message under the caller-supplied id instead of minting one', () => {
    const db = openDatabase(':memory:');
    db.prepare(`INSERT INTO sessions (id, name, directory, harness, state, state_since, hook_token, mcp_token, created_at) VALUES ('s1','G','/tmp','fake','idle','t','h1','m1','t')`).run();
    const queue = new MessageQueue(db);
    const message = queue.enqueue({ id: 'fixed-id', sessionId: 's1', body: 'a' });
    expect(message.id).toBe('fixed-id');
    expect(queue.getById('fixed-id')?.body).toBe('a');
  });
});

describe('MessageQueue.getById', () => {
  it('returns undefined for an id that was never enqueued', () => {
    const db = openDatabase(':memory:');
    expect(new MessageQueue(db).getById('nope')).toBeUndefined();
  });

  it('reflects delivered status once the message is marked delivered', () => {
    const db = openDatabase(':memory:');
    db.prepare(`INSERT INTO sessions (id, name, directory, harness, state, state_since, hook_token, mcp_token, created_at) VALUES ('s1','G','/tmp','fake','idle','t','h1','m1','t')`).run();
    const queue = new MessageQueue(db);
    const message = queue.enqueue({ sessionId: 's1', body: 'a' });
    expect(queue.getById(message.id)?.status).toBe('queued');
    queue.markDelivered(message.id);
    expect(queue.getById(message.id)?.status).toBe('delivered');
  });
});
