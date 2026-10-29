import { MANAGER_ROLE, type Session } from '@openfleet/shared';
import type { DatabaseSync } from 'node:sqlite';
import { log } from '../logger.js';
import { ASK_USER_QUESTION_TOOL } from '../policy/defaultCommandPolicy.js';
import type { DenialJournal } from '../policy/ports.js';
import type { ProjectRepository } from '../projects/projectRepository.js';
import type { AuditWriter } from './auditWriter.js';
import { ESCALATION_ITEM_PREFIX, humanReadableText } from './escalationBody.js';
import type { EscalationRepository } from './escalationRepository.js';
import { escalationPolicyOf } from './projectPolicy.js';

export const UNCLASSIFIED_QUESTION_RULE_ID = 'question-unclassified';
export const UNCLASSIFIED_QUESTION_JOURNAL_KIND = 'question_unclassified';
export const ASK_USER_GATE_AUTHOR = 'daemon';

const WORKING_STATE_TOOL = 'update_working_state';
const MILLISECONDS_PER_DAY = 86_400_000;
const MAX_EXCERPT_CHARS = 120;

const WARN_NOTICE = 'This question is not part of the escalation ladder: it is accepted, journaled and counted. Raise questions with submit_plan_questions so the daemon routes them; an unclassified question is journaled.';
const ENFORCE_NOTICE = ' The project sets askUserGate to enforce, but enforcement is a later slice: the question is accepted as in warn mode.';

export interface AskUserWeekCounts {
  /** ISO week, such as 2026-W44, from Monday 00:00 UTC. */
  week: string;
  managerQuestions: number;
  askUserQuestionAttempts: number;
}

export interface AskUserGateDeps {
  db: DatabaseSync;
  projects: Pick<ProjectRepository, 'get'>;
  repository: Pick<EscalationRepository, 'findEscalation'>;
  audit: Pick<AuditWriter, 'journal'>;
  denials: DenialJournal;
  clock: () => string;
}

const weekOf = (now: Date): { label: string; startsAt: string } => {
  const daysSinceMonday = (now.getUTCDay() + 6) % 7;
  const monday = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) - daysSinceMonday * MILLISECONDS_PER_DAY;
  const thursday = new Date(monday + 3 * MILLISECONDS_PER_DAY);
  const isoYear = thursday.getUTCFullYear();
  const daysSinceNewYear = Math.floor((thursday.getTime() - Date.UTC(isoYear, 0, 1)) / MILLISECONDS_PER_DAY);
  const weekNumber = Math.floor(daysSinceNewYear / 7) + 1;
  return { label: `${isoYear}-W${String(weekNumber).padStart(2, '0')}`, startsAt: new Date(monday).toISOString() };
};

const excerptOf = (text: string): string => {
  const readable = humanReadableText(text);
  return readable.length > MAX_EXCERPT_CHARS ? `${readable.slice(0, MAX_EXCERPT_CHARS - 1)}…` : readable;
};

/**
 * Warn mode of the gate on questions_for_human: a free-text question of a manager is accepted, logged, journaled (one line per call, author daemon)
 * and counted per manager and per week, next to its AskUserQuestion attempts. Nothing is refused: enforcement is a later slice.
 */
export class AskUserGate {
  constructor(private readonly deps: AskUserGateDeps) {}

  /** Answers the warning the manager reads, or undefined when the call adds no free-text question or the project turned the gate off. Never throws. */
  review({ manager, askedBefore, askedNow }: { manager: Session; askedBefore: readonly string[]; askedNow: readonly string[] }): string | undefined {
    try {
      return this.reviewOrThrow({ manager, askedBefore, askedNow });
    } catch (error) {
      log('warn', `ask user gate could not review the questions of manager ${manager.id}`, error);
      return undefined;
    }
  }

  weeklyCountsOf(managerId: string): AskUserWeekCounts {
    const { label, startsAt } = weekOf(new Date(this.deps.clock()));
    const counts = this.deps.db.prepare(`SELECT coalesce(sum(rule_id = ?), 0) AS managerQuestions, coalesce(sum(tool_name = ?), 0) AS askUserQuestionAttempts
      FROM denied_commands WHERE session_id = ? AND created_at >= ?`).get(UNCLASSIFIED_QUESTION_RULE_ID, ASK_USER_QUESTION_TOOL, managerId, startsAt) as { managerQuestions: number; askUserQuestionAttempts: number };
    return { week: label, ...counts };
  }

  private reviewOrThrow({ manager, askedBefore, askedNow }: { manager: Session; askedBefore: readonly string[]; askedNow: readonly string[] }): string | undefined {
    const isManager = manager.role === MANAGER_ROLE;
    const { askUserGate: mode } = escalationPolicyOf(this.deps.projects, manager.projectId);
    if (!isManager || mode === 'off') return undefined;

    const alreadyAsked = new Set(askedBefore);
    const freeTextQuestions = [...new Set(askedNow)].filter((item) => !alreadyAsked.has(item) && !this.isWrittenByTheDaemon({ managerId: manager.id, item }));
    if (freeTextQuestions.length === 0) return undefined;

    for (const question of freeTextQuestions) this.countQuestion({ manager, question });
    this.journalCall({ managerId: manager.id, freeTextQuestions });
    log('warn', `manager ${manager.id} wrote ${freeTextQuestions.length} free-text question(s) to questions_for_human outside the escalation ladder`);
    return mode === 'enforce' ? `${WARN_NOTICE}${ENFORCE_NOTICE}` : WARN_NOTICE;
  }

  private isWrittenByTheDaemon({ managerId, item }: { managerId: string; item: string }): boolean {
    if (!item.startsWith(ESCALATION_ITEM_PREFIX)) return false;
    const escalationId = item.slice(ESCALATION_ITEM_PREFIX.length).split(']')[0]!;
    return this.deps.repository.findEscalation(escalationId)?.managerId === managerId;
  }

  private countQuestion({ manager, question }: { manager: Session; question: string }): void {
    this.deps.denials.record({
      sessionId: manager.id, managerId: manager.id, role: MANAGER_ROLE, profile: MANAGER_ROLE, harness: manager.harness,
      ruleId: UNCLASSIFIED_QUESTION_RULE_ID, decisionSource: 'policy', outcome: 'observed', toolName: WORKING_STATE_TOOL, command: question, actor: 'session',
    });
  }

  private journalCall({ managerId, freeTextQuestions }: { managerId: string; freeTextQuestions: readonly string[] }): void {
    const { week, managerQuestions, askUserQuestionAttempts } = this.weeklyCountsOf(managerId);
    const [firstQuestion] = freeTextQuestions;
    const line = `${UNCLASSIFIED_QUESTION_JOURNAL_KIND}: ${freeTextQuestions.length} free-text question(s) in questions_for_human outside the ladder, accepted (askUserGate warn) · week ${week}: ${managerQuestions} manager question(s), ${askUserQuestionAttempts} AskUserQuestion attempt(s) · first: "${excerptOf(firstQuestion!)}"`;
    this.deps.audit.journal({ managerId, entries: [line], author: ASK_USER_GATE_AUTHOR });
  }
}
