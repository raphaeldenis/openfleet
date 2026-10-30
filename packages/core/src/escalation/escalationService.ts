import { EVIDENCE_MESSAGE, OpenFleetError, WORKING_STATE_MAX_ITEMS_PER_SECTION, type ArbiterOpinion, type EscalatingClass, type EscalationAnswerBody, type EscalationPolicy, type EscalationQuestionView, type EscalationStatus, type EscalationView, type PlanQuestion, type ReproClaim, type WorkingState, type WorkingStateSections } from '@openfleet/shared';
import type { DatabaseSync } from 'node:sqlite';
import { inTransaction } from '../db/transaction.js';
import type { EventBus } from '../events/eventBus.js';
import { BLANK_CLAIM_MESSAGE, hasBlankClaim, lacksExecutedEvidence, sanitizedReproClaim } from '../review/sanitizedReproClaim.js';
import type { WorkingStateService } from '../workingState/workingStateService.js';
import type { AuditWriter, AuditedDecision } from './auditWriter.js';
import { ESCALATION_ITEM_PREFIX, UNCLASSIFIED_LABEL, escalationItemOf, humanReadableText, renderEscalationBody } from './escalationBody.js';
import type { EscalationRepository, NewQuestion, StoredBatch, StoredEscalation, StoredQuestion, QuestionStatus } from './escalationRepository.js';
import { routeQuestion, type QuestionRoute, type QuestionRouting } from './questionRouting.js';

export const CLASS_DISABLED_BY_PROJECT_REASON = 'class_disabled_by_project';
export const ARBITER_DEFERRED_REASON = 'arbiter_deferred';
export const ARBITER_UNAVAILABLE_REASON = 'arbiter_unavailable';
export const ARBITER_QUOTA_REASON = 'arbiter_quota';

export interface EscalationServiceDeps {
  db: DatabaseSync;
  repository: EscalationRepository;
  workingStates: Pick<WorkingStateService, 'get' | 'update'>;
  audit: AuditWriter;
  clock: () => string;
  newId: () => string;
  /** Receives `escalation.raised` and `escalation.resolved`; without it the service emits nothing. */
  bus?: Pick<EventBus, 'emit'>;
  /** Called after a human answer is committed, to tell the manager. */
  notifyAnswer?: (escalation: EscalationView) => void;
}

export interface RecordedOpinion {
  batchId: string;
  decidedQuestionIds: string[];
  /** The questions the arbiter handed to the human, with the reason the human sees. */
  escalatedQuestionIds: string[];
  /** The questions that were no longer open: the opinion changed nothing for them. */
  ignoredQuestionIds: string[];
  warnings: string[];
}

export interface EscalatedToHuman {
  escalationId: string;
  questionIds: string[];
  /** Set when the questions_for_human of the manager had no room: the questions wait on the card, unlisted, until a human retries the listing. */
  listRefusal?: HumanListRefusal;
}

/** The questions_for_human of the manager had no room for the escalation item, and this says why. */
export interface HumanListRefusal {
  refusal: string;
  hint?: string;
}

/** What a hand-over does when the human list is full: a submission is refused as a whole, a fail-closed hand-over keeps the card and marks it. */
type OnFullList = 'refuse' | { markCardWith: string };

export interface PlanQuestionBatch {
  managerId: string;
  ticket: string;
  planNoteId: string;
  planNoteRev: number;
  questions: readonly PlanQuestion[];
  policy: EscalationPolicy;
}

export interface SubmittedPlanQuestions {
  batchId: string;
  selfResolvedQuestionIds: string[];
  arbiterQuestionIds: string[];
  human?: { escalationId: string; questionIds: string[] };
}

const STATUS_OF_ROUTE: Record<QuestionRoute, QuestionStatus> = { human: 'pending_human', self: 'self_resolved', arbiter: 'open' };

const reasonOf = (routing: QuestionRouting): string | undefined => {
  if (routing.declared === 'unknown') return UNCLASSIFIED_LABEL;
  const isArbiterQuestionOfDisabledClass = routing.route === 'arbiter' && routing.disabledByProject.length > 0;
  return isArbiterQuestionOfDisabledClass ? CLASS_DISABLED_BY_PROJECT_REASON : undefined;
};

const withClass = (classes: readonly EscalatingClass[], addedClass: EscalatingClass): EscalatingClass[] =>
  classes.includes(addedClass) ? [...classes] : [...classes, addedClass];

const oneLine = (text: string) => text.replace(/\s+/g, ' ').trim();

const journalEntryOf = ({ ticket, decision }: { ticket: string; decision: AuditedDecision }): string => {
  const handedToAHuman = decision.verdict === 'needs_human' || decision.raiseTo !== undefined;
  const outcome = handedToAHuman ? `handed to the human${decision.raiseTo ? ` as ${decision.raiseTo}` : ''}` : 'decided';
  return oneLine(`${ticket} ${decision.questionId} ${outcome}: ${decision.decision} — ${decision.rationale}`);
};

const opinionMessageOf = ({ ticket, result, criteria }: { ticket: string; result: RecordedOpinion; criteria: string }): string => {
  const decided = result.decidedQuestionIds.length > 0 ? `decided ${result.decidedQuestionIds.join(',')}` : 'decided none';
  const escalated = result.escalatedQuestionIds.length > 0 ? `; handed to the human: ${result.escalatedQuestionIds.join(',')}` : '';
  return `[arbiter] ${decided} on ${ticket}${escalated}; criteria ${criteria}`;
};

const sectionsOf = (state: WorkingState | undefined): WorkingStateSections => ({
  plan: state?.plan ?? [], todo: state?.todo ?? [], remaining: state?.remaining ?? [],
  questionsForHuman: state?.questionsForHuman ?? [], internalQuestions: state?.internalQuestions ?? [], blockers: state?.blockers ?? [],
});

const questionViewOf = (question: StoredQuestion): EscalationQuestionView => {
  const { questionId, text, declaredClass, effectiveClasses, reason, options, recommendation, humanAnswer, answeredAt } = question;
  return {
    questionId, text, declaredClass, effectiveClasses, status: question.status === 'answered' ? 'answered' : 'pending_human',
    ...(reason && { reason }), ...(options && { options }), ...(recommendation && { recommendation }), ...(humanAnswer && { humanAnswer }), ...(answeredAt && { answeredAt }),
  };
};

const readableOptional =(text: string | undefined) => (text === undefined ? undefined : humanReadableText(text));

/** Routes the questions a manager submits, stores the batch, and keeps the single open escalation of a ticket in step with the questions that need a human. */
export class EscalationService {
  constructor(private readonly deps: EscalationServiceDeps) {}

  submitBatch(batch: PlanQuestionBatch): SubmittedPlanQuestions {
    const submitted = this.storeBatch(batch);
    this.journalSelfResolved({ managerId: batch.managerId, ticket: batch.ticket, submitted });
    if (submitted.human) this.emitRaised(submitted.human.escalationId);
    return submitted;
  }

  /** Sends the escalation as it stands after a change, so the UI shows it without waiting for a snapshot. */
  private emitRaised(escalationId: string): void {
    this.deps.bus?.emit({ type: 'escalation.raised', escalation: this.viewOf(escalationId) });
  }

  /**
   * Records the opinion of the arbiter: a decision per question waiting for it, written once, with the plan note section, the journal line and the message to the manager.
   * An opinion that does not cover exactly the questions of the arbiter, or that is favourable while a question waits for a human, is refused and writes nothing.
   */
  recordArbiterOpinion({ managerId, arbiterSessionId, opinion }: { managerId: string; arbiterSessionId: string; opinion: ArbiterOpinion }): RecordedOpinion {
    const batch = this.deps.repository.findBatch(opinion.batch_id);
    const isBatchOfThisManager = batch !== undefined && batch.managerId === managerId;
    if (!isBatchOfThisManager) throw new OpenFleetError('escalation_not_found', 'no batch of plan questions with this id waits on your manager');

    const questions = this.deps.repository.questionsOfBatch(batch.id);
    this.assertOpinionDecidesTheArbiterQuestions({ opinion, questions });
    this.assertFavourableOpinionLeavesNothingToAHuman({ opinion, questions });
    const evidenceByQuestionId = this.cleanEvidenceOf(opinion);

    const recorded = inTransaction(this.deps.db, 'escalation_record_arbiter_opinion', () =>
      this.applyOpinion({ batch, questions, opinion, arbiterSessionId, evidenceByQuestionId }));
    if (recorded.escalationId !== undefined) this.emitRaised(recorded.escalationId);
    const hasChangedSomething = recorded.appliedDecisions.length > 0;
    if (!hasChangedSomething) return recorded.result;

    const journalWarnings = this.deps.audit.journal({ managerId, entries: recorded.appliedDecisions.map((decision) => journalEntryOf({ ticket: batch.ticket, decision })) });
    this.deps.audit.tellManager({ managerId, fromSessionId: arbiterSessionId, body: opinionMessageOf({ ticket: batch.ticket, result: recorded.result, criteria: opinion.criteria.opinion }) });
    return { ...recorded.result, warnings: [...recorded.result.warnings, ...journalWarnings] };
  }

  /**
   * Hands the questions of a batch that still wait for the arbiter to the human, in the single open escalation, with the reason the human reads. Answers undefined when none was waiting.
   * When the human list has no room, the questions still reach the card, which carries the refusal until a human retries the listing; the manager is told why.
   */
  escalateBatchToHuman({ batchId, reason }: { batchId: string; reason: string }): EscalatedToHuman | undefined {
    const batch = this.deps.repository.findBatch(batchId);
    if (batch === undefined) return undefined;

    const escalated = this.handWaitingQuestionsToHuman({ batch, reason });
    if (escalated === undefined) return undefined;

    this.emitRaised(escalated.escalationId);
    const { managerId, ticket } = batch;
    const handedIds = escalated.questionIds.join(',');
    const { listRefusal } = escalated;
    if (listRefusal === undefined) {
      this.deps.audit.journal({ managerId, entries: [`${ticket} ${handedIds} escalated to the human: ${reason}`] });
      this.deps.audit.tellManager({ managerId, body: `[arbiter] escalated ${handedIds} on ${ticket} to the human: ${reason}` });
      return escalated;
    }
    const line = `${ticket} ${handedIds} escalated to the human (${reason}) but not listed in questions_for_human: ${listRefusal.refusal}`;
    this.deps.audit.journal({ managerId, entries: [line] });
    this.deps.audit.tellManager({ managerId, body: `[arbiter] ${line}. The card waits in the Inbox; a human can answer it or retry the listing.` });
    return escalated;
  }

  /** A human retries the listing of an escalation card in the questions_for_human of its manager; it fails visibly, the card unchanged, while the list is still full. */
  retryHandover(escalationId: string): EscalationView {
    const { repository } = this.deps;
    const listedEscalation = inTransaction(this.deps.db, 'escalation_retry_handover', () => {
      const escalation = repository.findEscalation(escalationId);
      if (!escalation) throw new OpenFleetError('escalation_not_found', 'the escalation does not exist.');
      if (escalation.status === 'answered') throw new OpenFleetError('already_resolved', 'the escalation is already answered.');
      if (escalation.handoverRefusal === undefined) throw new OpenFleetError('invalid_body', 'the hand-over of this escalation was not refused: there is nothing to retry.');

      this.ensureItemInQuestionsForHuman({ managerId: escalation.managerId, escalation });
      repository.setHandoverRefusal({ id: escalationId, refusal: null });
      return escalation;
    });
    this.emitRaised(escalationId);
    this.deps.audit.journal({ managerId: listedEscalation.managerId, entries: [`${listedEscalation.ticket} escalation listed in questions_for_human after a human retried the hand-over`] });
    return this.viewOf(escalationId);
  }

  private handWaitingQuestionsToHuman({ batch, reason }: { batch: StoredBatch; reason: string }): EscalatedToHuman | undefined {
    const batchId = batch.id;
    return inTransaction(this.deps.db, 'escalation_escalate_batch', () => {
      const waiting = this.deps.repository.questionsOfBatch(batchId).filter((question) => question.route === 'arbiter' && question.status === 'open');
      const handed = waiting.filter((question) => this.deps.repository.deferOpenQuestionToHuman({ batchId, questionId: question.questionId, effectiveClasses: question.effectiveClasses, reason }));
      const hasNothingToHand = handed.length === 0;
      if (hasNothingToHand) return undefined;
      return this.joinEscalation({ batchId, managerId: batch.managerId, ticket: batch.ticket, questionIds: handed.map((question) => question.questionId), onFullList: { markCardWith: reason } });
    });
  }

  private assertOpinionDecidesTheArbiterQuestions({ opinion, questions }: { opinion: ArbiterOpinion; questions: readonly StoredQuestion[] }): void {
    const arbiterQuestionIds = questions.filter((question) => question.route === 'arbiter').map((question) => question.questionId);
    const reportedIds = opinion.decisions.map((decision) => decision.question_id);
    const missingIds = arbiterQuestionIds.filter((id) => !reportedIds.includes(id));
    const foreignIds = reportedIds.filter((id) => !arbiterQuestionIds.includes(id));
    const decidesExactlyTheArbiterQuestions = missingIds.length === 0 && foreignIds.length === 0;
    if (decidesExactlyTheArbiterQuestions) return;

    const problems = [missingIds.length > 0 && `no decision for ${missingIds.join(', ')}`, foreignIds.length > 0 && `${foreignIds.join(', ')} not waiting for the arbiter`].filter(Boolean);
    throw new OpenFleetError('invalid_body', `the opinion must decide exactly the questions waiting for the arbiter (${arbiterQuestionIds.join(', ')}): ${problems.join('; ')}`, { hint: 'Report one decision per question of your batch, then report again.' });
  }

  private assertFavourableOpinionLeavesNothingToAHuman({ opinion, questions }: { opinion: ArbiterOpinion; questions: readonly StoredQuestion[] }): void {
    const isFavourable = opinion.criteria.opinion === 'favourable';
    if (!isFavourable) return;

    const waitingForAHuman = questions.filter((question) => question.status === 'pending_human').map((question) => question.questionId);
    const handedToAHuman = opinion.decisions.filter((decision) => decision.verdict === 'needs_human' || decision.raise_to !== undefined).map((decision) => decision.question_id);
    const holdsBack = [...waitingForAHuman, ...handedToAHuman];
    if (holdsBack.length === 0) return;
    throw new OpenFleetError('invalid_body', `a favourable opinion on the criteria needs every question of the batch decided: ${holdsBack.join(', ')} wait for a human`, { hint: 'Give an unfavourable or not_asked opinion while a question stays with a human.' });
  }

  private cleanEvidenceOf(opinion: ArbiterOpinion): Map<string, ReproClaim> {
    const cleanByQuestionId = new Map<string, ReproClaim>();
    for (const { question_id: questionId, evidence } of opinion.decisions) {
      if (evidence === undefined) continue;
      const cleanEvidence = sanitizedReproClaim(evidence);
      if (hasBlankClaim(cleanEvidence)) throw new OpenFleetError('invalid_body', `${questionId}: ${BLANK_CLAIM_MESSAGE}`);
      if (lacksExecutedEvidence(cleanEvidence)) throw new OpenFleetError('invalid_body', `${questionId}: ${EVIDENCE_MESSAGE}`);
      cleanByQuestionId.set(questionId, cleanEvidence);
    }
    return cleanByQuestionId;
  }

  private applyOpinion({ batch, questions, opinion, arbiterSessionId, evidenceByQuestionId }: {
    batch: StoredBatch; questions: readonly StoredQuestion[]; opinion: ArbiterOpinion; arbiterSessionId: string; evidenceByQuestionId: ReadonlyMap<string, ReproClaim>;
  }): { result: RecordedOpinion; appliedDecisions: AuditedDecision[]; escalationId?: string } {
    const { repository, audit } = this.deps;
    const appliedDecisions: AuditedDecision[] = [];
    const ignoredQuestionIds: string[] = [];
    const escalatedQuestionIds: string[] = [];
    const decidedQuestionIds: string[] = [];

    for (const decision of opinion.decisions) {
      const question = questions.find((candidate) => candidate.questionId === decision.question_id)!;
      const handsToAHuman = decision.verdict === 'needs_human' || decision.raise_to !== undefined;
      const effectiveClasses = decision.raise_to === undefined ? question.effectiveClasses : withClass(question.effectiveClasses, decision.raise_to);
      const key = { batchId: batch.id, questionId: question.questionId };
      const isApplied = handsToAHuman
        ? repository.deferOpenQuestionToHuman({ ...key, effectiveClasses, reason: ARBITER_DEFERRED_REASON })
        : repository.transitionQuestion({ ...key, from: 'open', to: 'decided' });
      if (!isApplied) { ignoredQuestionIds.push(question.questionId); continue; }

      (handsToAHuman ? escalatedQuestionIds : decidedQuestionIds).push(question.questionId);
      const evidence = evidenceByQuestionId.get(question.questionId);
      appliedDecisions.push({
        questionId: question.questionId, questionText: question.text, verdict: decision.verdict,
        decision: humanReadableText(decision.decision), rationale: humanReadableText(decision.rationale),
        ...(decision.raise_to && { raiseTo: decision.raise_to }), ...(evidence && { evidence }),
      });
    }

    const nothingApplied = appliedDecisions.length === 0;
    if (nothingApplied) return { result: { batchId: batch.id, decidedQuestionIds, escalatedQuestionIds, ignoredQuestionIds, warnings: [] }, appliedDecisions };

    const trail = audit.appendDecisionSections({ batch, arbiterSessionId, decisions: appliedDecisions });
    const createdAt = this.deps.clock();
    for (const decision of appliedDecisions) {
      repository.insertArbiterDecision({
        batchId: batch.id, questionId: decision.questionId, verdict: decision.verdict, decision: decision.decision, rationale: decision.rationale,
        ...(decision.raiseTo && { raiseTo: decision.raiseTo }), ...(decision.evidence && { evidence: decision.evidence }),
        arbiterSessionId, planNoteRev: trail.planNoteRev, createdAt,
      });
    }
    repository.recordCriteriaOpinion({ batchId: batch.id, opinion: opinion.criteria.opinion, reasons: opinion.criteria.reasons.map(humanReadableText) });
    const joined = escalatedQuestionIds.length === 0 ? undefined : this.joinEscalation({ batchId: batch.id, managerId: batch.managerId, ticket: batch.ticket, questionIds: escalatedQuestionIds });
    return { result: { batchId: batch.id, decidedQuestionIds, escalatedQuestionIds, ignoredQuestionIds, warnings: trail.warnings }, appliedDecisions, ...(joined && { escalationId: joined.escalationId }) };
  }

  private journalSelfResolved({ managerId, ticket, submitted }: { managerId: string; ticket: string; submitted: SubmittedPlanQuestions }): void {
    if (submitted.selfResolvedQuestionIds.length === 0) return;
    const selfResolved = this.deps.repository.questionsOfBatch(submitted.batchId).filter((question) => question.route === 'self');
    const entries = selfResolved.map(({ questionId, resolution }) => `${ticket} ${questionId} self-resolved: ${resolution!.claim} (${resolution!.status}${resolution!.command ? `, ${resolution!.command}` : ''})`);
    this.deps.audit.journal({ managerId, entries });
  }

  /** The escalations of every manager in the given status, oldest first. */
  listByStatus(status: EscalationStatus): EscalationView[] {
    return this.deps.repository.escalationsWithStatus(status).map((escalation) => this.viewOfStored(escalation));
  }

  listOfManager(managerId: string): EscalationView[] {
    return this.deps.repository.escalationsOfManager(managerId).map((escalation) => this.viewOfStored(escalation));
  }

  /** A human answers every pending question of the escalation at once; the answer closes it. */
  answer({ escalationId, answers }: { escalationId: string; answers: EscalationAnswerBody['answers'] }): EscalationView {
    const { repository } = this.deps;
    inTransaction(this.deps.db, 'escalation_answer', () => {
      const escalation = repository.findEscalation(escalationId);
      if (!escalation) throw new OpenFleetError('escalation_not_found', 'the escalation does not exist.');
      if (escalation.status === 'answered') throw new OpenFleetError('already_resolved', 'the escalation is already answered.');

      const pendingQuestions = repository.questionsOfEscalation(escalationId).filter(({ status }) => status === 'pending_human');
      this.requireOneAnswerPerQuestion({ pendingQuestions, answers });
      const answeredAt = this.deps.clock();
      for (const { question_id: questionId, answer } of answers) {
        for (const question of pendingQuestions.filter((pending) => pending.questionId === questionId)) {
          repository.transitionQuestion({ batchId: question.batchId, questionId, from: 'pending_human', to: 'answered', humanAnswer: humanReadableText(answer), answeredAt });
        }
      }
      repository.answerEscalationIfPending({ id: escalationId, resolvedAt: answeredAt });
    });
    const resolved = this.viewOf(escalationId);
    this.removeItemFromQuestionsForHuman({ managerId: resolved.managerId, escalationId });
    this.deps.bus?.emit({ type: 'escalation.resolved', escalation: resolved });
    this.deps.notifyAnswer?.(resolved);
    return resolved;
  }

  private requireOneAnswerPerQuestion({ pendingQuestions, answers }: { pendingQuestions: readonly StoredQuestion[]; answers: EscalationAnswerBody['answers'] }): void {
    const expectedIds = new Set(pendingQuestions.map(({ questionId }) => questionId));
    const answeredIds = answers.map(({ question_id }) => question_id);
    const unknownIds = answeredIds.filter((id) => !expectedIds.has(id));
    const repeatedIds = answeredIds.filter((id, index) => answeredIds.indexOf(id) !== index);
    const missingIds = [...expectedIds].filter((id) => !answeredIds.includes(id));
    const problems = [
      unknownIds.length > 0 && `the escalation does not carry ${unknownIds.join(', ')}`,
      repeatedIds.length > 0 && `${repeatedIds.join(', ')} is answered twice`,
      missingIds.length > 0 && `no answer for ${missingIds.join(', ')}`,
    ].filter(Boolean);
    if (problems.length === 0) return;
    throw new OpenFleetError('invalid_body', `the answers do not match the questions: ${problems.join('; ')}`, { hint: 'Send one answer for each question of the escalation.' });
  }

  private viewOf(escalationId: string): EscalationView {
    return this.viewOfStored(this.deps.repository.findEscalation(escalationId)!);
  }

  private viewOfStored(escalation: StoredEscalation): EscalationView {
    const questions = this.deps.repository.questionsOfEscalation(escalation.id).map(questionViewOf);
    const { managerId, ticket, status, body, createdAt, resolvedAt, handoverRefusal } = escalation;
    return { id: escalation.id, managerId, ticket, status, body, createdAt, ...(resolvedAt && { resolvedAt }), ...(handoverRefusal && { handoverRefusal }), questions };
  }

  private storeBatch(batch: PlanQuestionBatch): SubmittedPlanQuestions {
    return inTransaction(this.deps.db, 'escalation_submit_batch', () => {
      const batchId = this.deps.newId();
      const { repository } = this.deps;
      repository.insertBatch({ id: batchId, managerId: batch.managerId, ticket: batch.ticket, planNoteId: batch.planNoteId, planNoteRev: batch.planNoteRev, createdAt: this.deps.clock() });

      const routed = batch.questions.map((question) => ({ question, routing: routeQuestion(question, batch.policy) }));
      for (const { question, routing } of routed) repository.insertQuestion(this.newQuestionOf({ batchId, question, routing }));

      const idsOfRoute = (route: QuestionRoute) => routed.filter(({ routing }) => routing.route === route).map(({ question }) => question.id);
      const humanQuestionIds = idsOfRoute('human');
      const human = humanQuestionIds.length === 0 ? undefined : this.joinEscalation({ batchId, managerId: batch.managerId, ticket: batch.ticket, questionIds: humanQuestionIds });
      return { batchId, selfResolvedQuestionIds: idsOfRoute('self'), arbiterQuestionIds: idsOfRoute('arbiter'), ...(human && { human }) };
    });
  }

  private newQuestionOf({ batchId, question, routing }: { batchId: string; question: PlanQuestion; routing: QuestionRouting }): NewQuestion {
    const reason = reasonOf(routing);
    const options = question.options?.map(humanReadableText);
    const recommendation = readableOptional(question.recommendation);
    const paths = question.paths?.map(humanReadableText);
    return {
      batchId, questionId: question.id, text: humanReadableText(question.text), declaredClass: question.class,
      computedClasses: routing.computed, effectiveClasses: routing.effective, route: routing.route, status: STATUS_OF_ROUTE[routing.route],
      ...(reason !== undefined && { reason }), ...(options && { options }), ...(recommendation && { recommendation }), ...(paths && { paths }),
      ...(question.resolution && { resolution: question.resolution }),
    };
  }

  /** Attaches the questions to the open escalation of the ticket, or opens it; the body is rebuilt from every question it carries. */
  private joinEscalation({ batchId, managerId, ticket, questionIds, onFullList = 'refuse' }: {
    batchId: string; managerId: string; ticket: string; questionIds: string[]; onFullList?: OnFullList;
  }): EscalatedToHuman {
    const { repository } = this.deps;
    const openEscalation = repository.findPendingEscalation({ managerId, ticket });
    const escalation = openEscalation ?? this.openEscalation({ managerId, ticket });
    for (const questionId of questionIds) repository.attachQuestionToEscalation({ batchId, questionId, escalationId: escalation.id });

    const body = renderEscalationBody({ id: escalation.id, ticket, questions: repository.questionsOfEscalation(escalation.id) });
    repository.updateEscalationBody({ id: escalation.id, body });
    const listRefusal = this.listItemOrRefusal({ managerId, escalation, onFullList });
    const hasBeenListed = listRefusal === undefined;
    if (hasBeenListed && escalation.handoverRefusal !== undefined) repository.setHandoverRefusal({ id: escalation.id, refusal: null });
    return { escalationId: escalation.id, questionIds, ...(listRefusal && { listRefusal }) };
  }

  /** Lists the escalation; a full list refuses the whole submission, or marks the card with the reason and the refusal when the hand-over must not fail. */
  private listItemOrRefusal({ managerId, escalation, onFullList }: { managerId: string; escalation: StoredEscalation; onFullList: OnFullList }): HumanListRefusal | undefined {
    try {
      this.ensureItemInQuestionsForHuman({ managerId, escalation });
      return undefined;
    } catch (error) {
      const isHumanListFull = error instanceof OpenFleetError && error.code === 'invalid_body';
      if (!isHumanListFull || onFullList === 'refuse') throw error;
      const hint = error.options.hint;
      const listRefusal: HumanListRefusal = { refusal: error.message, ...(hint && { hint }) };
      this.deps.repository.setHandoverRefusal({ id: escalation.id, refusal: { reason: onFullList.markCardWith, ...listRefusal, at: this.deps.clock() } });
      return listRefusal;
    }
  }

  private openEscalation({ managerId, ticket }: { managerId: string; ticket: string }): StoredEscalation {
    const id = this.deps.newId();
    this.deps.repository.insertEscalation({ id, managerId, ticket, body: '', createdAt: this.deps.clock() });
    return this.deps.repository.findEscalation(id)!;
  }

  /** Removes only the items of this escalation; the read and the write run in the same tick, so no edit of the manager falls between them. */
  private removeItemFromQuestionsForHuman({ managerId, escalationId }: { managerId: string; escalationId: string }): void {
    const { workingStates } = this.deps;
    const state = workingStates.get(managerId);
    if (!state) return;

    const itemPrefix = `${ESCALATION_ITEM_PREFIX}${escalationId}]`;
    const questionsForHuman = state.questionsForHuman.filter((item) => !item.startsWith(itemPrefix));
    const isItemAbsent = questionsForHuman.length === state.questionsForHuman.length;
    if (isItemAbsent) return;
    workingStates.update(managerId, { ...sectionsOf(state), questionsForHuman });
  }

  /** The item is written once and never edited: its text does not change when the escalation grows, so the human is notified once. */
  private ensureItemInQuestionsForHuman({ managerId, escalation }: { managerId: string; escalation: StoredEscalation }): void {
    const { workingStates } = this.deps;
    const item = escalationItemOf({ id: escalation.id, ticket: escalation.ticket });
    const sections = sectionsOf(workingStates.get(managerId));
    if (sections.questionsForHuman.includes(item)) return;

    const isFull = sections.questionsForHuman.length >= WORKING_STATE_MAX_ITEMS_PER_SECTION;
    if (isFull) throw new OpenFleetError('invalid_body', `questions_for_human already holds ${WORKING_STATE_MAX_ITEMS_PER_SECTION} items, so the escalation cannot be listed there`, { hint: 'Remove the answered questions with update_working_state, then submit again.' });
    workingStates.update(managerId, { ...sections, questionsForHuman: [...sections.questionsForHuman, item] });
  }
}

