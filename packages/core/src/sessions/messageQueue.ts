import type { DatabaseSync } from 'node:sqlite';
import type { QueuedMessage } from '@openfleet/shared';
import { newId } from '../ids.js';

export class MessageQueue {
  constructor(private readonly db: DatabaseSync) {}

  enqueue(input: { sessionId: string; fromSessionId?: string; body: string }): QueuedMessage {
    const message: QueuedMessage = { id: newId(), sessionId: input.sessionId, fromSessionId: input.fromSessionId, body: input.body, status: 'queued', createdAt: new Date().toISOString() };
    this.db.prepare('INSERT INTO message_queue (id, session_id, from_session_id, body, status, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(message.id, message.sessionId, message.fromSessionId ?? null, message.body, message.status, message.createdAt);
    return message;
  }
  nextPending(sessionId: string): QueuedMessage | undefined {
    const row = this.db.prepare(`SELECT id, session_id, from_session_id, body, status, created_at FROM message_queue WHERE session_id = ? AND status = 'queued' ORDER BY created_at LIMIT 1`).get(sessionId) as
      { id: string; session_id: string; from_session_id: string | null; body: string; status: 'queued'; created_at: string } | undefined;
    if (!row) return undefined;
    return { id: row.id, sessionId: row.session_id, fromSessionId: row.from_session_id ?? undefined, body: row.body, status: row.status, createdAt: row.created_at };
  }
  markDelivered(id: string): void {
    this.db.prepare(`UPDATE message_queue SET status = 'delivered', delivered_at = ? WHERE id = ?`).run(new Date().toISOString(), id);
  }
}
