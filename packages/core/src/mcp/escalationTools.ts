import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ESCALATING_CLASSES, isQuestionIdentifier, MAX_QUESTIONS_PER_BATCH, PlanQuestionSchema, QUESTION_CLASSES, REPRO_CLAIM_EXAMPLE, type Session } from '@openfleet/shared';
import { z } from 'zod';
import type { ArbiterRunner } from '../escalation/arbiterRunner.js';
import type { CriteriaApproval } from '../escalation/criteriaApproval.js';
import type { EscalationService } from '../escalation/escalationService.js';
import { escalationPolicyOf } from '../escalation/projectPolicy.js';
import type { ManagerService } from '../managers/managerService.js';
import type { NoteRepository } from '../notes/noteRepository.js';
import type { ProjectRepository } from '../projects/projectRepository.js';
import { ok, refuse } from './toolResults.js';

const MAX_TICKET_CHARS = 40;
/** A ticket is an identifier such as CCM-123 or KB-01a: it is written into the arbiter prompt, the plan note and the journal, so it carries no text. */
const TICKET_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const TicketSchema = z.string().trim().min(1).max(MAX_TICKET_CHARS).regex(TICKET_PATTERN, 'ticket must be an identifier of letters, digits, dots, underscores and hyphens, such as CCM-123');

const repeatedIdOf = (questions: readonly { id: string }[]): string | undefined =>
  questions.map(({ id }) => id).filter(isQuestionIdentifier).find((id, position, ids) => ids.indexOf(id) !== position);

const PlanQuestionsSubmissionSchema = z.object({
  ticket: TicketSchema,
  plan_note_id: z.string().min(1),
  questions: z.array(PlanQuestionSchema).min(1).max(MAX_QUESTIONS_PER_BATCH).superRefine((questions, context) => {
    const repeatedId = repeatedIdOf(questions);
    if (repeatedId !== undefined) context.addIssue({ code: 'custom', message: `the question id ${repeatedId} appears twice in the batch: every id is unique` });
  }),
});

export const problemOf = ({ path, message }: z.core.$ZodIssue) => (path.length === 0 ? message : `${path.join('.')}: ${message}`);

const ApprovalRequestSchema = z.object({ ticket: TicketSchema, plan_note_id: z.string().min(1) });

/** The refusal for a plan note that is missing, foreign to the caller's project or the mission note; undefined when the note can carry a plan. */
function planNoteRefusalOf({ planNote, planNoteId, caller, managers }: {
  planNote: { projectId?: string | undefined } | undefined; planNoteId: string; caller: Session; managers: Pick<ManagerService, 'isMissionNote'>;
}) {
  const isPlanNoteOfOwnProject = planNote !== undefined && planNote.projectId === caller.projectId;
  if (!isPlanNoteOfOwnProject) return refuse('note_not_found', 'note not found');
  if (managers.isMissionNote(planNoteId)) return refuse('invalid_body', 'plan_note_id is your mission note: name the note of your plan', 'Write the plan in its own note, then submit again.');
  return undefined;
}

export interface RegisterEscalationToolsDeps {
  criteria: Pick<CriteriaApproval, 'approve'>;
  escalations: EscalationService;
  arbiters: Pick<ArbiterRunner, 'launch'>;
  managers: Pick<ManagerService, 'get' | 'isMissionNote'>;
  noteRepo: Pick<NoteRepository, 'get'>;
  projects: Pick<ProjectRepository, 'get'>;
  caller: Session;
}

export function registerEscalationTools(server: McpServer, deps: RegisterEscalationToolsDeps): void {
  const { criteria, escalations, arbiters, managers, noteRepo, projects, caller } = deps;

  server.registerTool('submit_plan_questions', {
    description: `Submit the questions of your plan on a ticket in one batch (managers only), instead of asking the human one by one. Each question is { id (20 characters, unique in the batch), text (300), class, options (up to 4), recommendation (300), paths (up to 20 files the answer would touch), resolution }. class is one of ${QUESTION_CLASSES.join(' | ')}; technical and factual questions go to the arbiter, and the escalating classes (${ESCALATING_CLASSES.join(', ')}) go to a human. The daemon also reads your text, options, recommendation and paths: a question that touches a contract, security, deployment, history, a waiver, spend or a visual check goes to a human whatever class you wrote, and a class outside the list goes to a human as unclassified. A factual question is answered by you when resolution proves it, an object ${REPRO_CLAIM_EXAMPLE} with the command you ran and its output; without an executed proof it goes to the arbiter. reopens: <question id> contests the arbiter decision of one of your earlier questions on this ticket (only a question the arbiter decided can be reopened) and needs new executed evidence in resolution, a proven or plausible claim with the command you ran and its output; the arbiter reviews it once. A decision is reopened ONCE: if you still disagree with the answer to the reopen, reopen that answer's question and the daemon sends it to a human as arbiter_dispute, without a new arbiter. There is no third round, and a second reopen of the same decision is refused. All the questions that need a human of one ticket make ONE escalation: the daemon writes its text and adds one [esc:<id>] item to your questions_for_human, so do not write that item yourself. Answers { batch_id, self, arbiter: { status, question_ids }, human: { escalation_id, question_ids } | null, warnings? }; warnings holds list_refusal when the human list was full: the questions are on the card and committed, so do not submit them again. plan_note_id is the note of your plan, never your mission note`,
    inputSchema: { ticket: z.string(), plan_note_id: z.string(), questions: z.array(z.unknown()) },
  }, async (input) => {
    const manager = managers.get(caller.id);
    if (manager === undefined) return refuse('not_a_manager', 'only a manager can submit plan questions');

    const parsedSubmission = PlanQuestionsSubmissionSchema.safeParse(input);
    if (!parsedSubmission.success) return refuse('invalid_body', parsedSubmission.error.issues.map(problemOf).join('; '));
    const { ticket, plan_note_id: planNoteId, questions } = parsedSubmission.data;

    const planNote = noteRepo.get(planNoteId);
    const planNoteRefusal = planNoteRefusalOf({ planNote, planNoteId, caller, managers });
    if (planNoteRefusal !== undefined) return planNoteRefusal;
    if (planNote === undefined) return refuse('note_not_found', 'note not found');

    const policy = escalationPolicyOf(projects, caller.projectId);
    const submitted = escalations.submitBatch({ managerId: caller.id, ticket, planNoteId, planNoteRev: planNote.rev, questions, policy });
    const arbiterLaunch = await arbiters.launch(submitted.batchId);
    const handedToTheHuman = arbiterLaunch.status === 'escalated' ? arbiterLaunch.escalated : undefined;
    const listRefusal = handedToTheHuman?.listRefusal;
    const humanQuestionIds = [...(submitted.human?.questionIds ?? []), ...(handedToTheHuman?.questionIds ?? [])];
    const humanEscalationId = handedToTheHuman?.escalationId ?? submitted.human?.escalationId;
    return ok({
      batch_id: submitted.batchId,
      self: submitted.selfResolvedQuestionIds.map((questionId) => ({ question_id: questionId })),
      arbiter: arbiterLaunch.status === 'escalated'
        ? { status: 'escalated', reason: arbiterLaunch.reason, question_ids: handedToTheHuman?.questionIds ?? [] }
        : { status: 'pending', question_ids: submitted.arbiterQuestionIds },
      human: humanEscalationId === undefined ? null : { escalation_id: humanEscalationId, question_ids: humanQuestionIds },
      ...(listRefusal && { warnings: [`list_refusal: ${listRefusal.refusal}${listRefusal.hint ? ` ${listRefusal.hint}` : ''}`] }),
    });
  });

  server.registerTool('approve_plan_criteria', {
    description: 'Approve the acceptance criteria of a ticket (managers only). It succeeds only when the arbiter gave a favourable opinion on the current revision of your plan note and no question of the ticket waits for a human or the arbiter; a plan note edited after the opinion needs a new one (criteria_stale). The daemon itself sets the criteria_status column of your backlog row and journals "criteria approved" with the author arbiter: you never write that column. { ticket, plan_note_id } answers { approved: true, opinion_id }. plan_note_id is the note of your plan, never your mission note',
    inputSchema: { ticket: z.string(), plan_note_id: z.string() },
  }, async (input) => {
    const manager = managers.get(caller.id);
    if (manager === undefined) return refuse('not_a_manager', 'only a manager can approve plan criteria');

    const parsedRequest = ApprovalRequestSchema.safeParse(input);
    if (!parsedRequest.success) return refuse('invalid_body', parsedRequest.error.issues.map(problemOf).join('; '));
    const { ticket, plan_note_id: planNoteId } = parsedRequest.data;

    const planNote = noteRepo.get(planNoteId);
    const planNoteRefusal = planNoteRefusalOf({ planNote, planNoteId, caller, managers });
    if (planNoteRefusal !== undefined) return planNoteRefusal;
    if (caller.projectId === undefined) return refuse('invalid_body', 'your session belongs to no project');

    const approved = criteria.approve({ managerId: caller.id, projectId: caller.projectId, ticket, planNoteId, policy: escalationPolicyOf(projects, caller.projectId) });
    return ok({ approved: true, opinion_id: approved.opinionId, ...(approved.warnings.length > 0 && { warnings: approved.warnings }) });
  });
}
