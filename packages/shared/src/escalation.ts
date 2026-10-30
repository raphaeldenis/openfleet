import * as z from 'zod';
import { ReproClaimSchema } from './reproClaim.js';

/** The role of the session the daemon spawns to decide the technical questions of a batch. */
export const ARBITER_ROLE = 'arbiter';

/** Classes whose questions the manager decides with the arbiter, never with a human. */
const ARBITRABLE_CLASSES = ['factual', 'technical'] as const;

/** Classes whose questions can reach a human: the closed list the daemon escalates. */
export const ESCALATING_CLASSES = ['contract', 'security', 'deployment', 'history_rewrite', 'dod_waiver', 'spend', 'visual_qa'] as const;
export type EscalatingClass = (typeof ESCALATING_CLASSES)[number];

export const QUESTION_CLASSES = [...ARBITRABLE_CLASSES, ...ESCALATING_CLASSES] as const;
export type QuestionClass = (typeof QUESTION_CLASSES)[number];

/** The two escalating classes no project can take off its human list. */
export const UNREMOVABLE_ESCALATING_CLASSES = ['contract', 'security'] as const satisfies readonly EscalatingClass[];

export const isQuestionClass = (value: string): value is QuestionClass => (QUESTION_CLASSES as readonly string[]).includes(value);
export const isEscalatingClass = (value: string): value is EscalatingClass => (ESCALATING_CLASSES as readonly string[]).includes(value);

export const MAX_QUESTIONS_PER_BATCH = 20;
const MAX_QUESTION_ID_CHARS = 20;
const MAX_QUESTION_TEXT_CHARS = 300;
const MAX_QUESTION_OPTIONS = 4;
const MAX_QUESTION_PATHS = 20;
const MAX_QUESTION_PATH_CHARS = 300;
const MAX_DECISION_CHARS = 600;
const MAX_CRITERIA_REASONS = 5;
const MAX_CRITERIA_REASON_CHARS = 300;

/**
 * `class` stays a free string: a value outside the vocabulary is read as unknown and goes to a human, it is not a malformed request.
 * `reopens` names the question whose arbiter decision the manager contests; the daemon checks it against the stored decisions.
 */
export const PlanQuestionSchema = z.strictObject({
  id: z.string().min(1).max(MAX_QUESTION_ID_CHARS),
  text: z.string().min(1).max(MAX_QUESTION_TEXT_CHARS),
  class: z.string(),
  options: z.array(z.string().min(1).max(MAX_QUESTION_TEXT_CHARS)).max(MAX_QUESTION_OPTIONS).optional(),
  recommendation: z.string().min(1).max(MAX_QUESTION_TEXT_CHARS).optional(),
  paths: z.array(z.string().min(1).max(MAX_QUESTION_PATH_CHARS)).max(MAX_QUESTION_PATHS).optional(),
  resolution: ReproClaimSchema.optional(),
  reopens: z.string().min(1).max(MAX_QUESTION_ID_CHARS).optional(),
});
export type PlanQuestion = z.infer<typeof PlanQuestionSchema>;

const hasDistinctQuestionIds = (decisions: readonly { question_id: string }[]): boolean =>
  new Set(decisions.map(({ question_id }) => question_id)).size === decisions.length;

const ArbiterDecisionSchema = z.object({
  question_id: z.string().min(1).max(MAX_QUESTION_ID_CHARS),
  verdict: z.enum(['decided', 'needs_human']),
  decision: z.string().min(1).max(MAX_DECISION_CHARS),
  rationale: z.string().min(1).max(MAX_DECISION_CHARS),
  raise_to: z.enum(ESCALATING_CLASSES).optional(),
  evidence: ReproClaimSchema.optional(),
});

/** Whether every question of the batch is answered is the daemon's call: the schema does not know the batch. */
export const ArbiterOpinionSchema = z.object({
  batch_id: z.string().min(1),
  decisions: z.array(ArbiterDecisionSchema).min(1).max(MAX_QUESTIONS_PER_BATCH),
  criteria: z.object({
    opinion: z.enum(['favourable', 'unfavourable', 'not_asked']),
    reasons: z.array(z.string().min(1).max(MAX_CRITERIA_REASON_CHARS)).max(MAX_CRITERIA_REASONS),
  }),
})
  .refine(({ decisions }) => hasDistinctQuestionIds(decisions), { message: 'one decision per question: a question_id appears twice', path: ['decisions'] })
  .refine(({ criteria }) => criteria.opinion !== 'unfavourable' || criteria.reasons.length >= 1, { message: 'an unfavourable opinion names at least one reason', path: ['criteria', 'reasons'] });
export type ArbiterOpinion = z.infer<typeof ArbiterOpinionSchema>;

const MAX_EXTRA_RULES = 40;
const MAX_PATH_GLOB_CHARS = 200;
const MAX_KEYWORD_CHARS = 80;
const MAX_COLUMN_NAME_CHARS = 80;
export const ARBITER_MODELS = ['opus', 'fable'] as const;
export const ASK_USER_GATES = ['off', 'warn', 'enforce'] as const;
const MIN_ARBITER_RUNS_PER_TICKET = 1;
const MAX_ARBITER_RUNS_PER_TICKET = 10;

const ExtraRuleSchema = z.strictObject({
  class: z.enum(ESCALATING_CLASSES),
  pathGlob: z.string().min(1).max(MAX_PATH_GLOB_CHARS).optional(),
  keyword: z.string().trim().min(1).max(MAX_KEYWORD_CHARS).optional(),
}).refine(({ pathGlob, keyword }) => pathGlob !== undefined || keyword !== undefined, { message: 'a rule needs a pathGlob or a keyword', path: ['pathGlob'] });
export type ExtraRule = z.infer<typeof ExtraRuleSchema>;

const keepsUnremovableClasses = (humanClasses: readonly EscalatingClass[]): boolean =>
  UNREMOVABLE_ESCALATING_CLASSES.every((unremovableClass) => humanClasses.includes(unremovableClass));

/** The escalation setting of a project; an empty object gives the defaults of the design. */
export const EscalationPolicySchema = z.strictObject({
  humanClasses: z.array(z.enum(ESCALATING_CLASSES)).default([...ESCALATING_CLASSES])
    .refine(keepsUnremovableClasses, { message: `${UNREMOVABLE_ESCALATING_CLASSES.join(' and ')} stay on the human list: no project removes them` }),
  extraRules: z.array(ExtraRuleSchema).max(MAX_EXTRA_RULES).default([]),
  arbiterModel: z.enum(ARBITER_MODELS).default('opus'),
  maxArbiterRunsPerTicket: z.number().int().min(MIN_ARBITER_RUNS_PER_TICKET).max(MAX_ARBITER_RUNS_PER_TICKET).default(3),
  criteriaStatusColumn: z.string().trim().min(1).max(MAX_COLUMN_NAME_CHARS).default('criteria_status'),
  approvedOption: z.string().trim().min(1).max(MAX_COLUMN_NAME_CHARS).default('approved'),
  askUserGate: z.enum(ASK_USER_GATES).default('warn'),
});
export type EscalationPolicy = z.infer<typeof EscalationPolicySchema>;

export const DEFAULT_ESCALATION_POLICY: EscalationPolicy = EscalationPolicySchema.parse({});

export const ESCALATION_STATUSES = ['pending', 'answered'] as const;
export type EscalationStatus = (typeof ESCALATION_STATUSES)[number];

const MAX_HUMAN_ANSWER_CHARS = 2000;

/** One answer per question of the escalation; the daemon refuses an answer set that leaves a question out or names one the escalation does not carry. */
export const EscalationAnswerBodySchema = z.strictObject({
  answers: z.array(z.strictObject({
    question_id: z.string().min(1).max(MAX_QUESTION_ID_CHARS),
    answer: z.string().trim().min(1).max(MAX_HUMAN_ANSWER_CHARS),
  })).min(1).max(MAX_QUESTIONS_PER_BATCH),
});
export type EscalationAnswerBody = z.infer<typeof EscalationAnswerBodySchema>;

export interface EscalationQuestionView {
  questionId: string;
  text: string;
  declaredClass: string;
  effectiveClasses: EscalatingClass[];
  /** Set when the question reached the human for a reason other than its class, for example `unclassified`. */
  reason?: string;
  options?: string[];
  recommendation?: string;
  status: 'pending_human' | 'answered';
  humanAnswer?: string;
  answeredAt?: string;
}

/** Set while the escalation could not be listed in the questions_for_human of its manager: the card exists and can be answered, and a human retries the listing. */
export interface EscalationHandoverRefusal {
  /** Why the questions were handed to the human, for example `arbiter_unavailable`. */
  reason: string;
  /** Why the listing was refused. */
  refusal: string;
  hint?: string;
  at: string;
}

/** What the Inbox shows and what the WebSocket carries: the escalation the daemon wrote, with the questions it carries. */
export interface EscalationView {
  id: string;
  managerId: string;
  ticket: string;
  status: EscalationStatus;
  body: string;
  createdAt: string;
  resolvedAt?: string;
  handoverRefusal?: EscalationHandoverRefusal;
  questions: EscalationQuestionView[];
}
