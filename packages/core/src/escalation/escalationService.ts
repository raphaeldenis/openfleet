import { OpenFleetError, WORKING_STATE_MAX_ITEMS_PER_SECTION, type EscalationPolicy, type PlanQuestion, type WorkingState, type WorkingStateSections } from '@openfleet/shared';
import type { DatabaseSync } from 'node:sqlite';
import { inTransaction } from '../db/transaction.js';
import type { WorkingStateService } from '../workingState/workingStateService.js';
import { UNCLASSIFIED_LABEL, escalationItemOf, humanReadableText, renderEscalationBody } from './escalationBody.js';
import type { EscalationRepository, NewQuestion, StoredEscalation, QuestionStatus } from './escalationRepository.js';
import { routeQuestion, type QuestionRoute, type QuestionRouting } from './questionRouting.js';

export const CLASS_DISABLED_BY_PROJECT_REASON = 'class_disabled_by_project';

export interface EscalationServiceDeps {
  db: DatabaseSync;
  repository: EscalationRepository;
  workingStates: Pick<WorkingStateService, 'get' | 'update'>;
  clock: () => string;
  newId: () => string;
}

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

const sectionsOf = (state: WorkingState | undefined): WorkingStateSections => ({
  plan: state?.plan ?? [], todo: state?.todo ?? [], remaining: state?.remaining ?? [],
  questionsForHuman: state?.questionsForHuman ?? [], internalQuestions: state?.internalQuestions ?? [], blockers: state?.blockers ?? [],
});

const readableOptional =(text: string | undefined) => (text === undefined ? undefined : humanReadableText(text));

/** Routes the questions a manager submits, stores the batch, and keeps the single open escalation of a ticket in step with the questions that need a human. */
export class EscalationService {
  constructor(private readonly deps: EscalationServiceDeps) {}

  submitBatch(batch: PlanQuestionBatch): SubmittedPlanQuestions {
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
  private joinEscalation({ batchId, managerId, ticket, questionIds }: { batchId: string; managerId: string; ticket: string; questionIds: string[] }) {
    const { repository } = this.deps;
    const openEscalation = repository.findPendingEscalation({ managerId, ticket });
    const escalation = openEscalation ?? this.openEscalation({ managerId, ticket });
    for (const questionId of questionIds) repository.attachQuestionToEscalation({ batchId, questionId, escalationId: escalation.id });

    const body = renderEscalationBody({ id: escalation.id, ticket, questions: repository.questionsOfEscalation(escalation.id) });
    repository.updateEscalationBody({ id: escalation.id, body });
    this.ensureItemInQuestionsForHuman({ managerId, escalation });
    return { escalationId: escalation.id, questionIds };
  }

  private openEscalation({ managerId, ticket }: { managerId: string; ticket: string }): StoredEscalation {
    const id = this.deps.newId();
    this.deps.repository.insertEscalation({ id, managerId, ticket, body: '', createdAt: this.deps.clock() });
    return this.deps.repository.findEscalation(id)!;
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

