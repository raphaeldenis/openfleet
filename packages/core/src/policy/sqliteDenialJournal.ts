import type { DatabaseSync } from 'node:sqlite';
import type { DeniedCommand, DeniedCommandPage } from '@openfleet/shared';
import { newId } from '../ids.js';
import { redactedText } from '../logger.js';
import { maskedCommandSecrets } from './commandSecrets.js';
import { decodeDenialCursor, encodeDenialCursor } from './denialCursor.js';
import type { DenialDraft, DenialJournal, DenialQuery, DenialReader } from './ports.js';

export const MAX_COMMAND_EXCERPT_CHARS = 200;

export interface DenialRow {
  rowid: number;
  id: string;
  session_id: string;
  manager_id: string;
  role: string | null;
  profile: string;
  harness: DeniedCommand['harness'];
  rule_id: string;
  decision_source: DeniedCommand['decisionSource'];
  outcome: DeniedCommand['outcome'];
  tool_name: string;
  command_excerpt: string;
  alternative: string | null;
  actor: DeniedCommand['actor'];
  created_at: string;
}

export function denialOf(row: DenialRow): DeniedCommand {
  return {
    id: row.id,
    sessionId: row.session_id,
    managerId: row.manager_id,
    ...(row.role === null ? {} : { role: row.role }),
    profile: row.profile,
    harness: row.harness,
    ruleId: row.rule_id,
    decisionSource: row.decision_source,
    outcome: row.outcome,
    toolName: row.tool_name,
    commandExcerpt: row.command_excerpt,
    ...(row.alternative === null ? {} : { alternative: row.alternative }),
    actor: row.actor,
    createdAt: row.created_at,
  };
}

export class SqliteDenialJournal implements DenialJournal, DenialReader {
  constructor(private readonly deps: { db: DatabaseSync; clock: () => string }) {}

  record(draft: DenialDraft): DeniedCommand {
    const denial: DeniedCommand = {
      id: newId(),
      sessionId: draft.sessionId,
      managerId: draft.managerId,
      ...(draft.role === undefined ? {} : { role: draft.role }),
      profile: draft.profile,
      harness: draft.harness,
      ruleId: draft.ruleId,
      decisionSource: draft.decisionSource,
      outcome: draft.outcome,
      toolName: draft.toolName,
      commandExcerpt: redactedText(maskedCommandSecrets(draft.command)).slice(0, MAX_COMMAND_EXCERPT_CHARS),
      ...(draft.alternative === undefined ? {} : { alternative: draft.alternative }),
      actor: draft.actor,
      createdAt: this.deps.clock(),
    };
    this.deps.db.prepare(`INSERT INTO denied_commands (id, session_id, manager_id, role, profile, harness, rule_id, decision_source, outcome, tool_name, command_excerpt, alternative, actor, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(denial.id, denial.sessionId, denial.managerId, denial.role ?? null, denial.profile, denial.harness, denial.ruleId, denial.decisionSource, denial.outcome, denial.toolName, denial.commandExcerpt, denial.alternative ?? null, denial.actor, denial.createdAt);
    return denial;
  }

  /** Newest first; entries recorded at the same instant come back in the reverse order they were written. */
  list({ managerId, since, limit, cursor }: DenialQuery): DeniedCommandPage {
    const after = cursor === undefined ? undefined : decodeDenialCursor(cursor);
    const conditions: string[] = [];
    const values: (string | number)[] = [];
    if (managerId !== undefined) { conditions.push('manager_id = ?'); values.push(managerId); }
    if (since !== undefined) { conditions.push('created_at >= ?'); values.push(since); }
    if (after !== undefined) { conditions.push('(created_at < ? OR (created_at = ? AND rowid < ?))'); values.push(after.createdAt, after.createdAt, after.rowId); }
    const where = conditions.length === 0 ? '' : `WHERE ${conditions.join(' AND ')}`;
    const rows = this.deps.db.prepare(`SELECT rowid, * FROM denied_commands ${where} ORDER BY created_at DESC, rowid DESC LIMIT ?`)
      .all(...values, limit + 1) as unknown as DenialRow[];
    const pageRows = rows.slice(0, limit);
    const lastRow = pageRows.at(-1);
    const hasMore = rows.length > limit;
    const page: DeniedCommandPage = { items: pageRows.map(denialOf) };
    if (hasMore && lastRow !== undefined) page.nextCursor = encodeDenialCursor({ createdAt: lastRow.created_at, rowId: lastRow.rowid });
    return page;
  }
}
