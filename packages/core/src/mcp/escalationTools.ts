import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ESCALATING_CLASSES, MAX_QUESTIONS_PER_BATCH, PlanQuestionSchema, QUESTION_CLASSES, REPRO_CLAIM_EXAMPLE, type Session } from '@openfleet/shared';
import { z } from 'zod';
import type { ArbiterRunner } from '../escalation/arbiterRunner.js';
import type { EscalationService } from '../escalation/escalationService.js';
import { escalationPolicyOf } from '../escalation/projectPolicy.js';
import type { ManagerService } from '../managers/managerService.js';
import type { NoteRepository } from '../notes/noteRepository.js';
import type { ProjectRepository } from '../projects/projectRepository.js';
import { ok, refuse } from './toolResults.js';

const MAX_TICKET_CHARS = 40;

const repeatedIdOf = (questions: readonly { id: string }[]): string | undefined =>
  questions.map(({ id }) => id).find((id, position, ids) => ids.indexOf(id) !== position);

const PlanQuestionsSubmissionSchema = z.object({
  ticket: z.string().trim().min(1).max(MAX_TICKET_CHARS),
  plan_note_id: z.string().min(1),
  questions: z.array(PlanQuestionSchema).min(1).max(MAX_QUESTIONS_PER_BATCH).superRefine((questions, context) => {
    const repeatedId = repeatedIdOf(questions);
    if (repeatedId !== undefined) context.addIssue({ code: 'custom', message: `the question id ${repeatedId} appears twice in the batch: every id is unique` });
  }),
});

export const problemOf = ({ path, message }: z.core.$ZodIssue) => (path.length === 0 ? message : `${path.join('.')}: ${message}`);

export interface RegisterEscalationToolsDeps {
  escalations: EscalationService;
  arbiters: Pick<ArbiterRunner, 'launch'>;
  managers: Pick<ManagerService, 'get' | 'isMissionNote'>;
  noteRepo: Pick<NoteRepository, 'get'>;
  projects: Pick<ProjectRepository, 'get'>;
  caller: Session;
}

export function registerEscalationTools(server: McpServer, deps: RegisterEscalationToolsDeps): void {
  const { escalations, arbiters, managers, noteRepo, projects, caller } = deps;

  server.registerTool('submit_plan_questions', {
    description: `Submit the questions of your plan on a ticket in one batch (managers only), instead of asking the human one by one. Each question is { id (20 characters, unique in the batch), text (300), class, options (up to 4), recommendation (300), paths (up to 20 files the answer would touch), resolution }. class is one of ${QUESTION_CLASSES.join(' | ')}; technical and factual questions go to the arbiter, and the escalating classes (${ESCALATING_CLASSES.join(', ')}) go to a human. The daemon also reads your text, options, recommendation and paths: a question that touches a contract, security, deployment, history, a waiver, spend or a visual check goes to a human whatever class you wrote, and a class outside the list goes to a human as unclassified. A factual question is answered by you when resolution proves it, an object ${REPRO_CLAIM_EXAMPLE} with the command you ran and its output; without an executed proof it goes to the arbiter. All the questions that need a human of one ticket make ONE escalation: the daemon writes its text and adds one [esc:<id>] item to your questions_for_human, so do not write that item yourself. Answers { batch_id, self, arbiter: { status, question_ids }, human: { escalation_id, question_ids } | null }. plan_note_id is the note of your plan, never your mission note`,
    inputSchema: { ticket: z.string(), plan_note_id: z.string(), questions: z.array(z.unknown()) },
  }, async (input) => {
    const manager = managers.get(caller.id);
    if (manager === undefined) return refuse('not_a_manager', 'only a manager can submit plan questions');

    const parsedSubmission = PlanQuestionsSubmissionSchema.safeParse(input);
    if (!parsedSubmission.success) return refuse('invalid_body', parsedSubmission.error.issues.map(problemOf).join('; '));
    const { ticket, plan_note_id: planNoteId, questions } = parsedSubmission.data;

    const planNote = noteRepo.get(planNoteId);
    const isPlanNoteOfOwnProject = planNote !== undefined && planNote.projectId === caller.projectId;
    if (!isPlanNoteOfOwnProject) return refuse('note_not_found', 'note not found');
    if (managers.isMissionNote(planNoteId)) return refuse('invalid_body', 'plan_note_id is your mission note: name the note of your plan', 'Write the plan in its own note, then submit again.');

    const policy = escalationPolicyOf(projects, caller.projectId);
    const submitted = escalations.submitBatch({ managerId: caller.id, ticket, planNoteId, planNoteRev: planNote.rev, questions, policy });
    const arbiterLaunch = await arbiters.launch(submitted.batchId);

    const handedToTheHuman = arbiterLaunch.status === 'escalated' ? arbiterLaunch.escalated : undefined;
    const humanQuestionIds = [...(submitted.human?.questionIds ?? []), ...(handedToTheHuman?.questionIds ?? [])];
    const humanEscalationId = handedToTheHuman?.escalationId ?? submitted.human?.escalationId;
    return ok({
      batch_id: submitted.batchId,
      self: submitted.selfResolvedQuestionIds.map((questionId) => ({ question_id: questionId })),
      arbiter: arbiterLaunch.status === 'escalated'
        ? { status: 'escalated', reason: arbiterLaunch.reason, question_ids: handedToTheHuman?.questionIds ?? [] }
        : { status: 'pending', question_ids: submitted.arbiterQuestionIds },
      human: humanEscalationId === undefined ? null : { escalation_id: humanEscalationId, question_ids: humanQuestionIds },
    });
  });
}
