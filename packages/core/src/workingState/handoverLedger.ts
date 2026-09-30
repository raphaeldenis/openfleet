import type { Handover, HandoverKind } from '@openfleet/shared';
import type { DatabaseSync } from 'node:sqlite';
import { createContext, Script } from 'node:vm';
import { inTransaction } from '../db/transaction.js';
import { newId } from '../ids.js';
import { log } from '../logger.js';
import { AGENT_MESSAGE_BEGIN } from '../sessions/messageEnvelope.js';

const PULSE_LINE_PREFIX = '[pulse]';
const MAX_NEW_HANDOVERS_PER_PROMPT = 10;
const MAX_VALUE_LENGTH = 500;
const MAX_LISTED_HANDOVERS = 50;
// ponytail: a prompt is scanned up to this length. A link past it is not recorded; raise it if a real paste needs it.
const MAX_SCANNED_PROMPT_LENGTH = 20_000;
// ponytail: a custom pattern scans each line up to this length, so a pattern that slipped past the boot checks stays bounded.
const MAX_CUSTOM_PATTERN_LINE_LENGTH = 2000;
const CUSTOM_PATTERN_BUDGET_MS = 50;
const DESIGN_LINK_PREFIX = 'https://claude.ai/design/';

const TOKEN_CHAR = '[^\\s"\'<>()`\\[\\]]';
const START_OF_TOKEN = `(?<!${TOKEN_CHAR})`;
// `.md` ends the token, optionally followed by sentence punctuation: specs/a.mdx and plans/b.md5 do not match.
const END_OF_MD_EXTENSION = `(?=[.,;:!?}]*(?!${TOKEN_CHAR}))`;
const DESIGN_LINK_PATTERN = new RegExp(`https://claude\\.ai/design/${TOKEN_CHAR}+`, 'g');
const DOC_PATH_PATTERN = new RegExp(`${START_OF_TOKEN}(?:${TOKEN_CHAR}{0,300}/)?(?:specs|plans)/${TOKEN_CHAR}{0,300}\\.md${END_OF_MD_EXTENSION}`, 'g');
export const DEFAULT_HANDOVER_PATTERNS: RegExp[] = [DESIGN_LINK_PATTERN, DOC_PATH_PATTERN];

const TRAILING_PUNCTUATION = /[.,;:!?)\]}>'"`]+$/;
const LINK_SCHEME = /^https?:\/\//;

export interface HandoverLedgerDeps { db: DatabaseSync; clock: () => string; patterns?: RegExp[] }

interface ScanWindow { text: string; offset: number; endsMidToken: boolean }
interface FoundValue { index: number; value: string }
interface RawMatch { index: number; text: string }

interface HandoverRow { id: string; session_id: string; kind: HandoverKind; value: string; created_at: string }

/** Records the links and spec paths a human hands to a session, once per session and value. */
export class HandoverLedger {
  private readonly patterns: RegExp[];
  private readonly hasCustomPatterns: boolean;
  private readonly patternsDisabledForTakingTooLong = new Set<RegExp>();

  constructor(private readonly deps: HandoverLedgerDeps) {
    this.patterns = deps.patterns ?? DEFAULT_HANDOVER_PATTERNS;
    this.hasCustomPatterns = deps.patterns !== undefined;
  }

  /** Records the values new to the session found in a human prompt and returns them; agent envelopes and pulses record nothing. */
  record({ sessionId, prompt }: { sessionId: string; prompt: string | undefined }): Handover[] {
    if (prompt === undefined || !isTypedByHuman(prompt)) return [];

    const valuesFound = this.valuesFoundIn(prompt);
    return inTransaction(this.deps.db, 'record_handovers', () => {
      const recorded: Handover[] = [];
      for (const value of valuesFound) {
        if (recorded.length === MAX_NEW_HANDOVERS_PER_PROMPT) break;
        const handover = this.insertIfNew({ sessionId, value });
        if (handover) recorded.push(handover);
      }
      return recorded;
    });
  }

  /** Returns the session's handovers, newest first, 50 at most. */
  list(sessionId: string): Handover[] {
    const rows = this.deps.db.prepare('SELECT id, session_id, kind, value, created_at FROM handovers WHERE session_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?')
      .all(sessionId, MAX_LISTED_HANDOVERS) as unknown as HandoverRow[];
    return rows.map(toHandover);
  }

  private valuesFoundIn(prompt: string): string[] {
    const matches = this.scanWindowsOf(prompt).flatMap((window) => this.patterns.flatMap((pattern) => this.findValuesIn(window, pattern)));
    const valuesInPromptOrder = matches.sort((a, b) => a.index - b.index).map((match) => match.value);
    const isStorable = (value: string) => value !== '' && value !== DESIGN_LINK_PREFIX && value.length <= MAX_VALUE_LENGTH;
    return valuesInPromptOrder.filter(isStorable);
  }

  private findValuesIn(window: ScanWindow, pattern: RegExp): FoundValue[] {
    const rawMatches = this.hasCustomPatterns ? this.customMatchesWithinBudget(window.text, pattern) : nativeMatches(window.text, pattern);
    const touchesCutEnd = (match: RawMatch) => window.endsMidToken && match.index + match.text.length === window.text.length;
    return rawMatches
      .filter((match) => !touchesCutEnd(match))
      .map((match) => ({ index: window.offset + match.index, value: match.text.replace(TRAILING_PUNCTUATION, '') }));
  }

  /** Runs an operator pattern under a time budget; a pattern that exceeds it is disabled until the daemon restarts. */
  private customMatchesWithinBudget(text: string, pattern: RegExp): RawMatch[] {
    const isBlankLine = text === '';
    if (isBlankLine || this.patternsDisabledForTakingTooLong.has(pattern)) return [];
    try {
      return matchWithinBudget(text, pattern);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ERR_SCRIPT_EXECUTION_TIMEOUT') throw error;
      this.patternsDisabledForTakingTooLong.add(pattern);
      log('warn', `handover pattern ${pattern} took more than ${CUSTOM_PATTERN_BUDGET_MS} ms on a prompt line and is disabled until the daemon restarts`);
      return [];
    }
  }

  private scanWindowsOf(prompt: string): ScanWindow[] {
    const scannedLength = Math.min(prompt.length, MAX_SCANNED_PROMPT_LENGTH);
    if (!this.hasCustomPatterns) return [scanWindow({ prompt, start: 0, end: scannedLength })];

    const windows: ScanWindow[] = [];
    let lineStart = 0;
    for (const line of prompt.slice(0, scannedLength).split('\n')) {
      const scannedLineLength = Math.min(line.length, MAX_CUSTOM_PATTERN_LINE_LENGTH);
      windows.push(scanWindow({ prompt, start: lineStart, end: lineStart + scannedLineLength }));
      lineStart += line.length + 1;
    }
    return windows;
  }

  private insertIfNew({ sessionId, value }: { sessionId: string; value: string }): Handover | undefined {
    const handover: Handover = { id: newId(), sessionId, kind: LINK_SCHEME.test(value) ? 'design_link' : 'doc_path', value, createdAt: this.deps.clock() };
    const { changes } = this.deps.db.prepare('INSERT INTO handovers (id, session_id, kind, value, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(session_id, value) DO NOTHING')
      .run(handover.id, handover.sessionId, handover.kind, handover.value, handover.createdAt);
    return changes === 0 ? undefined : handover;
  }
}

/** Builds the line that reminds the agent to note each new handover. */
export function handoverReminder(handovers: Handover[]): string {
  return handovers.map(({ value }) => `Handover recorded: ${oneLine(value)}. If you keep a backlog or notes, record it there in this turn.`).join('\n');
}

const LINE_BREAKING_OR_INVISIBLE_CHARACTERS = /[\s\p{Cc}\p{Cf}\u0085\u2028\u2029]+/gu;
const oneLine = (value: string) => value.replace(LINE_BREAKING_OR_INVISIBLE_CHARACTERS, ' ').trim();

function scanWindow({ prompt, start, end }: { prompt: string; start: number; end: number }): ScanWindow {
  const nextCharacter = prompt[end];
  const endsMidToken = nextCharacter !== undefined && !/\s/.test(nextCharacter);
  return { text: prompt.slice(start, end), offset: start, endsMidToken };
}

const matchScript = new Script('Array.from(text.matchAll(new RegExp(source, flags)), (match) => [match.index, match[0]])');
const matchSandbox = createContext({ text: '', source: '', flags: '' });

const nativeMatches = (text: string, pattern: RegExp): RawMatch[] => [...text.matchAll(pattern)].map((match) => ({ index: match.index!, text: match[0] }));

function matchWithinBudget(text: string, pattern: RegExp): RawMatch[] {
  Object.assign(matchSandbox, { text, source: pattern.source, flags: pattern.flags });
  const pairs = matchScript.runInContext(matchSandbox, { timeout: CUSTOM_PATTERN_BUDGET_MS }) as [number, string][];
  return pairs.map(([index, matched]) => ({ index, text: matched }));
}

function isTypedByHuman(prompt: string): boolean {
  const isAgentMessage = prompt.includes(AGENT_MESSAGE_BEGIN);
  const isDaemonPulse = prompt.trimStart().startsWith(PULSE_LINE_PREFIX);
  return !isAgentMessage && !isDaemonPulse;
}

const toHandover = (row: HandoverRow): Handover => ({ id: row.id, sessionId: row.session_id, kind: row.kind, value: row.value, createdAt: row.created_at });
