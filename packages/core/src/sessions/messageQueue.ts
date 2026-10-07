import type { DatabaseSync } from 'node:sqlite';
import type { QueuedMessage } from '@openfleet/shared';
import { newId } from '../ids.js';

export class MessageQueue {
  constructor(private readonly db: DatabaseSync) {}

  enqueue(input: { id?: string; sessionId: string; fromSessionId?: string; body: string }): QueuedMessage {
    const message: QueuedMessage = { id: input.id ?? newId(), sessionId: input.sessionId, fromSessionId: input.fromSessionId, body: input.body, status: 'queued', createdAt: new Date().toISOString() };
    this.db.prepare('INSERT INTO message_queue (id, session_id, from_session_id, body, status, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(message.id, message.sessionId, message.fromSessionId ?? null, message.body, message.status, message.createdAt);
    return message;
  }
  getById(id: string): QueuedMessage | undefined {
    const row = this.db.prepare(`SELECT id, session_id, from_session_id, body, status, created_at, delivered_at FROM message_queue WHERE id = ?`).get(id) as
      { id: string; session_id: string; from_session_id: string | null; body: string; status: 'queued' | 'delivered'; created_at: string; delivered_at: string | null } | undefined;
    if (!row) return undefined;
    return { id: row.id, sessionId: row.session_id, fromSessionId: row.from_session_id ?? undefined, body: row.body, status: row.status, createdAt: row.created_at, deliveredAt: row.delivered_at ?? undefined };
  }
  hasQueued(sessionId: string, body: string): boolean {
    const row = this.db.prepare(`SELECT 1 FROM message_queue WHERE session_id = ? AND status = 'queued' AND body = ? LIMIT 1`).get(sessionId, body);
    return row !== undefined;
  }
  // True when the message was still queued and now carries the new body.
  replaceQueuedBody(id: string, body: string): boolean {
    const result = this.db.prepare(`UPDATE message_queue SET body = ? WHERE id = ? AND status = 'queued'`).run(body, id);
    return Number(result.changes) > 0;
  }
  nextPending(sessionId: string, options: { skipDaemonLines?: boolean } = {}): QueuedMessage | undefined {
    const daemonLineFilter = options.skipDaemonLines ? `AND body NOT LIKE '[pulse]%'` : '';
    const row = this.db.prepare(`SELECT id, session_id, from_session_id, body, status, created_at FROM message_queue WHERE session_id = ? AND status = 'queued' ${daemonLineFilter} ORDER BY created_at LIMIT 1`).get(sessionId) as
      { id: string; session_id: string; from_session_id: string | null; body: string; status: 'queued'; created_at: string } | undefined;
    if (!row) return undefined;
    return { id: row.id, sessionId: row.session_id, fromSessionId: row.from_session_id ?? undefined, body: row.body, status: row.status, createdAt: row.created_at };
  }
  listQueued(sessionId: string): QueuedMessage[] {
    const rows = this.db.prepare(`SELECT id, session_id, from_session_id, body, created_at FROM message_queue WHERE session_id = ? AND status = 'queued' ORDER BY created_at`).all(sessionId) as
      { id: string; session_id: string; from_session_id: string | null; body: string; created_at: string }[];
    return rows.map((row) => ({ id: row.id, sessionId: row.session_id, fromSessionId: row.from_session_id ?? undefined, body: row.body, status: 'queued', createdAt: row.created_at }));
  }
  // True when the message was still queued for the session and is now gone.
  discardQueued(input: { sessionId: string; messageId: string }): boolean {
    const result = this.db.prepare(`DELETE FROM message_queue WHERE id = ? AND session_id = ? AND status = 'queued'`).run(input.messageId, input.sessionId);
    return Number(result.changes) > 0;
  }
  discardQueuedDaemonLines(sessionId: string): void {
    this.db.prepare(`DELETE FROM message_queue WHERE session_id = ? AND status = 'queued' AND body LIKE '[pulse]%'`).run(sessionId);
  }
  markDelivered(id: string): void {
    this.db.prepare(`UPDATE message_queue SET status = 'delivered', delivered_at = ? WHERE id = ?`).run(new Date().toISOString(), id);
  }
  countPending(sessionId: string): number {
    const row = this.db.prepare(`SELECT count(*) AS n FROM message_queue WHERE session_id = ? AND status = 'queued'`).get(sessionId) as { n: number };
    return row.n;
  }
  countPendingFromSender(input: { sessionId: string; fromSessionId: string }): number {
    const row = this.db.prepare(`SELECT count(*) AS n FROM message_queue WHERE session_id = ? AND from_session_id = ? AND status = 'queued'`).get(input.sessionId, input.fromSessionId) as { n: number };
    return row.n;
  }
}
