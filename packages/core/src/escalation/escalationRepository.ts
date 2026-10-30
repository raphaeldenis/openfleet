import type { DatabaseSync } from 'node:sqlite';
import type { EscalatingClass, EscalationHandoverRefusal, ReproClaim } from '@openfleet/shared';
import type { QuestionRoute } from './questionRouting.js';

export const QUESTION_STATUSES = ['open', 'decided', 'self_resolved', 'pending_human', 'answered'] as const;
export type QuestionStatus = (typeof QUESTION_STATUSES)[number];

export type CriteriaOpinion = 'favourable' | 'unfavourable' | 'not_asked';

export interface NewBatch {
  id: string;
  managerId: string;
  ticket: string;
  planNoteId: string;
  planNoteRev: number;
  createdAt: string;
}

export interface StoredBatch extends NewBatch {
  arbiterRuns: number;
  /** Absent until the arbiter gives its opinion on the criteria. */
  criteriaOpinion?: { opinion: CriteriaOpinion; reasons: string[] };
}

export interface NewQuestion {
  batchId: string;
  questionId: string;
  text: string;
  /** The class as the manager wrote it, even when it is outside the vocabulary. */
  declaredClass: string;
  computedClasses: EscalatingClass[];
  effectiveClasses: EscalatingClass[];
  route: QuestionRoute;
  status: QuestionStatus;
  reason?: string;
  options?: string[];
  recommendation?: string;
  paths?: string[];
  resolution?: ReproClaim;
  /** The question whose arbiter decision this question contests; both are set together. */
  reopensBatchId?: string;
  reopensQuestionId?: string;
}

export interface StoredQuestion extends NewQuestion {
  escalationId?: string;
  humanAnswer?: string;
  answeredAt?: string;
}

export interface NewEscalation {
  id: string;
  managerId: string;
  ticket: string;
  body: string;
  createdAt: string;
}

export interface StoredEscalation extends NewEscalation {
  status: 'pending' | 'answered';
  resolvedAt?: string;
  handoverRefusal?: EscalationHandoverRefusal;
}

export interface NewArbiterDecision {
  batchId: string;
  questionId: string;
  verdict: 'decided' | 'needs_human';
  decision: string;
  rationale: string;
  raiseTo?: EscalatingClass;
  evidence?: ReproClaim;
  arbiterSessionId: string;
  planNoteRev: number;
  createdAt: string;
}

interface BatchRow {
  id: string; manager_id: string; ticket: string; plan_note_id: string; plan_note_rev: number; arbiter_runs: number;
  criteria_opinion: CriteriaOpinion | null; criteria_reasons_json: string | null; created_at: string;
}

interface QuestionRow {
  batch_id: string; question_id: string; text: string; declared_class: string; computed_classes_json: string; effective_classes_json: string;
  route: QuestionRoute; status: QuestionStatus; reason: string | null; options_json: string | null; recommendation: string | null;
  paths_json: string | null; resolution_json: string | null; escalation_id: string | null; human_answer: string | null; answered_at: string | null;
  reopens_batch_id: string | null; reopens_question_id: string | null;
}

interface EscalationRow {
  id: string; manager_id: string; ticket: string; status: 'pending' | 'answered'; body: string; created_at: string; resolved_at: string | null;
  handover_refusal_json: string | null;
}

interface DecisionRow {
  batch_id: string; question_id: string; verdict: 'decided' | 'needs_human'; decision: string; rationale: string; raise_to: EscalatingClass | null;
  evidence_json: string | null; arbiter_session_id: string; plan_note_rev: number; created_at: string;
}

const jsonOrNull = (value: unknown): string | null => (value === undefined ? null : JSON.stringify(value));

const toBatch = (row: BatchRow): StoredBatch => ({
  id: row.id, managerId: row.manager_id, ticket: row.ticket, planNoteId: row.plan_note_id, planNoteRev: row.plan_note_rev, arbiterRuns: row.arbiter_runs, createdAt: row.created_at,
  ...(row.criteria_opinion !== null && { criteriaOpinion: { opinion: row.criteria_opinion, reasons: JSON.parse(row.criteria_reasons_json!) as string[] } }),
});

const toQuestion = (row: QuestionRow): StoredQuestion => ({
  batchId: row.batch_id, questionId: row.question_id, text: row.text, declaredClass: row.declared_class,
  computedClasses: JSON.parse(row.computed_classes_json) as EscalatingClass[], effectiveClasses: JSON.parse(row.effective_classes_json) as EscalatingClass[],
  route: row.route, status: row.status,
  ...(row.reason !== null && { reason: row.reason }),
  ...(row.options_json !== null && { options: JSON.parse(row.options_json) as string[] }),
  ...(row.recommendation !== null && { recommendation: row.recommendation }),
  ...(row.paths_json !== null && { paths: JSON.parse(row.paths_json) as string[] }),
  ...(row.resolution_json !== null && { resolution: JSON.parse(row.resolution_json) as ReproClaim }),
  ...(row.escalation_id !== null && { escalationId: row.escalation_id }),
  ...(row.human_answer !== null && { humanAnswer: row.human_answer }),
  ...(row.answered_at !== null && { answeredAt: row.answered_at }),
  ...(row.reopens_batch_id !== null && row.reopens_question_id !== null && { reopensBatchId: row.reopens_batch_id, reopensQuestionId: row.reopens_question_id }),
});

const toEscalation = (row: EscalationRow): StoredEscalation => ({
  id: row.id, managerId: row.manager_id, ticket: row.ticket, status: row.status, body: row.body, createdAt: row.created_at,
  ...(row.resolved_at !== null && { resolvedAt: row.resolved_at }),
  ...(row.handover_refusal_json !== null && { handoverRefusal: JSON.parse(row.handover_refusal_json) as EscalationHandoverRefusal }),
});

const toDecision = (row: DecisionRow): NewArbiterDecision => ({
  batchId: row.batch_id, questionId: row.question_id, verdict: row.verdict, decision: row.decision, rationale: row.rationale,
  ...(row.raise_to !== null && { raiseTo: row.raise_to }),
  ...(row.evidence_json !== null && { evidence: JSON.parse(row.evidence_json) as ReproClaim }),
  arbiterSessionId: row.arbiter_session_id, planNoteRev: row.plan_note_rev, createdAt: row.created_at,
});

/** The tables of the escalation ladder: the batches of questions a manager submits, the arbiter's decisions and the escalations that reach a human. */
export class EscalationRepository {
  constructor(private readonly db: DatabaseSync) {}

  insertBatch(batch: NewBatch): void {
    this.db.prepare('INSERT INTO plan_question_batches (id, manager_id, ticket, plan_note_id, plan_note_rev, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(batch.id, batch.managerId, batch.ticket, batch.planNoteId, batch.planNoteRev, batch.createdAt);
  }

  findBatch(id: string): StoredBatch | undefined {
    const row = this.db.prepare('SELECT * FROM plan_question_batches WHERE id = ?').get(id) as BatchRow | undefined;
    return row ? toBatch(row) : undefined;
  }

  /** Every batch a manager submitted on a ticket, oldest first. */
  batchesOfTicket({ managerId, ticket }: { managerId: string; ticket: string }): StoredBatch[] {
    return (this.db.prepare('SELECT * FROM plan_question_batches WHERE manager_id = ? AND ticket = ? ORDER BY rowid').all(managerId, ticket) as unknown as BatchRow[]).map(toBatch);
  }

  addArbiterRun(batchId: string): void {
    this.db.prepare('UPDATE plan_question_batches SET arbiter_runs = arbiter_runs + 1 WHERE id = ?').run(batchId);
  }

  arbiterRunsOfTicket({ managerId, ticket }: { managerId: string; ticket: string }): number {
    const { runs } = this.db.prepare('SELECT coalesce(sum(arbiter_runs), 0) AS runs FROM plan_question_batches WHERE manager_id = ? AND ticket = ?').get(managerId, ticket) as { runs: number };
    return runs;
  }

  recordCriteriaOpinion({ batchId, opinion, reasons }: { batchId: string; opinion: CriteriaOpinion; reasons: string[] }): void {
    this.db.prepare('UPDATE plan_question_batches SET criteria_opinion = ?, criteria_reasons_json = ? WHERE id = ?').run(opinion, JSON.stringify(reasons), batchId);
  }

  insertQuestion(question: NewQuestion): void {
    this.db.prepare(`INSERT INTO plan_questions (batch_id, question_id, text, declared_class, computed_classes_json, effective_classes_json, route, status, reason, options_json, recommendation, paths_json, resolution_json, reopens_batch_id, reopens_question_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        question.batchId, question.questionId, question.text, question.declaredClass, JSON.stringify(question.computedClasses), JSON.stringify(question.effectiveClasses),
        question.route, question.status, question.reason ?? null, jsonOrNull(question.options), question.recommendation ?? null, jsonOrNull(question.paths), jsonOrNull(question.resolution),
        question.reopensBatchId ?? null, question.reopensQuestionId ?? null,
      );
  }

  /** The most recent question with this id that the arbiter decided on a ticket of the manager; an older decided question with the same id is never returned while a newer one exists. */
  decidedQuestionForReopen({ managerId, ticket, questionId }: { managerId: string; ticket: string; questionId: string }): StoredQuestion | undefined {
    const row = this.db.prepare(`SELECT question.* FROM plan_questions AS question JOIN plan_question_batches AS batch ON batch.id = question.batch_id
      WHERE batch.manager_id = ? AND batch.ticket = ? AND question.question_id = ? AND question.status = 'decided' ORDER BY question.rowid DESC LIMIT 1`)
      .get(managerId, ticket, questionId) as QuestionRow | undefined;
    return row ? toQuestion(row) : undefined;
  }

  /** Whether a later question already contests the arbiter decision of this question. */
  isReopened({ batchId, questionId }: { batchId: string; questionId: string }): boolean {
    const row = this.db.prepare('SELECT 1 AS found FROM plan_questions WHERE reopens_batch_id = ? AND reopens_question_id = ? LIMIT 1').get(batchId, questionId);
    return row !== undefined;
  }

  questionsOfBatch(batchId: string): StoredQuestion[] {
    return (this.db.prepare('SELECT * FROM plan_questions WHERE batch_id = ? ORDER BY rowid').all(batchId) as unknown as QuestionRow[]).map(toQuestion);
  }

  /** The batches that still have a question waiting for the arbiter, oldest first. */
  batchIdsWithOpenArbiterQuestions(): string[] {
    const rows = this.db.prepare("SELECT DISTINCT batch_id FROM plan_questions WHERE route = 'arbiter' AND status = 'open' ORDER BY rowid").all() as { batch_id: string }[];
    return rows.map(({ batch_id }) => batch_id);
  }

  /** The questions an escalation carries, across the batches that joined it, oldest first. */
  questionsOfEscalation(escalationId: string): StoredQuestion[] {
    return (this.db.prepare('SELECT * FROM plan_questions WHERE escalation_id = ? ORDER BY rowid').all(escalationId) as unknown as QuestionRow[]).map(toQuestion);
  }

  /** Moves a question that is still in `from` to `to` in one statement; false when it was no longer in `from`. */
  transitionQuestion({ batchId, questionId, from, to, reason, humanAnswer, answeredAt }: {
    batchId: string; questionId: string; from: QuestionStatus; to: QuestionStatus; reason?: string; humanAnswer?: string; answeredAt?: string;
  }): boolean {
    const { changes } = this.db.prepare(`UPDATE plan_questions SET status = ?, reason = coalesce(?, reason), human_answer = coalesce(?, human_answer), answered_at = coalesce(?, answered_at)
      WHERE batch_id = ? AND question_id = ? AND status = ?`)
      .run(to, reason ?? null, humanAnswer ?? null, answeredAt ?? null, batchId, questionId, from);
    return changes === 1;
  }

  /** Hands a question that is still open to the human with the given classes in one statement; false when it was no longer open. */
  deferOpenQuestionToHuman({ batchId, questionId, effectiveClasses, reason }: { batchId: string; questionId: string; effectiveClasses: EscalatingClass[]; reason: string }): boolean {
    const { changes } = this.db.prepare("UPDATE plan_questions SET status = 'pending_human', reason = ?, effective_classes_json = ? WHERE batch_id = ? AND question_id = ? AND status = 'open'")
      .run(reason, JSON.stringify(effectiveClasses), batchId, questionId);
    return changes === 1;
  }

  attachQuestionToEscalation({ batchId, questionId, escalationId }: { batchId: string; questionId: string; escalationId: string }): void {
    this.db.prepare('UPDATE plan_questions SET escalation_id = ? WHERE batch_id = ? AND question_id = ?').run(escalationId, batchId, questionId);
  }

  /** Throws when the manager already has a pending escalation on the ticket: the partial unique index allows one. */
  insertEscalation(escalation: NewEscalation): void {
    this.db.prepare("INSERT INTO escalations (id, manager_id, ticket, status, body, created_at) VALUES (?, ?, ?, 'pending', ?, ?)")
      .run(escalation.id, escalation.managerId, escalation.ticket, escalation.body, escalation.createdAt);
  }

  findEscalation(id: string): StoredEscalation | undefined {
    const row = this.db.prepare('SELECT * FROM escalations WHERE id = ?').get(id) as EscalationRow | undefined;
    return row ? toEscalation(row) : undefined;
  }

  findPendingEscalation({ managerId, ticket }: { managerId: string; ticket: string }): StoredEscalation | undefined {
    const row = this.db.prepare("SELECT * FROM escalations WHERE manager_id = ? AND ticket = ? AND status = 'pending'").get(managerId, ticket) as EscalationRow | undefined;
    return row ? toEscalation(row) : undefined;
  }

  /** The escalations of every manager in the given status, oldest first. */
  escalationsWithStatus(status: StoredEscalation['status']): StoredEscalation[] {
    return (this.db.prepare('SELECT * FROM escalations WHERE status = ? ORDER BY created_at, rowid').all(status) as unknown as EscalationRow[]).map(toEscalation);
  }

  escalationsOfManager(managerId: string): StoredEscalation[] {
    return (this.db.prepare('SELECT * FROM escalations WHERE manager_id = ? ORDER BY created_at, rowid').all(managerId) as unknown as EscalationRow[]).map(toEscalation);
  }

  updateEscalationBody({ id, body }: { id: string; body: string }): void {
    this.db.prepare("UPDATE escalations SET body = ? WHERE id = ? AND status = 'pending'").run(body, id);
  }

  /** Marks a pending escalation whose listing in the questions_for_human of its manager was refused; a null clears the mark. */
  setHandoverRefusal({ id, refusal }: { id: string; refusal: EscalationHandoverRefusal | null }): void {
    this.db.prepare("UPDATE escalations SET handover_refusal_json = ? WHERE id = ? AND status = 'pending'").run(refusal === null ? null : JSON.stringify(refusal), id);
  }

  /** Closes a pending escalation in one statement; false when it was not pending (answered already, or it does not exist). */
  answerEscalationIfPending({ id, resolvedAt }: { id: string; resolvedAt: string }): boolean {
    const { changes } = this.db.prepare("UPDATE escalations SET status = 'answered', resolved_at = ? WHERE id = ? AND status = 'pending'").run(resolvedAt, id);
    return changes === 1;
  }

  insertArbiterDecision(decision: NewArbiterDecision): void {
    this.db.prepare(`INSERT INTO arbiter_decisions (batch_id, question_id, verdict, decision, rationale, raise_to, evidence_json, arbiter_session_id, plan_note_rev, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(decision.batchId, decision.questionId, decision.verdict, decision.decision, decision.rationale, decision.raiseTo ?? null, jsonOrNull(decision.evidence), decision.arbiterSessionId, decision.planNoteRev, decision.createdAt);
  }

  decisionsOfBatch(batchId: string): NewArbiterDecision[] {
    return (this.db.prepare('SELECT * FROM arbiter_decisions WHERE batch_id = ? ORDER BY id').all(batchId) as unknown as DecisionRow[]).map(toDecision);
  }
}
