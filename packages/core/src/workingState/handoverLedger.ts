import type { Handover, HandoverKind } from '@openfleet/shared';
import type { DatabaseSync } from 'node:sqlite';
import { newId } from '../ids.js';
import { AGENT_MESSAGE_BEGIN } from '../sessions/messageEnvelope.js';

const PULSE_LINE_PREFIX = '[pulse]';
const MAX_NEW_HANDOVERS_PER_PROMPT = 10;
const MAX_VALUE_LENGTH = 500;
const MAX_LISTED_HANDOVERS = 50;
// ponytail: a prompt is scanned up to this length. A link past it is not recorded; raise it if a real paste needs it.
const MAX_SCANNED_PROMPT_LENGTH = 20_000;

const TOKEN_CHAR = '[^\\s"\'<>()`\\[\\]]';
const START_OF_TOKEN = `(?<!${TOKEN_CHAR})`;
const DESIGN_LINK_PATTERN = new RegExp(`https://claude\\.ai/design/${TOKEN_CHAR}+`, 'g');
const DOC_PATH_PATTERN = new RegExp(`${START_OF_TOKEN}(?:${TOKEN_CHAR}{0,300}/)?(?:specs|plans)/${TOKEN_CHAR}{0,300}\\.md`, 'g');
export const DEFAULT_HANDOVER_PATTERNS: RegExp[] = [DESIGN_LINK_PATTERN, DOC_PATH_PATTERN];

const TRAILING_PUNCTUATION = /[.,;:!?)\]}>'"`]+$/;
const LINK_SCHEME = /^https?:\/\//;

export interface HandoverLedgerDeps { db: DatabaseSync; clock: () => string; patterns?: RegExp[] }

interface HandoverRow { id: string; session_id: string; kind: HandoverKind; value: string; created_at: string }

/** Records the links and spec paths a human hands to a session, once per session and value. */
export class HandoverLedger {
  private readonly patterns: RegExp[];

  constructor(private readonly deps: HandoverLedgerDeps) {
    this.patterns = deps.patterns ?? DEFAULT_HANDOVER_PATTERNS;
  }

  /** Records the values new to the session found in a human prompt and returns them; agent envelopes and pulses record nothing. */
  record({ sessionId, prompt }: { sessionId: string; prompt: string | undefined }): Handover[] {
    if (prompt === undefined || !isTypedByHuman(prompt)) return [];

    const recorded: Handover[] = [];
    for (const value of this.valuesFoundIn(prompt)) {
      if (recorded.length === MAX_NEW_HANDOVERS_PER_PROMPT) break;
      const handover = this.insertIfNew({ sessionId, value });
      if (handover) recorded.push(handover);
    }
    return recorded;
  }

  /** Returns the session's handovers, newest first, 50 at most. */
  list(sessionId: string): Handover[] {
    const rows = this.deps.db.prepare('SELECT id, session_id, kind, value, created_at FROM handovers WHERE session_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?')
      .all(sessionId, MAX_LISTED_HANDOVERS) as unknown as HandoverRow[];
    return rows.map(toHandover);
  }

  private valuesFoundIn(prompt: string): string[] {
    const scanned = prompt.slice(0, MAX_SCANNED_PROMPT_LENGTH);
    const matches = this.patterns.flatMap((pattern) => [...scanned.matchAll(pattern)].map((match) => ({ index: match.index, value: match[0].replace(TRAILING_PUNCTUATION, '') })));
    const valuesInPromptOrder = matches.sort((a, b) => a.index - b.index).map((match) => match.value);
    const isStorable = (value: string) => value !== '' && value.length <= MAX_VALUE_LENGTH;
    return valuesInPromptOrder.filter(isStorable);
  }

  private insertIfNew({ sessionId, value }: { sessionId: string; value: string }): Handover | undefined {
    const handover: Handover = { id: newId(), sessionId, kind: LINK_SCHEME.test(value) ? 'design_link' : 'doc_path', value, createdAt: this.deps.clock() };
    const { changes } = this.deps.db.prepare('INSERT INTO handovers (id, session_id, kind, value, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(session_id, value) DO NOTHING')
      .run(handover.id, handover.sessionId, handover.kind, handover.value, handover.createdAt);
    return changes === 0 ? undefined : handover;
  }
}

/** Builds the line that reminds the agent to open its backlog row for each new handover. */
export function handoverReminder(handovers: Handover[]): string {
  return handovers.map(({ value }) => `Handover recorded: ${value}. Open or update its backlog row in this turn.`).join('\n');
}

function isTypedByHuman(prompt: string): boolean {
  const isAgentMessage = prompt.includes(AGENT_MESSAGE_BEGIN);
  const isDaemonPulse = prompt.trimStart().startsWith(PULSE_LINE_PREFIX);
  return !isAgentMessage && !isDaemonPulse;
}

const toHandover = (row: HandoverRow): Handover => ({ id: row.id, sessionId: row.session_id, kind: row.kind, value: row.value, createdAt: row.created_at });
