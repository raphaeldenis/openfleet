import type { DatabaseSync } from 'node:sqlite';
import type { DeniedCommand } from '@openfleet/shared';
import { newId } from '../ids.js';
import { redactedText } from '../logger.js';
import type { DenialDraft, DenialJournal } from './ports.js';

export const MAX_COMMAND_EXCERPT_CHARS = 200;

export class SqliteDenialJournal implements DenialJournal {
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
      commandExcerpt: redactedText(draft.command).slice(0, MAX_COMMAND_EXCERPT_CHARS),
      ...(draft.alternative === undefined ? {} : { alternative: draft.alternative }),
      actor: draft.actor,
      createdAt: this.deps.clock(),
    };
    this.deps.db.prepare(`INSERT INTO denied_commands (id, session_id, manager_id, role, profile, harness, rule_id, decision_source, outcome, tool_name, command_excerpt, alternative, actor, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(denial.id, denial.sessionId, denial.managerId, denial.role ?? null, denial.profile, denial.harness, denial.ruleId, denial.decisionSource, denial.outcome, denial.toolName, denial.commandExcerpt, denial.alternative ?? null, denial.actor, denial.createdAt);
    return denial;
  }
}
