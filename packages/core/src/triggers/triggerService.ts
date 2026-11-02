import {
  EVENT_PREFIXES_BY_SOURCE, DEFAULT_TRIGGER_RUN, DEFAULT_TRIGGER_WHEN, MAX_TRIGGER_CONDITIONS, OpenFleetError, TriggerConditionInputSchema, TriggerPolicySchema,
  type TriggerCondition, type TriggerPolicy, type TriggerRun, type TriggerWhen,
} from '@openfleet/shared';
import { canonicalDigestOf } from '../playbooks/kernel/canonicalDigest.js';
import { evaluateConditions, type Condition } from '../playbooks/kernel/conditionEvaluator.js';
import { KernelError } from '../playbooks/kernel/kernelError.js';
import type { HumanProofVerifier } from './humanProofVerifier.js';
import type { TriggerContent, TriggerRecord, TriggerRepository } from './triggerRepository.js';

const DEFAULT_TITLE = 'Untitled Trigger';
const MAX_TITLE_CHARS = 200;

export interface TriggerServiceDeps {
  repository: TriggerRepository;
  humanProof: HumanProofVerifier;
  projectExists: (projectId: string) => boolean;
  clock: () => string;
  newId: () => string;
}

/** The content a caller edits, from the trigger as it stands: returns what to replace. */
type ContentEdit = (current: TriggerRecord) => TriggerContent;

const notFound = () => new OpenFleetError('trigger_not_found', 'trigger not found');
const staleRevision = (currentRev: number) => new OpenFleetError('stale_revision', `the trigger revision is stale, current rev: ${currentRev}.`, { hint: 'Reload the trigger, then write again.' });

const kernelConditionOf = (condition: TriggerCondition): Condition => ({
  path: condition.lhs, operator: condition.op, value: condition.rhs, caseInsensitive: condition.caseInsensitive, join: condition.join,
});

/** The conditions the evaluator of the kernel accepts: its own checks (operator, cap) run against an empty event. */
function assertEvaluableByTheKernel(conditions: TriggerCondition[]): void {
  try {
    evaluateConditions(conditions.map(kernelConditionOf), {});
  } catch (error) {
    if (error instanceof KernelError) throw new OpenFleetError('invalid_body', error.message);
    throw error;
  }
}

function assertWithinTheCap(conditions: readonly unknown[]): void {
  const isOverTheCap = conditions.length > MAX_TRIGGER_CONDITIONS;
  if (isOverTheCap) throw new OpenFleetError('too_many_conditions', `a trigger holds at most ${MAX_TRIGGER_CONDITIONS} conditions.`);
}

function assertEveryPathReadsTheEventOfTheSource(when: TriggerWhen, conditions: TriggerCondition[]): void {
  const allowedPrefixes = EVENT_PREFIXES_BY_SOURCE[when.source];
  const readsAnotherEvent = (condition: TriggerCondition) => !allowedPrefixes.some((prefix) => condition.lhs.startsWith(prefix));
  const offender = conditions.find(readsAnotherEvent);
  if (offender === undefined) return;
  const rightPrefixes = allowedPrefixes.map((prefix) => `${prefix}*`).join(' or ');
  throw new OpenFleetError('trigger_field_prefix', `the path "${offender.lhs}" is not a field of a ${when.source} event: read it with ${rightPrefixes}.`);
}

function assertDocumentIsSound(document: Pick<TriggerRecord, 'when' | 'conditions'>): void {
  assertWithinTheCap(document.conditions);
  assertEvaluableByTheKernel(document.conditions);
  assertEveryPathReadsTheEventOfTheSource(document.when, document.conditions);
}

/** The join of the first condition has nothing to join to: it is always "and". */
export const withFirstJoinForced = (conditions: TriggerCondition[]): TriggerCondition[] =>
  conditions.map((condition, position) => (position === 0 ? { ...condition, join: 'and' as const } : condition));

function titleOf(requested: string | undefined): string {
  const title = requested?.trim() || DEFAULT_TITLE;
  if (title.length > MAX_TITLE_CHARS) throw new OpenFleetError('invalid_body', `a title holds at most ${MAX_TITLE_CHARS} characters.`);
  return title;
}

/** The part of a trigger that a human approves when arming it. */
export const approvedGraphOf = (trigger: Pick<TriggerRecord, 'when' | 'conditions' | 'run' | 'policy'>) =>
  ({ when: trigger.when, conditions: trigger.conditions, run: trigger.run, policy: trigger.policy });

export class TriggerService {
  constructor(private readonly deps: TriggerServiceDeps) {}

  create(input: { projectId: string; title?: string; when?: TriggerWhen; conditions?: Record<string, unknown>[]; run?: TriggerRun; policy?: Partial<TriggerPolicy> }): TriggerRecord {
    const { repository, projectExists, clock, newId } = this.deps;
    if (!projectExists(input.projectId)) throw new OpenFleetError('project_not_found', 'project not found');
    const when = input.when ?? DEFAULT_TRIGGER_WHEN;
    const conditions = this.conditionsWithIds(input.conditions ?? []);
    assertDocumentIsSound({ when, conditions });
    const id = newId();
    repository.insert({ id, projectId: input.projectId, title: titleOf(input.title), when, conditions, run: input.run ?? DEFAULT_TRIGGER_RUN, policy: TriggerPolicySchema.parse(input.policy ?? {}), createdAt: clock() });
    return this.getById(id);
  }

  getById(id: string): TriggerRecord {
    const trigger = this.deps.repository.get(id);
    if (trigger === undefined) throw notFound();
    return trigger;
  }

  /** The trigger of the project named by its id or its exact title; a trigger of another project is not found. */
  getInProject(projectId: string, reference: string): TriggerRecord {
    const ofProject = this.deps.repository.listOfProject(projectId);
    const byId = ofProject.find((trigger) => trigger.id === reference);
    if (byId !== undefined) return byId;
    const byTitle = ofProject.filter((trigger) => trigger.title === reference);
    if (byTitle.length > 1) throw new OpenFleetError('invalid_body', `ambiguous trigger title: ${byTitle.length} triggers carry it. Use an id.`);
    if (byTitle[0] === undefined) throw notFound();
    return byTitle[0];
  }

  list(projectId: string): TriggerRecord[] {
    return this.deps.repository.listOfProject(projectId);
  }

  delete(id: string): void {
    const wasDeleted = this.deps.repository.delete(id);
    if (!wasDeleted) throw notFound();
  }

  /** Replaces the content, checks it, bumps the revision and clears the arming. A write on a revision other than `expectedRev` is refused. */
  edit(id: string, edit: ContentEdit, options: { expectedRev?: number } = {}): TriggerRecord {
    const { repository, clock } = this.deps;
    const current = this.getById(id);
    const isOnAnOldRevision = options.expectedRev !== undefined && options.expectedRev !== current.contentRev;
    if (isOnAnOldRevision) throw staleRevision(current.contentRev);

    const edited = edit(current);
    const content = edited.conditions === undefined ? edited : { ...edited, conditions: withFirstJoinForced(edited.conditions) };
    assertDocumentIsSound({ when: content.when ?? current.when, conditions: content.conditions ?? current.conditions });
    if (content.title !== undefined) content.title = titleOf(content.title);
    const wasReplaced = repository.replaceContent({ id, expectedRev: current.contentRev, content, now: clock() });
    if (!wasReplaced) throw staleRevision(this.getById(id).contentRev);
    return this.getById(id);
  }

  /** The conditions as callers write them (an id is optional and kept when given), parsed and numbered. */
  conditionsWithIds(inputs: Record<string, unknown>[]): TriggerCondition[] {
    assertWithinTheCap(inputs);
    return withFirstJoinForced(inputs.map(({ id, ...input }) => ({ id: typeof id === 'string' ? id : this.deps.newId(), ...TriggerConditionInputSchema.parse(input) })));
  }

  /** Arms the trigger at the revision a human reviewed, on the proof of that human; records the digest of what was approved. */
  arm(input: { id: string; approvedRev: number; proof: string | undefined }): TriggerRecord {
    const { repository, humanProof, clock } = this.deps;
    const trigger = this.getById(input.id);
    const isOnAnOldRevision = input.approvedRev !== trigger.contentRev;
    if (isOnAnOldRevision) throw staleRevision(trigger.contentRev);

    const isProvenHuman = humanProof.consume(input.proof, { action: 'arm_trigger', triggerId: trigger.id });
    if (!isProvenHuman) throw new OpenFleetError('human_proof_required', 'arming a trigger needs the proof of a human gesture in the desktop app.', { hint: 'Arm it from the Triggers screen.' });

    const approvedGraphDigest = canonicalDigestOf(approvedGraphOf(trigger));
    const wasArmed = repository.arm({ id: trigger.id, approvedRev: input.approvedRev, approvedGraphDigest, now: clock() });
    if (!wasArmed) throw staleRevision(this.getById(trigger.id).contentRev);
    return this.getById(trigger.id);
  }

  disarm(id: string): TriggerRecord {
    this.getById(id);
    this.deps.repository.disarm(id);
    return this.getById(id);
  }
}
