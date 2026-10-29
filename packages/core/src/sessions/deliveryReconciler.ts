import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { textTypedByPaste } from '../harness/textTypedByPaste.js';

export type SubmissionVerdict = 'confirmed' | 'redeliver' | 'settled';

export function digestOfPrompt(prompt: string): string {
  return createHash('sha256').update(textTypedByPaste(prompt).trim()).digest('hex');
}

// A local slash command (/compact, /model...) starts no turn: no hook, no transcript line, so its silence is no evidence.
// Any body starting with `/` is excluded from the reconciliation, a pasted file path included: it is never sent twice,
// and never re-sent either.
function isLocalSlashCommand(body: string): boolean {
  return body.trim().startsWith('/');
}

// The digests of the user prompts a transcript tail holds, ignoring entries stamped before `since`. Total over hostile
// input: a line that is not JSON, not a main-chain user entry, or has an unexpected shape is skipped.
export function promptDigestsInTranscript({ tail, since }: { tail: string; since?: string }): Set<string> {
  const digests = new Set<string>();
  for (const line of tail.split('\n')) {
    for (const text of userTextsOfLine({ line, since })) digests.add(digestOfPrompt(text));
  }
  return digests;
}

function userTextsOfLine({ line, since }: { line: string; since?: string }): string[] {
  const entry = parseObject(line);
  const isStampedBeforeSince = since !== undefined && typeof entry?.timestamp === 'string' && Date.parse(entry.timestamp) < Date.parse(since);
  if (isStampedBeforeSince) return [];
  const isMainChainUserLine = entry?.type === 'user' && entry.isSidechain !== true;
  const content = isMainChainUserLine ? parseObject(entry.message)?.content : undefined;
  if (typeof content === 'string') return [content];
  if (!Array.isArray(content)) return [];
  return content.flatMap((part) => {
    const block = parseObject(part);
    return block?.type === 'text' && typeof block.text === 'string' ? [block.text] : [];
  });
}

function parseObject(value: unknown): Record<string, unknown> | undefined {
  const parsed = typeof value === 'string' ? safeJsonParse(value) : value;
  return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : undefined;
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

// Remembers, by SHA-256 only, which prompts each CLI session took and which messages the daemon submitted,
// and judges whether a submitted message reached its target. The prompt text is never stored.
export class DeliveryReconciler {
  constructor(private readonly db: DatabaseSync) {}

  recordPromptTaken({ sessionId, cliSessionId, prompt }: { sessionId: string; cliSessionId: string; prompt: string }): void {
    const digest = digestOfPrompt(prompt);
    const takenAt = new Date().toISOString();
    this.db.prepare(`INSERT INTO prompt_digests (cli_session_id, digest, recorded_at) VALUES (?, ?, ?)
      ON CONFLICT(cli_session_id, digest) DO UPDATE SET recorded_at = excluded.recorded_at`)
      .run(cliSessionId, digest, takenAt);
    this.db.prepare('UPDATE message_deliveries SET confirmed_at = ? WHERE session_id = ? AND digest = ? AND confirmed_at IS NULL')
      .run(takenAt, sessionId, digest);
  }

  recordSubmission({ messageId, sessionId, body }: { messageId: string; sessionId: string; body: string }): void {
    if (isLocalSlashCommand(body)) return;
    this.db.prepare(`INSERT INTO message_deliveries (message_id, session_id, digest, submitted_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(message_id) DO UPDATE SET submitted_at = excluded.submitted_at`)
      .run(messageId, sessionId, digestOfPrompt(body), new Date().toISOString());
  }

  // Called when the target stayed idle after the submission. A message is redelivered at most once, and never
  // once its digest is known: 'redeliver' is returned (and recorded) a single time per message.
  // Only a prompt taken since the submission counts: the same text taken earlier proves nothing about this message.
  judgeSubmission({ messageId, cliSessionId, transcriptDigestsSince }: { messageId: string; cliSessionId: string; transcriptDigestsSince: (since: string) => Set<string> }): SubmissionVerdict {
    const delivery = this.db.prepare('SELECT digest, submitted_at, confirmed_at, redelivered_at FROM message_deliveries WHERE message_id = ?').get(messageId) as
      { digest: string; submitted_at: string; confirmed_at: string | null; redelivered_at: string | null } | undefined;
    if (delivery === undefined || delivery.confirmed_at !== null) return 'settled';
    const isDigestRecordedSinceSubmission = this.db.prepare('SELECT 1 FROM prompt_digests WHERE cli_session_id = ? AND digest = ? AND recorded_at >= ?')
      .get(cliSessionId, delivery.digest, delivery.submitted_at) !== undefined;
    const isConfirmed = isDigestRecordedSinceSubmission || transcriptDigestsSince(delivery.submitted_at).has(delivery.digest);
    if (isConfirmed) {
      this.db.prepare('UPDATE message_deliveries SET confirmed_at = ? WHERE message_id = ?').run(new Date().toISOString(), messageId);
      return 'confirmed';
    }
    if (delivery.redelivered_at !== null) return 'settled';
    this.db.prepare('UPDATE message_deliveries SET redelivered_at = ? WHERE message_id = ?').run(new Date().toISOString(), messageId);
    return 'redeliver';
  }
}
