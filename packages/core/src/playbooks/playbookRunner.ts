import { dirname } from 'node:path';
import {
  DEFAULT_STEP_TIMEOUT_SECONDS, MAX_STEP_OUTPUT_BYTES, OpenFleetError,
  type PlaybookCell, type PlaybookEdge, type PlaybookInputDeclaration, type PlaybookRunActorKind, type PlaybookRunStatus,
} from '@openfleet/shared';
import { log } from '../logger.js';
import { maskedSecrets } from '../redact.js';
import type { SecretService } from '../secrets/secretService.js';
import { canonicalDigestOf } from './kernel/canonicalDigest.js';
import { evaluateConditions, type Condition } from './kernel/conditionEvaluator.js';
import { KernelError } from './kernel/kernelError.js';
import { createSecretMasker, type SecretMasker } from './kernel/secretMasker.js';
import { assertTemplateAllowed, resolveTemplate, type ResolutionScope, type TemplateSlot, type UntrustedSources } from './kernel/tokenResolver.js';
import { sendHttpStep, type HttpStepNetwork } from './httpStepRequest.js';
import { resolveHttpRequest } from './httpStepTemplates.js';
import type { PlaybookApprovals } from './playbookApprovals.js';
import type { PlaybookRecord } from './playbookRepository.js';
import { secretNamesReferencedBy, wireErrorOf } from './playbookRules.js';
import type { PlaybookRunRecord, PlaybookRunRepository } from './playbookRunRepository.js';
import type { PlaybookService } from './playbookService.js';
import { readStoreRows, writeStoreRow, type PlaybookStores, type StoreOutcome } from './playbookStoreCells.js';
import { runScriptStep, withoutControlCharacters } from './scriptStepProcess.js';
import { resolveStoreRead, resolveStoreWrite } from './storeCellTemplates.js';

export interface PlaybookRunnerDeps {
  playbooks: Pick<PlaybookService, 'getById'>;
  /** The data stores the store cells read and write; every call is bound to the project of the playbook. */
  stores: PlaybookStores;
  approvals: Pick<PlaybookApprovals, 'assertStillApproved' | 'locatePinned'>;
  runs: PlaybookRunRepository;
  secrets: Pick<SecretService, 'resolve'>;
  clock: () => string;
  newId: () => string;
  /** The name resolution and the forbidden addresses of http cells; the defaults reach the real network. */
  httpNetwork?: HttpStepNetwork;
  limits: { maxStepExecutions: number; maxConcurrentRuns: number; maxRunsNeedingReview: number };
  /** Told once a run is journaled as started and once it is settled, with ids and the status only. */
  observer?: { runStarted: (run: { runId: string; playbookId: string }) => void; runEnded: (run: { runId: string; playbookId: string; status: Settled }) => void };
}

type ScriptCell = Extract<PlaybookCell, { kind: 'script' }>;
type HttpCell = Extract<PlaybookCell, { kind: 'http' }>;
type ReadFromStoreCell = Extract<PlaybookCell, { kind: 'readFromStore' }>;
type WriteToStoreCell = Extract<PlaybookCell, { kind: 'writeToStore' }>;
type Settled = Exclude<PlaybookRunStatus, 'running'>;
type Verdict = { status: Settled; errorCode?: string };
/**
 * A script answers its exit code; an http cell answers the status of the response; both answer the masked output.
 * A read answers its row count and the masked rows as JSON; a write answers whether it inserted or updated, and the id of the row.
 */
type StepOutput = { exitCode: number | null; output: string } | { status: number; output: string } | { rowCount: number; output: string } | { outcome: string; rowId: string };

/** What a step answers to the cells after it: its masked output, never a secret value. */
type StepFields = Record<string, StepOutput>;

interface RunContext {
  run: PlaybookRunRecord;
  playbook: PlaybookRecord;
  pinnedScripts: Record<string, string>;
  inputs: Record<string, unknown>;
  secretValues: ReadonlyMap<string, string>;
  masker: SecretMasker;
}

const INTERRUPTED = 'interrupted';
const HTTP_REFUSAL_CODES = {
  host_not_allowed: 'http_host_not_allowed', address_blocked: 'http_address_blocked', redirect_refused: 'http_redirect_refused',
  timeout: 'http_timeout', failed: 'http_request_failed',
} as const;
const SECRET_SCOPE_KIND = 'playbook';

const busy = (reason: string) => new OpenFleetError('playbook_run_busy', reason, { hint: 'Wait for a run to end, then start again.' });
const reviewBacklogFull = (limit: number) =>
  new OpenFleetError('playbook_review_backlog', `${limit} runs interrupted at an unknown point still await a review: no new run starts, and none of them is deleted.`, { hint: 'Examine the interrupted runs, then start again.' });
const notRunnable =(reason: string) => new OpenFleetError('playbook_not_runnable', reason);
const invalidInput = (reason: string) => new OpenFleetError('invalid_body', reason);

const isScriptCell = (cell: PlaybookCell): cell is ScriptCell => cell.kind === 'script';
const isHttpCell = (cell: PlaybookCell): cell is HttpCell => cell.kind === 'http';
const isReadFromStoreCell = (cell: PlaybookCell): cell is ReadFromStoreCell => cell.kind === 'readFromStore';
const isWriteToStoreCell = (cell: PlaybookCell): cell is WriteToStoreCell => cell.kind === 'writeToStore';

const RUNNABLE_KINDS: ReadonlySet<PlaybookCell['kind']> = new Set(['script', 'http', 'readFromStore', 'writeToStore']);

/** Only script, http and store cells that follow their edges run: a retry, a forEach or another kind of cell (a tool cell included) is refused before anything starts. */
function assertCellsCanRun(playbook: PlaybookRecord): void {
  for (const cell of playbook.flow.cells) {
    if (!RUNNABLE_KINDS.has(cell.kind)) throw notRunnable(`the cell ${cell.id} is a ${cell.kind} cell: this runner executes script, http, readFromStore and writeToStore cells only (a tool cell waits for the run to have an actor and a role).`);
    if (cell.retry !== undefined) throw notRunnable(`the cell ${cell.id} retries: this runner does not retry a step.`);
    const iterates = (cell.next ?? []).some((edge) => edge.forEach !== undefined);
    if (iterates) throw notRunnable(`the cell ${cell.id} iterates with forEach: this runner does not iterate.`);
  }
}

const typeAccepts: Record<PlaybookInputDeclaration['type'], (value: unknown) => boolean> = {
  string: (value) => typeof value === 'string',
  number: (value) => typeof value === 'number' && Number.isFinite(value),
  bool: (value) => typeof value === 'boolean',
  json: (value) => value !== undefined,
};

/** The inputs of a run: each declared input from the call or its default; a missing required input, an undeclared name or a value of the wrong type is refused. */
function resolveRunInputs(declared: readonly PlaybookInputDeclaration[], given: Record<string, unknown>): Record<string, unknown> {
  const declaredNames = new Set(declared.map((input) => input.name));
  const undeclared = Object.keys(given).filter((name) => !declaredNames.has(name));
  if (undeclared.length > 0) throw invalidInput(`the playbook declares no input named ${undeclared.join(', ')}.`);

  const entries = declared.flatMap((input): [string, unknown][] => {
    const value = given[input.name] ?? input.default;
    if (value === undefined) {
      if (input.required) throw invalidInput(`the input ${input.name} is required.`);
      return [];
    }
    if (!typeAccepts[input.type](value)) throw invalidInput(`the input ${input.name} must be a ${input.type}.`);
    return [[input.name, value]];
  });
  return Object.fromEntries(entries);
}

const maskedLeaves = (value: unknown, masker: SecretMasker): unknown => {
  if (typeof value === 'string') return masker.mask(value);
  if (Array.isArray(value)) return value.map((member) => maskedLeaves(member, masker));
  if (typeof value === 'object' && value !== null) return Object.fromEntries(Object.entries(value).map(([key, member]) => [masker.mask(key), maskedLeaves(member, masker)]));
  return value;
};

const conditionsOf = (edgeConditions: NonNullable<PlaybookEdge['when']>): Condition[] =>
  edgeConditions.map((condition) => ({ path: condition.lhs, operator: condition.op, value: condition.rhs, caseInsensitive: condition.caseInsensitive, join: condition.join }));

const describedByStackOrMessage = (error: unknown): string => (error instanceof Error ? (error.stack ?? error.message) : String(error));

/** The verdict of a failure; an unexpected error is logged as text with the secrets of the run masked, never as the raw error. */
const verdictOfFailure = (error: unknown, masker: SecretMasker): Verdict => {
  if (error instanceof KernelError || error instanceof OpenFleetError) return { status: 'failed', errorCode: error.code };
  log('error', 'a playbook step failed unexpectedly', masker.mask(describedByStackOrMessage(error)));
  return { status: 'failed', errorCode: 'internal_error' };
};

/**
 * Runs approved playbooks of script cells, one step at a time, and journals every step before it has any effect.
 * A run starts only when the approval still holds (digest and sha256 of each pinned script), and each step checks its script again right before it starts it.
 * Every output is masked with the values of the secrets the run resolved before it is stored or answered. A step found running after a crash is never started again (see `recover`).
 */
export class PlaybookRunner {
  private readonly inFlight = new Set<Promise<void>>();
  private readonly shutdown = new AbortController();

  constructor(private readonly deps: PlaybookRunnerDeps) {}

  /** At boot: every run and step left running by a daemon that stopped is marked needs_review. Returns how many runs it marked. */
  recover(): number {
    const interruptedRuns = this.deps.runs.interruptEverythingRunning({ errorCode: INTERRUPTED, endedAt: this.deps.clock() });
    if (interruptedRuns > 0) log('warn', 'playbook runs left running by a stopped daemon were marked needs_review', { count: interruptedRuns });
    return interruptedRuns;
  }

  /** Kills the scripts in flight, journals their steps as needs_review, and refuses any new run. */
  async stop(): Promise<void> {
    this.shutdown.abort();
    await Promise.allSettled([...this.inFlight]);
  }

  /**
   * Validates the run, journals it as running, and starts executing it in the background: the answer is the run as journaled, not its result.
   * Nothing is written when the run is refused. Throws playbook_not_found, playbook_not_runnable, playbook_unapproved, script_changed, invalid_body,
   * secret_not_connected_on_this_device (this device holds no value for a secret the playbook uses), playbook_run_busy or playbook_review_backlog (the runs awaiting a review reach their cap).
   */
  async start(input: { playbookId: string; inputs: Record<string, unknown>; actorKind: PlaybookRunActorKind }): Promise<PlaybookRunRecord> {
    const isStopping = this.shutdown.signal.aborted;
    if (isStopping) throw busy('the daemon is stopping.');
    const playbook = this.deps.playbooks.getById(input.playbookId);
    assertCellsCanRun(playbook);
    const pinnedScripts = this.deps.approvals.assertStillApproved(playbook);
    const inputs = resolveRunInputs(playbook.inputs, input.inputs);
    const secretValues = await this.resolveSecretsOf(playbook);
    const masker = this.maskerOf(secretValues);

    this.assertRoomForAnotherRun(playbook.id);
    const run: PlaybookRunRecord = {
      id: this.deps.newId(), playbookId: playbook.id, playbookRev: playbook.contentRev, flowSha256: canonicalDigestOf(playbook.flow),
      status: 'running', inputs: maskedLeaves(inputs, masker) as Record<string, unknown>, actorKind: input.actorKind, errorCode: null, startedAt: this.deps.clock(), endedAt: null,
    };
    this.deps.runs.insertRun(run);
    this.deps.observer?.runStarted({ runId: run.id, playbookId: run.playbookId });

    const execution = this.execute({ run, playbook, pinnedScripts, inputs, secretValues, masker }).finally(() => this.inFlight.delete(execution));
    this.inFlight.add(execution);
    return run;
  }

  private assertRoomForAnotherRun(playbookId: string): void {
    const { runs, limits } = this.deps;
    if (runs.isRunning(playbookId)) throw busy('this playbook is already running.');
    if (runs.countRunning() >= limits.maxConcurrentRuns) throw busy(`${limits.maxConcurrentRuns} runs are already in progress.`);
    const isReviewBacklogFull = runs.countNeedingReview() >= limits.maxRunsNeedingReview;
    if (isReviewBacklogFull) throw reviewBacklogFull(limits.maxRunsNeedingReview);
  }

  private async resolveSecretsOf(playbook: PlaybookRecord): Promise<Map<string, string>> {
    const values = new Map<string, string>();
    for (const name of secretNamesReferencedBy(playbook)) values.set(name, await this.deps.secrets.resolve({ kind: SECRET_SCOPE_KIND, id: playbook.id }, name));
    return values;
  }

  private maskerOf(secretValues: ReadonlyMap<string, string>): SecretMasker {
    try {
      return createSecretMasker([...secretValues].map(([name, value]) => ({ name, value })), { maxInputChars: MAX_STEP_OUTPUT_BYTES });
    } catch (error) {
      if (error instanceof KernelError) throw wireErrorOf(error);
      throw error;
    }
  }

  private async execute(context: RunContext): Promise<void> {
    const { runs, clock, observer } = this.deps;
    const { run, playbook } = context;
    let verdict: Verdict;
    try {
      verdict = await this.walk(context);
    } catch (error) {
      verdict = verdictOfFailure(error, context.masker);
    }
    runs.settleRun({ id: run.id, status: verdict.status, errorCode: verdict.errorCode, endedAt: clock() });
    runs.pruneFinishedBeyond(playbook.id, playbook.policy.maxRunsToKeep);
    observer?.runEnded({ runId: run.id, playbookId: playbook.id, status: verdict.status });
  }

  /** Executes the cells from the entry along their edges until a cell leads nowhere, a step does not succeed, or the cap of step executions is reached. */
  private async walk(context: RunContext): Promise<Verdict> {
    const { runs, clock, limits } = this.deps;
    const cells = context.playbook.flow.cells;
    const steps: StepFields = {};
    let executed = 0;

    for (let cell: PlaybookCell | undefined = cells[0]; cell !== undefined; cell = this.cellAfter(cell, cells, { inputs: context.inputs, steps })) {
      const isStopping = this.shutdown.signal.aborted;
      if (isStopping) return { status: 'needs_review', errorCode: INTERRUPTED };
      const hasReachedTheCap = executed >= limits.maxStepExecutions;
      if (hasReachedTheCap) return { status: 'failed', errorCode: 'step_limit_exceeded' };

      executed += 1;
      runs.insertStep({ runId: context.run.id, seq: executed, stepId: cell.id, startedAt: clock() });
      const { verdict, output } = await this.runStep(cell, context, steps);
      runs.settleStep({ runId: context.run.id, seq: executed, status: verdict.status, output, errorCode: verdict.errorCode, endedAt: clock() });
      const didNotSucceed = verdict.status !== 'succeeded';
      if (didNotSucceed) return verdict;
      steps[cell.id] = output as StepOutput;
    }
    return { status: 'succeeded' };
  }

  /** The cell an edge leads to: with no `next`, the cell that follows in document order; else the first edge whose conditions hold on the inputs and the outputs so far. */
  private cellAfter(cell: PlaybookCell, cells: readonly PlaybookCell[], scope: { inputs: Record<string, unknown>; steps: StepFields }): PlaybookCell | undefined {
    if (cell.next === undefined) return cells[cells.indexOf(cell) + 1];
    const taken = cell.next.find((edge) => edge.when === undefined || evaluateConditions(conditionsOf(edge.when), scope));
    return cells.find((candidate) => candidate.id === taken?.to);
  }

  private async runStep(cell: PlaybookCell, context: RunContext, steps: StepFields): Promise<{ verdict: Verdict; output?: unknown }> {
    try {
      if (isScriptCell(cell)) return await this.runScriptCell(cell, context, steps);
      if (isHttpCell(cell)) return await this.runHttpCell(cell, context, steps);
      if (isReadFromStoreCell(cell)) return this.runReadFromStoreCell(cell, context, steps);
      if (isWriteToStoreCell(cell)) return this.runWriteToStoreCell(cell, context, steps);
      throw notRunnable(`the cell ${cell.id} is not a script, http or store cell.`);
    } catch (error) {
      return { verdict: verdictOfFailure(error, context.masker) };
    }
  }

  private async runScriptCell(cell: ScriptCell, context: RunContext, steps: StepFields): Promise<{ verdict: Verdict; output?: unknown }> {
    const { approvals } = this.deps;
    const { args, env } = this.resolvedTemplatesOf(cell, context, steps);
    const script = approvals.locatePinned(cell.program, context.pinnedScripts);

    const outcome = await runScriptStep({
      path: script.path, args, env, workingDirectory: dirname(script.path), signal: this.shutdown.signal,
      timeoutMs: (cell.timeoutSeconds ?? DEFAULT_STEP_TIMEOUT_SECONDS) * 1000,
      maxRetainedChars: MAX_STEP_OUTPUT_BYTES + context.masker.longestSpellingLength,
    });

    // The shape-based layer runs before the masker: it would read the marker `[secret:NAME]` as a secret-named key and hide the name.
    // The control characters go last: a secret that holds one must reach the masker as printed.
    const output = withoutControlCharacters(context.masker.mask(maskedSecrets(outcome.output)));
    if (outcome.kind === 'aborted') return { verdict: { status: 'needs_review', errorCode: INTERRUPTED }, output: { output } };
    if (outcome.kind === 'spawn_failed') return { verdict: { status: 'failed', errorCode: 'script_spawn_failed' } };
    if (outcome.kind === 'timeout') return { verdict: { status: 'failed', errorCode: 'script_timeout' }, output: { output } };
    const stepOutput: StepOutput = { exitCode: outcome.exitCode, output };
    return outcome.exitCode === 0 ? { verdict: { status: 'succeeded' }, output: stepOutput } : { verdict: { status: 'failed', errorCode: 'script_failed' }, output: stepOutput };
  }

  private async runHttpCell(cell: HttpCell, context: RunContext, steps: StepFields): Promise<{ verdict: Verdict; output?: unknown }> {
    const untrusted: UntrustedSources = { stepIds: new Set(context.playbook.flow.cells.map((other) => other.id)), isItemUntrusted: true };
    const scope: ResolutionScope = { inputs: context.inputs, steps, secretValueOf: (name) => context.secretValues.get(name) };
    const { url, headers, body } = resolveHttpRequest(cell, scope, untrusted);

    const outcome = await sendHttpStep({
      url, method: cell.method, headers, body, allowedHosts: context.playbook.policy.allowedHosts ?? [], signal: this.shutdown.signal,
      timeoutMs: (cell.timeoutSeconds ?? DEFAULT_STEP_TIMEOUT_SECONDS) * 1000,
      maxRetainedChars: MAX_STEP_OUTPUT_BYTES + context.masker.longestSpellingLength,
    }, this.deps.httpNetwork);

    if (outcome.kind === 'aborted') return { verdict: { status: 'needs_review', errorCode: INTERRUPTED } };
    if (outcome.kind !== 'response') return { verdict: { status: 'failed', errorCode: HTTP_REFUSAL_CODES[outcome.kind] } };

    // Same order as a script's output: the shape-based layer, then the masker, then the control characters.
    const output = withoutControlCharacters(context.masker.mask(maskedSecrets(outcome.body)));
    const stepOutput: StepOutput = { status: outcome.status, output };
    const isSuccess = outcome.status >= 200 && outcome.status < 300;
    return isSuccess ? { verdict: { status: 'succeeded' }, output: stepOutput } : { verdict: { status: 'failed', errorCode: 'http_status_failed' }, output: stepOutput };
  }

  private runReadFromStoreCell(cell: ReadFromStoreCell, context: RunContext, steps: StepFields): { verdict: Verdict; output?: unknown } {
    const { scope, untrusted } = this.templateWorldOf(context, steps);
    const request = resolveStoreRead(cell, scope, untrusted);
    const outcome = readStoreRows({ stores: this.deps.stores, projectId: context.playbook.projectId, request });
    // Same order as a script's output: the shape-based layer, then the masker, then the control characters.
    return this.verdictOfStoreStep(outcome, (output) => ({ ...output, output: withoutControlCharacters(context.masker.mask(maskedSecrets(String(output['output'])))) }));
  }

  private runWriteToStoreCell(cell: WriteToStoreCell, context: RunContext, steps: StepFields): { verdict: Verdict; output?: unknown } {
    const { scope, untrusted } = this.templateWorldOf(context, steps);
    const request = resolveStoreWrite(cell, scope, untrusted);
    const outcome = writeStoreRow({ stores: this.deps.stores, projectId: context.playbook.projectId, runId: context.run.id, request, mask: (value) => context.masker.mask(value) });
    return this.verdictOfStoreStep(outcome, (output) => output);
  }

  private verdictOfStoreStep(outcome: StoreOutcome, maskedOutputOf: (output: Record<string, unknown>) => Record<string, unknown>): { verdict: Verdict; output?: unknown } {
    if (outcome.kind === 'failed') return { verdict: { status: 'failed', errorCode: outcome.code } };
    return { verdict: { status: 'succeeded' }, output: maskedOutputOf(outcome.output) };
  }

  private templateWorldOf(context: RunContext, steps: StepFields): { scope: ResolutionScope; untrusted: UntrustedSources } {
    return {
      untrusted: { stepIds: new Set(context.playbook.flow.cells.map((other) => other.id)), isItemUntrusted: true },
      scope: { inputs: context.inputs, steps, secretValueOf: (name) => context.secretValues.get(name) },
    };
  }

  /** The arguments and environment of a script cell with their tokens resolved. A token is checked in its place again here: a flow stored outside the save path is held to the same rules. */
  private resolvedTemplatesOf(cell: ScriptCell, context: RunContext, steps: StepFields): { args: string[]; env: Record<string, string> } {
    const untrusted: UntrustedSources = { stepIds: new Set(context.playbook.flow.cells.map((other) => other.id)), isItemUntrusted: true };
    const scope: ResolutionScope = { inputs: context.inputs, steps, secretValueOf: (name) => context.secretValues.get(name) };
    const resolveIn = (template: string, slot: TemplateSlot): string => {
      assertTemplateAllowed({ template, slot, untrusted });
      return resolveTemplate({ template, scope }).text;
    };
    return {
      args: cell.args.map((template) => resolveIn(template, 'script_args')),
      env: Object.fromEntries(Object.entries(cell.env).map(([name, template]) => [name, resolveIn(template, 'script_env')])),
    };
  }
}
