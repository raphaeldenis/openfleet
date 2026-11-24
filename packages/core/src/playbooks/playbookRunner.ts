import { dirname } from 'node:path';
import {
  DEFAULT_STEP_TIMEOUT_SECONDS, DEFAULT_WAIT_FOR_POLL_MS, DEFAULT_WAIT_FOR_SECONDS, MAX_CHILD_RUNS_PER_ROOT, MAX_FOR_EACH_ITEMS,MAX_MANUAL_WAIT_SECONDS, MAX_PROMPT_CHARS, MAX_STEP_EXECUTIONS_PER_RUN, MAX_SUB_PLAYBOOK_DEPTH, MAX_STEP_OUTPUT_BYTES,MIN_WAIT_FOR_POLL_MS, OpenFleetError,
  type ManualDecision, type PlaybookCell, type PlaybookEdge, type PlaybookInputDeclaration, type PlaybookRunActorKind, type PlaybookRunLauncher,
} from '@openfleet/shared';
import { log } from '../logger.js';
import { maskedSecrets } from '../redact.js';
import type { SecretService } from '../secrets/secretService.js';
import { stepIdsReadByTheCell, stepIdsReadByTheRetryPredicate } from './cellStepReferences.js';
import { canonicalDigestOf } from './kernel/canonicalDigest.js';
import { evaluateConditions, type Condition } from './kernel/conditionEvaluator.js';
import { valueAtDottedPath } from './kernel/dottedPath.js';
import { KernelError } from './kernel/kernelError.js';
import { createSecretMasker, type SecretMasker, type SecretToMask } from './kernel/secretMasker.js';
import { assertTemplateAllowed, resolveTemplate, type ResolutionScope, type TemplateSlot, type UntrustedSources } from './kernel/tokenResolver.js';
import { sendHttpStep, type HttpStepNetwork } from './httpStepRequest.js';
import { resolveHttpRequest } from './httpStepTemplates.js';
import type { ManualResumeProof } from './manualResumeProof.js';
import type { PlaybookApprovals } from './playbookApprovals.js';
import type { PlaybookManualRequestRepository } from './playbookManualRequestRepository.js';
import type { PlaybookRecord } from './playbookRepository.js';
import { secretNamesReferencedBy, wireErrorOf } from './playbookRules.js';
import type { PlaybookRunRecord, PlaybookRunRepository, SettledStatus } from './playbookRunRepository.js';
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
  /** The questions of the manual cells: a run waiting for a human is kept here, and answered once. */
  manual: PlaybookManualRequestRepository;
  /** Tells whether the answer to a manual step comes with the proof of a human gesture for exactly that step. */
  manualResumeProof: ManualResumeProof;
  secrets: Pick<SecretService, 'resolve'>;
  clock: () => string;
  newId: () => string;
  /** Calls `onElapsed` once after `delayMs` and returns the function that cancels it; a waitFor cell sleeps on it. The default is a real timer. */
  startTimer?: StartTimer;
  /** The name resolution and the forbidden addresses of http cells; the defaults reach the real network. */
  httpNetwork?: HttpStepNetwork;
  limits: { maxStepExecutions: number; maxConcurrentRuns: number; maxRunsNeedingReview: number; maxParkedRunsPerProject: number; maxWaitEvaluations: number; maxForEachIterations: number; maxEmptyTransitions: number; maxChildRunsPerRoot: number };
  /** Told once a run is journaled as started and once it is settled, with ids and the status only. */
  observer?: { runStarted: (run: { runId: string; playbookId: string }) => void; runEnded: (run: { runId: string; playbookId: string; status: Settled }) => void };
}

export type StartTimer = (onElapsed: () => void, delayMs: number) => () => void;

const startRealTimer: StartTimer = (onElapsed, delayMs) => {
  const timer = setTimeout(onElapsed, delayMs);
  return () => clearTimeout(timer);
};

type ScriptCell = Extract<PlaybookCell, { kind: 'script' }>;
type HttpCell = Extract<PlaybookCell, { kind: 'http' }>;
type ReadFromStoreCell = Extract<PlaybookCell, { kind: 'readFromStore' }>;
type WriteToStoreCell = Extract<PlaybookCell, { kind: 'writeToStore' }>;
type ManualCell = Extract<PlaybookCell, { kind: 'manual' }>;
type WaitForCell = Extract<PlaybookCell, { kind: 'waitFor' }>;
type SubPlaybookCell = Extract<PlaybookCell, { kind: 'subPlaybook' }>;
type Settled = SettledStatus;
type Verdict = { status: Settled; errorCode?: string };
/** A step ends with a verdict, or parks the run on a human: the journal of a parked step is written by the repository, not settled by the walk. */
type StepResult = { verdict: Verdict; output?: unknown } | { parked: true };
/** The state a walk resumes from: the cell after the manual step that was answered, the steps already journaled and their outputs. */
type ResumePoint = { from: Transition | undefined; executed: number; steps: StepFields };
/**
 * A script answers its exit code; an http cell answers the status of the response; both answer the masked output.
 * A read answers its row count and the masked rows as JSON; a write answers whether it inserted or updated, and the id of the row.
 * A manual step answers the decision of the human; a waitFor step answers the time it waited and how many times it evaluated its predicate.
 * A subPlaybook step answers the id and the status of its child run, and the masked, bounded output of the last step of the child.
 */
type StepOutput = { exitCode: number | null; output: string } | { status: number; output: string } | { rowCount: number; output: string } | { outcome: string; rowId: string } | { decision: string } | { elapsedMs: number; evaluations: number } | { childRunId: string; status: string; errorCode?: string; output?: string };

/** What one walk of a run counts: the steps it journaled (its `seq`), its forEach iterations, the edges it followed over an empty list, and the output of the last step that succeeded. */
type WalkState = { executed: number; iterations: number; emptyTransitions: number; lastOutput: unknown };
/** The budget a root run shares with every run it calls, in depth and in sequence: the steps all of them executed, and the children it started. */
type TreeBudget = { stepsExecuted: number; childrenStarted: number };
/** The cell an edge leads to, and the list the edge iterates when it carries a forEach. */
type Transition = { cell: PlaybookCell; forEach?: string };
/** One element of a forEach edge: `{{item}}` and `{{index}}` of the cell it runs. An element of a list a step produced is untrusted data. */
type Iteration = { item: unknown; index: number; isItemUntrusted: boolean };

/** The inputs of a run an agent launched, and of every child below it (the launcher is inherited), are text the agent typed: they stand where a step output stands. */
const hasUntrustedInputs = (run: PlaybookRunRecord): boolean => run.launchedBy.kind === 'agent';

/** What a step answers to the cells after it: its masked output, never a secret value. */
type StepFields = Record<string, StepOutput>;

interface RunContext {
  run: PlaybookRunRecord;
  playbook: PlaybookRecord;
  pinnedScripts: Record<string, string>;
  inputs: Record<string, unknown>;
  secretValues: ReadonlyMap<string, string>;
  masker: SecretMasker;
  /** The playbooks of the runs that called this one, then this one: the root run holds only its own playbook. */
  lineage: readonly string[];
  /** The secrets this run masks: its own, and those of every run above it, which a child never reads but never writes in the clear either. */
  secretsToMask: readonly SecretToMask[];
  tree: TreeBudget;
  liveTree: LiveTree;
  /** The one cell this run executes, when it was started to run a single cell: no edge is followed after it. */
  soloCellId?: string;
}

/** What the runs of one tree share while they run: the signal that cancels all of them, the ids of the runs, and the execution of the root. */
interface LiveTree {
  cancel: AbortController;
  /** Ends when the cancellation or the stop of the daemon fires. */
  signal: AbortSignal;
  runIds: Set<string>;
  /** Each run of the tree as it was when it settled, before the retention of finished runs could purge it. */
  settledRuns: Map<string, PlaybookRunRecord>;
  execution?: Promise<void>;
}

const INTERRUPTED = 'interrupted';
/** Journal only, never on the wire: a run, its tree and its steps ended by a cancellation. */
const RUN_CANCELLED = 'run_cancelled';
const PLAYBOOK_CHANGED_WHILE_WAITING = 'playbook_changed_while_waiting';
/** Journal only, never on the wire: the tree budget written when the run parked is out of its bounds. */
const PARKED_TREE_BUDGET_INVALID = 'parked_tree_budget_invalid';
/** Journal only, never on the wire: the journal of a run answered by a human could not be read back to resume it. */
const RESUME_PREPARATION_FAILED = 'resume_preparation_failed';

/** What the journal of a parked step holds about the tree budget: nothing (parked before it was journaled), a budget inside its bounds, or an inconsistent value. */
type ParkedTreeBudget = { kind: 'absent' } | { kind: 'invalid' } | { kind: 'valid'; tree: TreeBudget };

const isCountWithin = (value: unknown, cap: number): value is number => Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= cap;
/** What a walk answers when a manual cell parked the run: nothing is settled, the answer of the human or the end of the wait does it. */
const PARKED = { status: 'waiting_manual' } as const;
const HTTP_REFUSAL_CODES = {
  host_not_allowed: 'http_host_not_allowed', address_blocked: 'http_address_blocked', redirect_refused: 'http_redirect_refused',
  timeout: 'http_timeout', failed: 'http_request_failed',
} as const;
const RETRY_EXHAUSTED = 'retry_exhausted';
const STEP_LIMIT_EXCEEDED = 'step_limit_exceeded';
const FOR_EACH_SOURCE_INVALID = 'for_each_source_invalid';
const FOR_EACH_LIMIT_EXCEEDED = 'for_each_limit_exceeded';
const FOR_EACH_ITERATION_FAILED = 'for_each_iteration_failed';
const SUB_PLAYBOOK_FAILED = 'sub_playbook_failed';
const SUB_PLAYBOOK_LIMIT_EXCEEDED = 'sub_playbook_limit_exceeded';
const SECRET_SCOPE_KIND = 'playbook';

const busy = (reason: string) => new OpenFleetError('playbook_run_busy', reason, { hint: 'Wait for a run to end, then start again.' });
const reviewBacklogFull = (limit: number) =>
  new OpenFleetError('playbook_review_backlog', `${limit} runs interrupted at an unknown point still await a review: no new run starts, and none of them is deleted.`, { hint: 'Examine the interrupted runs, then start again.' });
const movedDuringStart = () => new OpenFleetError('playbook_conflict', 'the playbook was edited while its run was starting.', { hint: 'Start the run again once the edit is done.' });
const waitingBacklogFull = (limit: number) =>
  new OpenFleetError('playbook_waiting_backlog', `${limit} runs of this project already wait for a human answer: no new run of a playbook with a manual cell starts.`, { hint: 'Answer one of the waiting runs, then start again.' });
const manualAlreadyAnswered = () => new OpenFleetError('manual_already_answered', 'this step was already answered.', { hint: 'Open the run to see its outcome.' });
const manualWaitExpired = () => new OpenFleetError('manual_wait_expired', 'the wait for this answer is over and the run has ended.', { hint: 'Start the playbook again.' });
const humanProofRequired = () => new OpenFleetError('human_proof_required', 'answering a manual step needs the proof of a human gesture in the desktop app.', { hint: 'Answer it from the run screen.' });
const runNotFound = () => new OpenFleetError('playbook_run_not_found', 'run or step not found');
const runAlreadyEnded = () => new OpenFleetError('playbook_conflict', 'this run has already ended: there is nothing to cancel.', { hint: 'Open the run to see its outcome.' });
const resumeNotPrepared = () => new OpenFleetError('playbook_conflict', 'the journal of this run could not be read: the run is in review and was not resumed.', { hint: 'Open the run to examine it, then start the playbook again.' });
const playbookMovedWhileWaiting = () => new OpenFleetError('playbook_conflict', 'the playbook is no longer the one this run was started from.', { hint: 'Review the playbook, then start a new run.' });
const notRunnable =(reason: string) => new OpenFleetError('playbook_not_runnable', reason);
const invalidInput = (reason: string) => new OpenFleetError('invalid_body', reason);

const isScriptCell = (cell: PlaybookCell): cell is ScriptCell => cell.kind === 'script';
const isHttpCell = (cell: PlaybookCell): cell is HttpCell => cell.kind === 'http';
const isReadFromStoreCell = (cell: PlaybookCell): cell is ReadFromStoreCell => cell.kind === 'readFromStore';
const isWriteToStoreCell = (cell: PlaybookCell): cell is WriteToStoreCell => cell.kind === 'writeToStore';
const isManualCell = (cell: PlaybookCell): cell is ManualCell => cell.kind === 'manual';
const isWaitForCell = (cell: PlaybookCell): cell is WaitForCell => cell.kind === 'waitFor';
const isSubPlaybookCell = (cell: PlaybookCell): cell is SubPlaybookCell => cell.kind === 'subPlaybook';

const SAFE_TO_REPEAT_HTTP_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD']);

/** A second attempt repeats the effect of the first: a write, a request that changes the server, a question to a human and a child run are never attempted twice. */
const cannotBeRetried = (cell: PlaybookCell): boolean => {
  if (isHttpCell(cell)) return !SAFE_TO_REPEAT_HTTP_METHODS.has(cell.method);
  return cell.kind === 'writeToStore' || cell.kind === 'manual' || cell.kind === 'subPlaybook';
};

const RUNNABLE_KINDS: ReadonlySet<PlaybookCell['kind']> = new Set(['script', 'http', 'readFromStore', 'writeToStore', 'manual', 'waitFor', 'subPlaybook']);

/** Only script, http, store, manual, waitFor and subPlaybook cells run: another kind of cell (a tool cell), a retry on a cell whose effect a second attempt would repeat, and a forEach into a manual cell are refused before anything starts. */
function assertCellsCanRun(playbook: PlaybookRecord): void {
  for (const cell of playbook.flow.cells) {
    if (!RUNNABLE_KINDS.has(cell.kind)) throw notRunnable(`the cell ${cell.id} is a ${cell.kind} cell: this runner executes script, http, readFromStore, writeToStore, manual, waitFor and subPlaybook cells only (a tool cell waits for the run to have an actor and a role).`);
    if (cell.retry !== undefined && cannotBeRetried(cell)) throw notRunnable(`the cell ${cell.id} retries, and a ${cell.kind} cell has an effect that a second attempt would repeat: only script, readFromStore, waitFor and http GET or HEAD cells retry.`);
    const iteratesIntoManualCell = (cell.next ?? []).some((edge) => edge.forEach !== undefined && playbook.flow.cells.find((target) => target.id === edge.to)?.kind === 'manual');
    if (iteratesIntoManualCell) throw notRunnable(`the cell ${cell.id} iterates into a manual cell: a question to a human is never asked once per element.`);
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
  if (undeclared.length > 0) throw invalidInput(`${undeclared.length} of the inputs given are not declared by the playbook.`);

  const entries = declared.flatMap((input): [string, unknown][] => {
    const givenValue = Object.hasOwn(given, input.name) ? given[input.name] : undefined;
    const value = givenValue ?? input.default;
    if (value === undefined) {
      if (input.required) throw invalidInput(`the input ${input.name} is required.`);
      return [];
    }
    if (!typeAccepts[input.type](value)) throw invalidInput(`the input ${input.name} must be a ${input.type}.`);
    return [[input.name, value]];
  });
  return Object.fromEntries(entries);
}

/** The elements of the list a forEach edge iterates: a list, or the text of a step that printed one as JSON. Anything else is no list. */
const itemsOf = (source: unknown): unknown[] | undefined => {
  if (Array.isArray(source)) return source;
  if (typeof source !== 'string') return undefined;
  try {
    const parsed: unknown = JSON.parse(source);
    return Array.isArray(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
};

const secretsToMaskOf = (secretValues: ReadonlyMap<string, string>): SecretToMask[] => [...secretValues].map(([name, value]) => ({ name, value }));

const STOPPED = Symbol('stopped');

/** The result of `pending`, or STOPPED as soon as `signal` aborts; a rejection of `pending` after the stop is handled here and dropped. */
const untilStopped = <T>(pending: Promise<T>, signal: AbortSignal | undefined): Promise<T | typeof STOPPED> => {
  if (signal === undefined) return pending;
  if (signal.aborted) {
    pending.catch(() => undefined);
    return Promise.resolve(STOPPED);
  }
  return new Promise((resolve, reject) => {
    const onStop = () => resolve(STOPPED);
    signal.addEventListener('abort', onStop, { once: true });
    pending.then(
      (value) => { signal.removeEventListener('abort', onStop); resolve(value); },
      (error: unknown) => { signal.removeEventListener('abort', onStop); reject(error); },
    );
  });
};

const maskedLeaves = (value: unknown, masker: SecretMasker): unknown => {
  if (typeof value === 'string') return masker.mask(value);
  if (Array.isArray(value)) return value.map((member) => maskedLeaves(member, masker));
  if (typeof value === 'object' && value !== null) return Object.fromEntries(Object.entries(value).map(([key, member]) => [masker.mask(key), maskedLeaves(member, masker)]));
  return value;
};

const hasManualCell = (playbook: PlaybookRecord): boolean => playbook.flow.cells.some(isManualCell);
const hasIncomingEdge = (playbook: PlaybookRecord, cell: PlaybookCell): boolean => playbook.flow.cells.some((other) => (other.next ?? []).some((edge) => edge.to === cell.id));

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
  /** The tree of every run that runs in this process, by the id of each of its runs. */
  private readonly liveTrees = new Map<string, LiveTree>();

  constructor(private readonly deps: PlaybookRunnerDeps) {}

  /** At boot: every run and step left running by a daemon that stopped is marked needs_review. Returns how many runs it marked. */
  recover(): number {
    const interruptedRuns = this.deps.runs.interruptEverythingRunning({ errorCode: INTERRUPTED, endedAt: this.deps.clock() });
    if (interruptedRuns > 0) log('warn', 'playbook runs left running by a stopped daemon were marked needs_review', { count: interruptedRuns });
    this.expireOverdueManualWaits();
    return interruptedRuns;
  }

  /** Ends the runs whose wait for a human is over, on the injected clock; with `projectId`, only those of that project. Called at boot, at each start and at each answer, so no timer has to outlive a run. */
  expireOverdueManualWaits(scope: { projectId?: string } = {}): void {
    const expiredRuns = this.deps.manual.expireOverdue(this.deps.clock(), scope);
    for (const { runId, playbookId } of expiredRuns) this.deps.observer?.runEnded({ runId, playbookId, status: 'failed' });
  }

  /** Kills the scripts in flight, journals their steps as needs_review, and refuses any new run. */
  async stop(): Promise<void> {
    this.shutdown.abort();
    await Promise.allSettled([...this.inFlight]);
  }

  /**
   * Validates the run, journals it as running, and starts executing it in the background: the answer is the run as journaled, not its result.
   * With `projectId`, a playbook of another project is refused with playbook_not_found, before the secrets are read and again right before the journal.
   * Nothing is written when the run is refused. The stop of the daemon and the approval of the playbook are checked again once the secrets are read, and an edit during that wait refuses the run.
   * Throws playbook_not_found, playbook_not_runnable, playbook_unapproved, playbook_conflict (the playbook was edited while the run started), script_changed, invalid_body,
   * secret_not_connected_on_this_device (this device holds no value for a secret the playbook uses), playbook_run_busy or playbook_review_backlog (the runs awaiting a review reach their cap).
   */
  async start(input: { playbookId: string; inputs: Record<string, unknown>; actorKind: PlaybookRunActorKind; launchedBy: PlaybookRunLauncher; projectId?: string }): Promise<PlaybookRunRecord> {
    const context = await this.beginRun({ ...input, lineage: [], inheritedSecrets: [], tree: { stepsExecuted: 0, childrenStarted: 0 } });
    this.executeInBackground(context);
    return context.run;
  }

  /**
   * Starts a run that executes the entry cell of the playbook and nothing else: the edges after it never run. It goes through every check of `start`. It is not a general single-cell runner.
   * A playbook that holds a manual cell is refused (the cell could stand behind a question to a human that the run would skip), and so is any cell but the entry cell, the one a full run starts with and that no edge leads to
   * (any other cell may stand behind a condition, a fallback branch or an iteration that the approval covered), and a cell that reads the output of another step in its fields or its retry predicate, or the whole `steps` dictionary (no step ran; the predicate may read the output of the cell's own attempt).
   * Throws what `start` throws, and playbook_cell_not_found.
   */
  async startCell(input: { playbookId: string; cellId: string; inputs: Record<string, unknown>; actorKind: PlaybookRunActorKind; launchedBy: PlaybookRunLauncher; projectId?: string }): Promise<PlaybookRunRecord> {
    const { cellId, ...start } = input;
    const context = await this.beginRun({ ...start, soloCellId: cellId, lineage: [], inheritedSecrets: [], tree: { stepsExecuted: 0, childrenStarted: 0 } });
    this.executeInBackground(context);
    return context.run;
  }

  /**
   * A cell runs alone only when nothing the approval covered stands in front of it: no manual cell in the playbook, the cell is the entry cell (the first of the flow, with no incoming edge),
   * and no read of the output of another step or of the whole `steps` dictionary, in its fields or in its retry predicate (a retry predicate may read the output of the cell's own attempt).
   */
  private assertCellCanRunAlone(playbook: PlaybookRecord, cellId: string): void {
    const cell = playbook.flow.cells.find((candidate) => candidate.id === cellId);
    if (cell === undefined) throw new OpenFleetError('playbook_cell_not_found', 'cell not found on this playbook');
    if (hasManualCell(playbook)) throw notRunnable('a playbook that asks a human cannot run one cell: the cell could stand behind a question that the run would skip.');
    const isTheEntryCell = playbook.flow.cells[0] === cell && !hasIncomingEdge(playbook, cell);
    if (!isTheEntryCell) throw notRunnable(`the cell ${cell.id} is not the entry cell of the playbook: only the cell a full run starts with runs alone, since any other cell may stand behind a condition or an iteration the approval covered. Run the playbook.`);
    const stepsReadOutsideItsOwnAttempt = [...stepIdsReadByTheCell(cell), ...stepIdsReadByTheRetryPredicate(cell).filter((stepId) => stepId !== cell.id)];
    const readsAnotherStep = stepsReadOutsideItsOwnAttempt.length > 0;
    if (readsAnotherStep) throw notRunnable(`the cell ${cell.id} reads the output of another step, and a run of one cell has none: run the playbook.`);
  }

  /** Walks the run in the background, tracked until it ends; its tree stays cancellable while it runs. */
  private executeInBackground(context: RunContext, resumeFrom?: ResumePoint): void {
    const { liveTree } = context;
    const execution = this.execute(context, resumeFrom).then(() => undefined).finally(() => {
      this.inFlight.delete(execution);
      for (const runId of liveTree.runIds) {
        const isStillThisTree = this.liveTrees.get(runId) === liveTree;
        if (isStillThisTree) this.liveTrees.delete(runId);
      }
    });
    liveTree.execution = execution;
    this.inFlight.add(execution);
  }

  /** A fresh tree for a root run: cancelled by `cancelRun` or by the stop of the daemon. */
  private newLiveTree(): LiveTree {
    const cancel = new AbortController();
    return { cancel, signal: AbortSignal.any([cancel.signal, this.shutdown.signal]), runIds: new Set(), settledRuns: new Map() };
  }

  /**
   * Cancels a run and every run of its tree, whichever of them is named: a run asleep (a retry backoff, a waitFor), a script or a request in flight, a child that runs or that still reads its secrets, a question put to a human.
   * The run, its steps and its children end `failed` with the code `run_cancelled` (an `error_code` of the journal, not an error of the protocol); the place of every run among the runs at once is free when this returns.
   * The answer is the run as it was when it settled, so the retention of finished runs, which may purge it at that instant, never fails a cancellation that succeeded.
   * A cancellation is not an answer to a manual step: it needs no proof of a human gesture, and it never continues a run.
   * Two calls made while the tree stops both succeed with the same ended run; a call made after the run ended is refused. A wait for a human is settled at one instant, for this run only: a deadline reached at that instant ends the run as expired and the cancel of it is refused.
   * Throws playbook_run_not_found, or playbook_conflict (the run has already ended, or the human answered at the same time).
   */
  async cancelRun(runId: string): Promise<PlaybookRunRecord> {
    const { runs, manual, clock } = this.deps;
    const run = runs.get(runId);
    if (run === undefined) throw runNotFound();
    if (run.status === 'waiting_manual') {
      const settlement = manual.abandonPendingQuestion({ runId, errorCode: RUN_CANCELLED, at: clock() });
      if (settlement === 'not_pending') throw runAlreadyEnded();
      this.deps.observer?.runEnded({ runId, playbookId: run.playbookId, status: 'failed' });
      if (settlement === 'expired') throw runAlreadyEnded();
      return runs.get(runId)!;
    }
    const liveTree = this.liveTrees.get(runId);
    const isRunningHere = run.status === 'running' && liveTree !== undefined;
    if (!isRunningHere) throw runAlreadyEnded();
    liveTree.cancel.abort();
    await liveTree.execution;
    return liveTree.settledRuns.get(runId) ?? runs.get(runId)!;
  }

  /** The verdict of a run that was stopped: the cancellation of its tree, or the stop of the daemon, which leaves the effects of the step to a review. */
  private interruptionOf(context: RunContext): Verdict {
    const isCancelled = context.liveTree.cancel.signal.aborted && !this.shutdown.signal.aborted;
    return isCancelled ? { status: 'failed', errorCode: RUN_CANCELLED } : { status: 'needs_review', errorCode: INTERRUPTED };
  }

  /**
   * Validates a run and journals it as running, with nothing between the last check and the journal: what the daemon, the playbook and the capacity are AFTER the secrets were read decides.
   * A run called by another one (`lineage` holds the playbooks above it, `projectId` the project it must belong to) is refused beyond MAX_SUB_PLAYBOOK_DEPTH levels, when its playbook is already above it (a cycle),
   * when it waits for a human (a parent cannot park on its child) and when its playbook is of another project, which answers playbook_not_found like a playbook that does not exist.
   * A called run (`parentStep` names the step of the run that calls it) is journaled in one transaction with the link written in that step, and only while the parent run still runs and its step is still running:
   * a parent whose playbook was deleted while the secrets of the child were read starts no child. It masks the secrets of every run above it (`inheritedSecrets`) from its first journal write, and takes its place in the budget of the tree.
   */
  private async beginRun(input: { playbookId: string; inputs: Record<string, unknown>; actorKind: PlaybookRunActorKind; launchedBy: PlaybookRunLauncher; lineage: readonly string[]; inheritedSecrets: readonly SecretToMask[]; tree: TreeBudget; liveTree?: LiveTree; soloCellId?: string; projectId?: string; parentStep?: { runId: string; seq: number } }): Promise<RunContext> {
    this.assertNotStopping();
    this.expireOverdueManualWaits();
    const playbook = this.deps.playbooks.getById(input.playbookId);
    const isCalled = input.lineage.length > 0;
    this.assertBelongsToProject(playbook, input.projectId);
    this.assertMayBeStartedBy(input.launchedBy, playbook);
    if (isCalled) this.assertMayBeCalledFrom(playbook, input.lineage);
    assertCellsCanRun(playbook);
    if (input.soloCellId !== undefined) this.assertCellCanRunAlone(playbook, input.soloCellId);
    const pinnedScripts = this.deps.approvals.assertStillApproved(playbook);
    const inputs = resolveRunInputs(playbook.inputs, input.inputs);
    const secretValues = await this.resolveSecretsOf(playbook, input.liveTree?.signal);
    this.assertStillStartableAfterTheWait(playbook);
    this.assertBelongsToProject(this.deps.playbooks.getById(playbook.id), input.projectId);
    const secretsToMask = [...input.inheritedSecrets, ...secretsToMaskOf(secretValues)];
    const masker = this.maskerOf(secretsToMask);

    this.assertRoomForAnotherRun(playbook);
    this.assertTreeIsNotStopped(input.liveTree);
    const run: PlaybookRunRecord = {
      id: this.deps.newId(), playbookId: playbook.id, playbookRev: playbook.contentRev, flowSha256: canonicalDigestOf(playbook.flow),
      status: 'running', inputs: maskedLeaves(inputs, masker) as Record<string, unknown>, actorKind: input.actorKind, launchedBy: input.launchedBy, errorCode: null, startedAt: this.deps.clock(), endedAt: null,
    };
    this.journalTheRun(run, input.parentStep);
    if (input.parentStep !== undefined) input.tree.childrenStarted += 1;
    const liveTree = input.liveTree ?? this.newLiveTree();
    liveTree.runIds.add(run.id);
    this.liveTrees.set(run.id, liveTree);
    this.deps.observer?.runStarted({ runId: run.id, playbookId: run.playbookId });
    return { run, playbook, pinnedScripts, inputs, secretValues, masker, lineage: [...input.lineage, playbook.id], secretsToMask, tree: input.tree, liveTree, ...(input.soloCellId !== undefined && { soloCellId: input.soloCellId }) };
  }

  /** Writes the run; a called run is written together with the link in the step of its parent, which must still be running. */
  private journalTheRun(run: PlaybookRunRecord, parentStep: { runId: string; seq: number } | undefined): void {
    if (parentStep === undefined) {
      this.deps.runs.insertRun(run);
      return;
    }
    const outcome = this.deps.runs.insertRunLinkedToStep({ run, parentStep });
    if (outcome === 'parent_gone') throw notRunnable('the run that calls this playbook no longer runs: its playbook was deleted or the run ended.');
  }

  private assertBelongsToProject(playbook: PlaybookRecord, projectId: string | undefined): void {
    const isOfAnotherProject = projectId !== undefined && playbook.projectId !== projectId;
    if (isOfAnotherProject) throw new OpenFleetError('playbook_not_found', 'no such playbook in this project.');
  }

  /** A playbook a human locked against agents starts under no run an agent launched, whatever its level: the launcher is inherited by the children. A change of the lock revokes the approval, which the checks after the wait catch. */
  private assertMayBeStartedBy(launchedBy: PlaybookRunLauncher, playbook: PlaybookRecord): void {
    const isLockedAgainstThisLauncher = launchedBy.kind === 'agent' && playbook.agentLocked;
    if (isLockedAgainstThisLauncher) throw new OpenFleetError('playbook_locked', 'this playbook is locked against agents: a human starts it.');
  }

  private assertMayBeCalledFrom(playbook: PlaybookRecord, lineage: readonly string[]): void {
    const isACycle = lineage.includes(playbook.id);
    if (isACycle) throw notRunnable('this playbook is already running above this call: a playbook never calls itself, even through another one.');
    const isTooDeep = lineage.length > MAX_SUB_PLAYBOOK_DEPTH;
    if (isTooDeep) throw notRunnable(`playbooks call each other ${MAX_SUB_PLAYBOOK_DEPTH} levels deep at most.`);
    if (hasManualCell(playbook)) throw notRunnable('a playbook that waits for a human cannot be called by another one: the run that calls it would wait with no one to answer.');
  }

  /** A run called by another one is journaled only while the tree of its parent is neither cancelled nor stopped: nothing is written, and no start is announced, once the signal fired. */
  private assertTreeIsNotStopped(liveTree: LiveTree | undefined): void {
    const isTreeStopped = liveTree?.signal.aborted === true;
    if (isTreeStopped) throw new OpenFleetError('playbook_conflict', 'the run that calls this playbook was cancelled or stopped before this run started.');
  }

  private assertNotStopping(): void {
    const isStopping = this.shutdown.signal.aborted;
    if (isStopping) throw busy('the daemon is stopping.');
  }

  /** The secrets are read asynchronously: a start that waited for them goes on only if the daemon is not stopping and the playbook is still the approved revision it validated. */
  private assertStillStartableAfterTheWait(validated: PlaybookRecord): void {
    this.assertNotStopping();
    const current = this.deps.playbooks.getById(validated.id);
    this.deps.approvals.assertStillApproved(current);
    const hasMovedDuringTheWait = current.contentRev !== validated.contentRev;
    if (hasMovedDuringTheWait) throw movedDuringStart();
  }

  private assertRoomForAnotherRun(playbook: PlaybookRecord): void {
    const { runs, manual, limits } = this.deps;
    if (runs.isRunning(playbook.id)) throw busy('this playbook is already running.');
    if (runs.countRunning() >= limits.maxConcurrentRuns) throw busy(`${limits.maxConcurrentRuns} runs are already in progress.`);
    const isReviewBacklogFull = runs.countNeedingReview() >= limits.maxRunsNeedingReview;
    if (isReviewBacklogFull) throw reviewBacklogFull(limits.maxRunsNeedingReview);
    const isWaitingBacklogFull = hasManualCell(playbook) && manual.countParkedInProject(playbook.projectId) >= limits.maxParkedRunsPerProject;
    if (isWaitingBacklogFull) throw waitingBacklogFull(limits.maxParkedRunsPerProject);
  }

  /**
   * Reads the secrets the playbook references. With `stopSignal`, a stop ends the wait for a read at once: the values read so far are returned (the caller checks the signal) and the read that is still in flight is left to end on its own, its value dropped.
   */
  private async resolveSecretsOf(playbook: PlaybookRecord, stopSignal?: AbortSignal): Promise<Map<string, string>> {
    const values = new Map<string, string>();
    for (const name of secretNamesReferencedBy(playbook)) {
      const value = await untilStopped(this.deps.secrets.resolve({ kind: SECRET_SCOPE_KIND, id: playbook.id }, name), stopSignal);
      if (value === STOPPED) return values;
      values.set(name, value);
    }
    return values;
  }

  private maskerOf(secretsToMask: readonly SecretToMask[]): SecretMasker {
    try {
      return createSecretMasker(secretsToMask, { maxInputChars: MAX_STEP_OUTPUT_BYTES });
    } catch (error) {
      if (error instanceof KernelError) throw wireErrorOf(error);
      throw error;
    }
  }

  /** Walks the run, from the entry or from the point a manual answer resumes it, and settles it, unless a manual cell parked it: a parked run is settled by its answer, or by the end of its wait. */
  private async execute(context: RunContext, resumeFrom?: ResumePoint): Promise<{ outcome: Verdict | typeof PARKED; lastOutput: unknown }> {
    const { runs, clock, observer } = this.deps;
    const { run, playbook } = context;
    const state = this.stateOfAWalk(resumeFrom);
    let outcome: Verdict | typeof PARKED;
    try {
      outcome = await this.walk(context, state, resumeFrom);
    } catch (error) {
      outcome = verdictOfFailure(error, context.masker);
    }
    if (outcome.status === 'waiting_manual') return { outcome, lastOutput: state.lastOutput };
    const verdict = this.verdictAtTerminalSettle(context, outcome);
    runs.settleRun({ id: run.id, status: verdict.status, errorCode: verdict.errorCode, endedAt: clock() });
    context.liveTree.settledRuns.set(run.id, runs.get(run.id)!);
    runs.pruneFinishedBeyond(playbook.id, playbook.policy.maxRunsToKeep);
    observer?.runEnded({ runId: run.id, playbookId: playbook.id, status: verdict.status });
    return { outcome: verdict, lastOutput: state.lastOutput };
  }

  /**
   * The verdict the run is settled with. A cancellation admitted before this instant wins over the verdict the walk reached, a success included: the walk may have yielded after its last step (an empty forEach)
   * and finished without reading the signal again. A cancellation admitted after the settlement finds the run ended and is refused, so a run whose steps and settlement came first keeps its verdict.
   */
  private verdictAtTerminalSettle(context: RunContext, walkVerdict: Verdict): Verdict {
    const isCancelledBeforeTheSettle = context.liveTree.cancel.signal.aborted && !this.shutdown.signal.aborted;
    return isCancelledBeforeTheSettle ?{ status: 'failed', errorCode: RUN_CANCELLED } : walkVerdict;
  }

  /**
   * The counters of a walk. A walk resumed after a manual answer starts its iterations at the steps already journaled: every iteration is at least one step, so the count never falls short of the iterations
   * the run ran before it parked (it can overcount, and then refuses a batch that an exact count would have accepted).
   */
  private stateOfAWalk(resumeFrom?: ResumePoint): WalkState {
    const journaledSteps = resumeFrom?.executed ?? 0;
    return { executed: journaledSteps, iterations: journaledSteps, emptyTransitions: 0, lastOutput: undefined };
  }

  /**
   * Executes the cells from the entry (or from the resume point) along their edges until a cell leads nowhere, a step does not succeed, a manual cell parks the run, or a cap is reached.
   * The stop of the daemon is checked at every edge followed, and an edge that runs nothing (a forEach over an empty list) is counted by `emptyTransitions` in `executeForEach`.
   */
  private async walk(context: RunContext, state: WalkState, resumeFrom?: ResumePoint): Promise<Verdict | typeof PARKED> {
    const cells = context.playbook.flow.cells;
    const steps: StepFields = resumeFrom?.steps ?? {};
    const entry = context.soloCellId === undefined ? cells[0]! : cells.find((cell) => cell.id === context.soloCellId)!;
    const first: Transition | undefined = resumeFrom === undefined ? { cell: entry } : resumeFrom.from;
    const followsNoEdge = context.soloCellId !== undefined;

    for (let transition = first; transition !== undefined; transition = followsNoEdge ? undefined : this.transitionAfter(transition.cell, cells, { inputs: context.inputs, steps })) {
      const isStopping = context.liveTree.signal.aborted;
      if (isStopping) return this.interruptionOf(context);
      const outcome = transition.forEach === undefined
        ? await this.executeCellWithItsRetries({ cell: transition.cell, context, steps, state })
        : await this.executeForEach({ cell: transition.cell, source: transition.forEach, context, steps, state });
      if (outcome !== undefined) return outcome;
    }
    return { status: 'succeeded' };
  }

  /**
   * Executes a cell, and again after a failed attempt or an attempt whose `until` does not hold, up to `maxAttempts`, waiting `backoffMs` on the injected timer between two attempts.
   * Every attempt is a journaled step and counts among the step executions of the whole tree of runs (the root run and every run it calls share one budget). Returns undefined when the cell succeeded, else what ends the walk.
   * An attempt that needs a review (the daemon stops) is never followed by another one.
   */
  private async executeCellWithItsRetries({ cell, context, steps, state, iteration }: { cell: PlaybookCell; context: RunContext; steps: StepFields; state: WalkState; iteration?: Iteration }): Promise<Verdict | typeof PARKED | undefined> {
    const { runs, clock, limits } = this.deps;
    const maxAttempts = cell.retry?.maxAttempts ?? 1;
    for (let attempt = 1; ; attempt += 1) {
      const isStopping = context.liveTree.signal.aborted;
      if (isStopping) return this.interruptionOf(context);
      const hasReachedTheCap = context.tree.stepsExecuted >= limits.maxStepExecutions;
      if (hasReachedTheCap) return { status: 'failed', errorCode: STEP_LIMIT_EXCEEDED };

      context.tree.stepsExecuted += 1;
      state.executed += 1;
      const seq = state.executed;
      runs.insertStep({ runId: context.run.id, seq, stepId: cell.id, startedAt: clock() });
      const result = await this.runStep({ cell, context, steps, seq, iteration });
      if ('parked' in result) return PARKED;

      const isLastAttempt = attempt >= maxAttempts;
      const judged = this.judgeAttempt({ cell, context, steps, result, attempt, isLastAttempt });
      const { verdict, output } = judged;
      runs.settleStep({ runId: context.run.id, seq, status: verdict.status, output, errorCode: verdict.errorCode, endedAt: clock() });

      if (verdict.status === 'succeeded') state.lastOutput = output;
      if (judged.isSatisfied) return undefined;
      const canTryAgain = (verdict.status === 'failed' || verdict.status === 'succeeded') && !isLastAttempt;
      if (!canTryAgain) return verdict;

      const backoffMs = cell.retry?.backoffMs ?? 0;
      const wakeUp = backoffMs > 0 ? await this.sleep(backoffMs, context.liveTree.signal) : 'elapsed';
      if (wakeUp === 'interrupted') return this.interruptionOf(context);
    }
  }

  /**
   * Tells what an attempt came to. A succeeded attempt publishes its output to the steps, then its `until` is evaluated on the inputs, the steps and `attempt.number`: a cell with no `until` is satisfied by its success.
   * A succeeded last attempt whose `until` does not hold fails with `retry_exhausted`; a failed attempt keeps its own code.
   */
  private judgeAttempt({ cell, context, steps, result, attempt, isLastAttempt }: { cell: PlaybookCell; context: RunContext; steps: StepFields; result: { verdict: Verdict; output?: unknown }; attempt: number; isLastAttempt: boolean }): { verdict: Verdict; output?: unknown; isSatisfied: boolean } {
    const { verdict, output } = result;
    if (verdict.status !== 'succeeded') return { verdict, output, isSatisfied: false };

    steps[cell.id] = output as StepOutput;
    let isUntilMet: boolean;
    try {
      isUntilMet = evaluateConditions(conditionsOf(cell.retry?.until ?? []), { inputs: context.inputs, steps, attempt: { number: attempt } });
    } catch (error) {
      return { verdict: verdictOfFailure(error, context.masker), output, isSatisfied: false };
    }
    if (isUntilMet) return { verdict, output, isSatisfied: true };
    const exhaustedVerdict: Verdict = { status: 'failed', errorCode: RETRY_EXHAUSTED };
    return { verdict: isLastAttempt ? exhaustedVerdict : verdict, output, isSatisfied: false };
  }

  /** The transition an edge leads to: with no `next`, the cell that follows in document order; else the first edge whose conditions hold on the inputs and the outputs so far. */
  private transitionAfter(cell: PlaybookCell, cells: readonly PlaybookCell[], scope: { inputs: Record<string, unknown>; steps: StepFields }): Transition | undefined {
    if (cell.next === undefined) {
      const following = cells[cells.indexOf(cell) + 1];
      return following === undefined ? undefined : { cell: following };
    }
    const taken = cell.next.find((edge) => edge.when === undefined || evaluateConditions(conditionsOf(edge.when), scope));
    const target = cells.find((candidate) => candidate.id === taken?.to);
    return target === undefined ? undefined : { cell: target, forEach: taken?.forEach };
  }

  /**
   * Runs the cell an edge leads to once per element of the list the edge iterates, in order, with `{{item}}` and `{{index}}`; every iteration is a journaled step of its own.
   * The list is checked before any element runs: not a list is `for_each_source_invalid`, more than MAX_FOR_EACH_ITEMS elements, or more iterations than the run still has, is `for_each_limit_exceeded`.
   * An iteration that fails stops everything: the next elements never start and the run fails with `for_each_iteration_failed` (the step keeps its own code).
   * An iteration that needs a review, or the cap of step executions of the tree, ends the walk with that verdict as it is.
   * An empty list runs nothing, so no step cap stops a cycle of such edges: each one is counted, the run fails with `for_each_limit_exceeded` beyond `maxEmptyTransitions`,
   * and the walk gives the event loop a turn at each one, so the daemon keeps serving requests and can stop.
   */
  private async executeForEach({ cell, source, context, steps, state }: { cell: PlaybookCell; source: string; context: RunContext; steps: StepFields; state: WalkState }): Promise<Verdict | typeof PARKED | undefined> {
    const items = itemsOf(valueAtDottedPath({ inputs: context.inputs, steps }, source));
    if (items === undefined) return { status: 'failed', errorCode: FOR_EACH_SOURCE_INVALID };
    const hasTooManyItems = items.length > MAX_FOR_EACH_ITEMS;
    const wouldPassTheIterationsOfTheRun = state.iterations + items.length > this.deps.limits.maxForEachIterations;
    if (hasTooManyItems || wouldPassTheIterationsOfTheRun) return { status: 'failed', errorCode: FOR_EACH_LIMIT_EXCEEDED };

    const isEmpty = items.length === 0;
    if (isEmpty) {
      state.emptyTransitions += 1;
      const hasPassedTheEmptyTransitions = state.emptyTransitions > this.deps.limits.maxEmptyTransitions;
      if (hasPassedTheEmptyTransitions) return { status: 'failed', errorCode: FOR_EACH_LIMIT_EXCEEDED };
      await new Promise<void>((resume) => setImmediate(resume));
      return undefined;
    }
    state.iterations += items.length;

    const isItemUntrusted = source.startsWith('steps.') || (source.startsWith('inputs.') && hasUntrustedInputs(context.run));
    for (const [index, item] of items.entries()) {
      const outcome = await this.executeCellWithItsRetries({ cell, context, steps, state, iteration: { item, index, isItemUntrusted } });
      if (outcome === undefined) continue;
      if (outcome.status === 'waiting_manual') return outcome;
      const isEndImposedFromOutside = outcome.errorCode === STEP_LIMIT_EXCEEDED || outcome.errorCode === RUN_CANCELLED;
      const mustBeReportedAsAFailedIteration = outcome.status === 'failed' && !isEndImposedFromOutside;
      return mustBeReportedAsAFailedIteration ? { status: 'failed', errorCode: FOR_EACH_ITERATION_FAILED } : outcome;
    }
    return undefined;
  }

  private async runStep({ cell, context, steps, seq, iteration }: { cell: PlaybookCell; context: RunContext; steps: StepFields; seq: number; iteration?: Iteration }): Promise<StepResult> {
    try {
      if (isScriptCell(cell)) return await this.runScriptCell(cell, context, steps, iteration);
      if (isHttpCell(cell)) return await this.runHttpCell(cell, context, steps, iteration);
      if (isReadFromStoreCell(cell)) return this.runReadFromStoreCell(cell, context, steps, iteration);
      if (isWriteToStoreCell(cell)) return this.runWriteToStoreCell(cell, context, steps, iteration);
      if (isManualCell(cell)) return this.parkOnManualCell(cell, context, steps, seq);
      if (isWaitForCell(cell)) return await this.runWaitForCell(cell, context, steps);
      if (isSubPlaybookCell(cell)) return await this.runSubPlaybookCell({ cell, context, steps, seq, iteration });
      throw notRunnable(`the cell ${cell.id} is not a script, http, store, manual, waitFor or subPlaybook cell.`);
    } catch (error) {
      return { verdict: verdictOfFailure(error, context.masker) };
    }
  }

  /**
   * Writes the question of a manual cell and parks the run on it: the step and the run wait for a human, no script, request or write is started, and nothing here ends the run.
   * The question is the prompt with its tokens resolved and every secret value masked; the wait ends after the `timeoutSeconds` of the cell, at most MAX_MANUAL_WAIT_SECONDS.
   * A project whose parked runs reached their cap fails the step instead, so the cap holds even for runs that started before it was reached.
   */
  private parkOnManualCell(cell: ManualCell, context: RunContext, steps: StepFields, seq: number): StepResult {
    const { manual, clock, limits } = this.deps;
    const isParkingRoomLeft = manual.countParkedInProject(context.playbook.projectId) < limits.maxParkedRunsPerProject;
    if (!isParkingRoomLeft) return { verdict: { status: 'failed', errorCode: 'playbook_waiting_backlog' } };

    const { scope, untrusted } = this.templateWorldOf(context, steps);
    assertTemplateAllowed({ template: cell.prompt, slot: 'text', untrusted });
    const resolvedPrompt = resolveTemplate({ template: cell.prompt, scope }).text;
    const promptMasked = withoutControlCharacters(context.masker.mask(maskedSecrets(resolvedPrompt))).slice(0, MAX_PROMPT_CHARS);

    const requestedAt = clock();
    const waitSeconds = Math.min(cell.timeoutSeconds ?? MAX_MANUAL_WAIT_SECONDS, MAX_MANUAL_WAIT_SECONDS);
    const expiresAt = new Date(Date.parse(requestedAt) + waitSeconds * 1000).toISOString();
    this.deps.runs.writeRunningStepOutput({ runId: context.run.id, seq, output: { treeBudget: { ...context.tree } } });
    manual.park({ runId: context.run.id, seq, promptMasked, requestedAt, expiresAt });
    return { parked: true };
  }

  /**
   * Evaluates the predicate of a waitFor cell with the evaluator of conditions of the kernel, on the inputs, the outputs of the steps so far and `wait` (`elapsedMs`, `now`: the injected clock).
   * No secret is in that scope. It polls every `pollMs` (at least MIN_WAIT_FOR_POLL_MS) on the injected timer, and fails with `wait_for_timeout` at the ceiling of the cell (`timeoutSeconds`, DEFAULT_WAIT_FOR_SECONDS by default)
   * or after `maxWaitEvaluations` evaluations, whichever comes first. The ceiling is checked before the predicate at every wake-up: a wake-up strictly after the ceiling (a timer that overslept, a clock that jumped) fails
   * even when the predicate holds, and the instant of the ceiling itself is still on time. The deadline is measured on the injected wall clock, so a clock that jumps forward ends the wait early and one that jumps back
   * lengthens it by the jump at most, still within the cap of evaluations. The stop of the daemon ends it as needs_review.
   */
  private async runWaitForCell(cell: WaitForCell, context: RunContext, steps: StepFields): Promise<StepResult> {
    const { clock, limits } = this.deps;
    const conditions = conditionsOf(cell.predicate);
    const startedAtMs = Date.parse(clock());
    const ceilingMs = (cell.timeoutSeconds ?? DEFAULT_WAIT_FOR_SECONDS) * 1000;
    const pollMs = Math.max(cell.pollMs ?? DEFAULT_WAIT_FOR_POLL_MS, MIN_WAIT_FOR_POLL_MS);

    for (let evaluation = 1; evaluation <= limits.maxWaitEvaluations; evaluation += 1) {
      const now = clock();
      const elapsedMs = Date.parse(now) - startedAtMs;
      const isPastTheCeiling = elapsedMs > ceilingMs;
      if (isPastTheCeiling) return { verdict: { status: 'failed', errorCode: 'wait_for_timeout' } };
      const holds = evaluateConditions(conditions, { inputs: context.inputs, steps, wait: { elapsedMs, now } });
      if (holds) return { verdict: { status: 'succeeded' }, output: { elapsedMs, evaluations: evaluation } };

      const hasReachedTheCeiling = elapsedMs >= ceilingMs;
      const isLastEvaluation = evaluation === limits.maxWaitEvaluations;
      if (hasReachedTheCeiling || isLastEvaluation) return { verdict: { status: 'failed', errorCode: 'wait_for_timeout' } };

      const wakeUp = await this.sleep(Math.min(pollMs, ceilingMs - elapsedMs), context.liveTree.signal);
      if (wakeUp === 'interrupted') return { verdict: this.interruptionOf(context) };
    }
    return { verdict: { status: 'failed', errorCode: 'wait_for_timeout' } };
  }

  /**
   * Runs the playbook the cell names as a run of its own, for the actor of this run, and waits for it to end.
   * The child is journaled like any run: it is approved, it takes a place among the runs at once (the parent keeps its own, so `maxConcurrentRuns = 1` refuses the child with playbook_run_busy), and its secrets are its own.
   * The step names its child (`{ childRunId, status: 'running' }`) in the same transaction that journals the child, and only while this run still runs, so a parent deleted while the secrets of the child were read starts no child (`parentOf`).
   * The inputs of the child are the inputs of the cell with their tokens resolved and the secrets of this run masked; the child masks the secrets of this run too, from its first write.
   * The result comes back from the execution of the child, not from its journal: a child whose journal was deleted or pruned still answers its result. The answer of the child is untrusted data and goes through the masker, the shape-based layer and the cap as any output.
   * A root starts at most `maxChildRunsPerRoot` children over its whole tree: the child over that budget fails the step with `sub_playbook_limit_exceeded`.
   * Editing the playbook of this run while its child runs changes nothing for this run: it goes on with the content it was approved with, and the edit takes effect at the next run.
   */
  private async runSubPlaybookCell({ cell, context, steps, seq, iteration }: { cell: SubPlaybookCell; context: RunContext; steps: StepFields; seq: number; iteration?: Iteration }): Promise<StepResult> {
    const hasReachedTheChildrenOfTheTree = context.tree.childrenStarted >= this.deps.limits.maxChildRunsPerRoot;
    if (hasReachedTheChildrenOfTheTree) return { verdict: { status: 'failed', errorCode: SUB_PLAYBOOK_LIMIT_EXCEEDED } };

    const childInputs = this.inputsOfChild(cell, context, steps, iteration);
    const childContext = await this.prepareChildRun({ cell, context, childInputs, seq });
    if ('verdict' in childContext) return childContext;
    const { outcome: childOutcome, lastOutput } = await this.execute(childContext);

    const childStatus = childOutcome.status;
    const childErrorCode = 'errorCode' in childOutcome ? childOutcome.errorCode : undefined;
    const output: StepOutput = {
      childRunId: childContext.run.id, status: childStatus, ...(childErrorCode === undefined ? {} : { errorCode: childErrorCode }),
      ...(lastOutput === undefined ? {} : { output: this.untrustedTextOf(lastOutput, context.masker) }),
    };
    if (childStatus === 'succeeded') return { verdict: { status: 'succeeded' }, output };
    const wasCancelledWithTheTree = childErrorCode === RUN_CANCELLED;
    if (wasCancelledWithTheTree) return { verdict: this.interruptionOf(context), output };
    if (childStatus === 'needs_review') return { verdict: { status: 'needs_review', errorCode: INTERRUPTED }, output };
    return { verdict: { status: 'failed', errorCode: SUB_PLAYBOOK_FAILED }, output };
  }

  /** Journals the child run, or answers the verdict of the parent step when the tree was stopped while the child prepared: the verdict of the stop wins over the error of the preparation. */
  private async prepareChildRun({ cell, context, childInputs, seq }: { cell: SubPlaybookCell; context: RunContext; childInputs: Record<string, unknown>; seq: number }): Promise<RunContext | { verdict: Verdict }> {
    try {
      return await this.beginRun({
        playbookId: cell.playbookId, inputs: childInputs, actorKind: context.run.actorKind, launchedBy: context.run.launchedBy, lineage: context.lineage, projectId: context.playbook.projectId,
        inheritedSecrets: context.secretsToMask, tree: context.tree, liveTree: context.liveTree, parentStep: { runId: context.run.id, seq },
      });
    } catch (error) {
      const wasStoppedWhilePreparing = context.liveTree.signal.aborted;
      if (wasStoppedWhilePreparing) return { verdict: this.interruptionOf(context) };
      throw error;
    }
  }

  /** The inputs of a subPlaybook cell: every text resolved in this run (no untrusted data, no secret) and masked with the secrets of this run; a number and a boolean go through as they are. */
  private inputsOfChild(cell: SubPlaybookCell, context: RunContext, steps: StepFields, iteration?: Iteration): Record<string, unknown> {
    const { scope, untrusted } = this.templateWorldOf(context, steps, iteration);
    const resolved = Object.entries(cell.inputs ?? {}).map(([name, value]): [string, unknown] => {
      if (typeof value !== 'string') return [name, value];
      assertTemplateAllowed({ template: value, slot: 'child_input', untrusted });
      return [name, context.masker.mask(resolveTemplate({ template: value, scope }).text)];
    });
    return Object.fromEntries(resolved);
  }

  /**
   * What a child answered, as the text a step of this run keeps: every text leaf masked with the secrets of this run before the answer is serialized again (an escaped form of a secret then still matches),
   * the whole text masked once more, the control characters out, and the cap of the output of a step. The shape-based layer already ran in the child, and would read the marker `[secret:NAME]` it left as a secret-named key.
   */
  private untrustedTextOf(value: unknown, masker: SecretMasker): string {
    const text = JSON.stringify(maskedLeaves(value, masker)).slice(0, MAX_STEP_OUTPUT_BYTES + masker.longestSpellingLength);
    return withoutControlCharacters(masker.mask(text)).slice(0, MAX_STEP_OUTPUT_BYTES);
  }

  /** Sleeps on the injected timer; the stop of the daemon and the cancellation of the run cancel the timer and end the sleep at once. */
  private sleep(delayMs: number, signal: AbortSignal): Promise<'elapsed' | 'interrupted'> {
    if (signal.aborted) return Promise.resolve('interrupted');
    return new Promise((resolve) => {
      const cancelTimer = (this.deps.startTimer ?? startRealTimer)(() => {
        signal.removeEventListener('abort', onStop);
        resolve('elapsed');
      }, delayMs);
      const onStop = () => {
        cancelTimer();
        resolve('interrupted');
      };
      signal.addEventListener('abort', onStop, { once: true });
    });
  }

  /**
   * Answers a manual step with the decision of a human and, on an approval, goes on with the cell after it.
   * Order of the refusals: the proof of a human gesture for exactly this step is required first, then the wait must still be open (`manual_wait_expired`) and unanswered (`manual_already_answered`),
   * a place among the runs at once must be free (`playbook_run_busy`), the playbook must be the approved content the run started from (the run goes to needs_review otherwise), and the secrets must resolve again and be maskable (a value that cannot be masked refuses the answer and leaves the question pending); an inconsistent tree budget in the journal of the parked step puts the run in review.
   * Only then is the answer recorded, once: a second answer, even at the same time, is refused. A rejection ends the run as failed. No secret value was kept while the run waited.
   * Throws human_proof_required, playbook_run_not_found, manual_wait_expired, manual_already_answered, playbook_run_busy, playbook_unapproved, script_changed, playbook_conflict or secret_not_connected_on_this_device.
   */
  async resumeManualStep(input: { runId: string; seq: number; decision: ManualDecision; proof: string | undefined }): Promise<PlaybookRunRecord> {
    const { runs, manual, limits } = this.deps;
    this.assertNotStopping();
    const hasNoProof = input.proof === undefined;
    if (hasNoProof) throw humanProofRequired();

    this.expireOverdueManualWaits();
    const run = runs.get(input.runId);
    const request = manual.get(input.runId, input.seq);
    if (run === undefined || request === undefined) throw runNotFound();
    this.assertStillOpenForAnswer(request.status);
    if (runs.countRunning() >= limits.maxConcurrentRuns) throw busy(`${limits.maxConcurrentRuns} runs are already in progress.`);

    const isProvenHuman = this.deps.manualResumeProof.consume(input.proof, { runId: input.runId, seq: input.seq });
    if (!isProvenHuman) throw humanProofRequired();

    const playbookBeforeTheSecrets = this.deps.playbooks.getById(run.playbookId);
    this.assertStillTheApprovedRun({ run, playbook: playbookBeforeTheSecrets, seq: input.seq });
    const isApproval = input.decision === 'approve';
    const secretValues = isApproval ? await this.resolveSecretsOf(playbookBeforeTheSecrets) : new Map<string, string>();
    return this.commitAnswer({ runId: input.runId, seq: input.seq, decision: isApproval ? 'approved' : 'rejected', secretValues });
  }

  /**
   * Records the answer and starts the continuation with no `await` between the checks and the write: what the daemon and the playbook are NOW decides, not what they were before the secrets were read.
   * The playbook is read again and must still be the approved content the run started from; the wait must still be open at this instant; a place among the runs at once must still be free.
   * The place is taken by the move of the run to running in the same transaction as the answer, so no other start or answer can take it in between. A refusal here leaves the question pending, except an end of wait.
   */
  private commitAnswer({ runId, seq, decision, secretValues }: { runId: string; seq: number; decision: 'approved' | 'rejected'; secretValues: Map<string, string> }): PlaybookRunRecord {
    const { runs, manual, limits, clock } = this.deps;
    this.assertNotStopping();
    this.expireOverdueManualWaits();
    const run = runs.get(runId);
    const request = manual.get(runId, seq);
    if (run === undefined || request === undefined) throw runNotFound();
    this.assertStillOpenForAnswer(request.status);

    const playbook = this.deps.playbooks.getById(run.playbookId);
    const pinnedScripts = this.assertStillTheApprovedRun({ run, playbook, seq });
    const needsAPlace = decision === 'approved';
    if (needsAPlace && runs.countRunning() >= limits.maxConcurrentRuns) throw busy(`${limits.maxConcurrentRuns} runs are already in progress.`);

    const parkedBudget: ParkedTreeBudget = needsAPlace ? this.treeBudgetParkedWith(() => runs.stepOutputOf(runId, seq)) : { kind: 'absent' };
    const isJournalInconsistent = parkedBudget.kind === 'invalid';
    if (isJournalInconsistent) {
      const wasClosed = this.deps.manual.cancel({ runId, seq, errorCode: PARKED_TREE_BUDGET_INVALID, at: clock() });
      if (!wasClosed) throw this.refusalOfAnAnswerNotRecorded({ runId, seq });
      this.deps.observer?.runEnded({ runId, playbookId: playbook.id, status: 'needs_review' });
      throw manualAlreadyAnswered();
    }
    const treeBudgetWhenParked = parkedBudget.kind === 'valid' ? parkedBudget.tree : undefined;

    const secretsToMask = secretsToMaskOf(secretValues);
    const masker = this.maskerOf(secretsToMask);
    const resumePoint = needsAPlace ? this.prepareResumeOrCloseTheQuestion({ run, playbook, seq }) : undefined;
    const wasRecorded = manual.answer({ runId, seq, decision, answeredAt: clock() });
    if (!wasRecorded) throw this.refusalOfAnAnswerNotRecorded({ runId, seq });

    if (resumePoint === undefined) {
      const rejectedRun = runs.get(runId)!;
      runs.pruneFinishedBeyond(playbook.id, playbook.policy.maxRunsToKeep);
      this.deps.observer?.runEnded({ runId, playbookId: playbook.id, status: 'failed' });
      return rejectedRun;
    }
    this.continueAfterManualApproval({ run, playbook, pinnedScripts, secretValues, secretsToMask, masker, resumePoint, tree: treeBudgetWhenParked ?? { stepsExecuted: seq, childrenStarted: 0 } });
    return runs.get(runId)!;
  }

  /**
   * Rebuilds, from the journal, the point a run resumes from, BEFORE the answer flips the run to running. A journal that cannot be read or does not hold the parked step closes the question and puts the run in review
   * with the journal-only code `resume_preparation_failed`, so no running run is left without a walk, holding a place among the runs at once, which no cancellation could reach.
   */
  private prepareResumeOrCloseTheQuestion({ run, playbook, seq }: { run: PlaybookRunRecord; playbook: PlaybookRecord; seq: number }): ResumePoint {
    try {
      const journaledSteps = this.deps.runs.stepsOf(run.id);
      const steps: StepFields = Object.fromEntries(journaledSteps.filter((step) => step.status === 'succeeded').map((step) => [step.stepId, step.output as StepOutput]));
      const parkedStep = journaledSteps.find((step) => step.seq === seq);
      if (parkedStep === undefined) throw new Error('the journal does not hold the parked step');
      const cells = playbook.flow.cells;
      const parkedCell = cells.find((cell) => cell.id === parkedStep.stepId);
      const isParkedOnAManualCell = parkedCell !== undefined && isManualCell(parkedCell);
      if (!isParkedOnAManualCell) throw new Error('the parked step does not name a manual cell of the flow');
      const from = this.transitionAfter(parkedCell, cells, { inputs: run.inputs, steps });
      return { from, executed: seq, steps };
    } catch {
      log('warn', 'a manual answer could not resume its run: the journal of the run could not be read', { runId: run.id });
      const wasClosed = this.deps.manual.cancel({ runId: run.id, seq, errorCode: RESUME_PREPARATION_FAILED, at: this.deps.clock() });
      if (!wasClosed) throw this.refusalOfAnAnswerNotRecorded({ runId: run.id, seq });
      this.deps.observer?.runEnded({ runId: run.id, playbookId: playbook.id, status: 'needs_review' });
      throw resumeNotPrepared();
    }
  }

  /**
   * The budget of the tree of runs the root consumed when it parked, as the parked step journaled it: the steps of every run of the tree and the children started, among those that
   * retention or a deletion removed since. A run parked before the budget was journaled has none, and resumes from its own steps.
   */
  private treeBudgetParkedWith(readParkedStepOutput: () => unknown): ParkedTreeBudget {
    let parkedStepOutput: unknown;
    try {
      parkedStepOutput = readParkedStepOutput();
    } catch {
      return { kind: 'invalid' };
    }
    const hasNoOutput = parkedStepOutput === null || parkedStepOutput === undefined;
    if (hasNoOutput) return { kind: 'absent' };
    const isAnObject = typeof parkedStepOutput === 'object' && !Array.isArray(parkedStepOutput);
    if (!isAnObject) return { kind: 'invalid' };
    const hasNoBudget = !Object.hasOwn(parkedStepOutput as object, 'treeBudget');
    if (hasNoBudget) return { kind: 'absent' };
    const journaled = (parkedStepOutput as { treeBudget?: unknown }).treeBudget;
    const { stepsExecuted, childrenStarted } = (journaled ?? {}) as Partial<TreeBudget>;
    const isWithinTheBounds = isCountWithin(stepsExecuted, MAX_STEP_EXECUTIONS_PER_RUN) && isCountWithin(childrenStarted, MAX_CHILD_RUNS_PER_ROOT);
    return isWithinTheBounds ? { kind: 'valid', tree: { stepsExecuted, childrenStarted } } : { kind: 'invalid' };
  }

  /** Why the repository did not record an answer: the wait ended at this instant (the run is ended as such), or another answer was recorded first. */
  private refusalOfAnAnswerNotRecorded({ runId, seq }: { runId: string; seq: number }): OpenFleetError {
    this.expireOverdueManualWaits();
    const isExpired = this.deps.manual.get(runId, seq)?.status === 'expired';
    return isExpired ? manualWaitExpired() : manualAlreadyAnswered();
  }

  private assertStillOpenForAnswer(status: 'pending' | 'answered' | 'expired' | 'cancelled'): void {
    if (status === 'expired') throw manualWaitExpired();
    const isClosed = status !== 'pending';
    if (isClosed) throw manualAlreadyAnswered();
  }

  /**
   * The playbook must still be the content a human approved and the run started from: the digest of the content and the sha256 of every pinned script, the policy included (its allowed hosts), and the revision and flow of the run.
   * A playbook that changed, or lost its approval, while the run waited closes the question and puts the run in review: it is never continued.
   */
  private assertStillTheApprovedRun({ run, playbook, seq }: { run: PlaybookRunRecord; playbook: PlaybookRecord; seq: number }): Record<string, string> {
    const cancelThenThrow = (error: OpenFleetError): never => {
      const wasClosed = this.deps.manual.cancel({ runId: run.id, seq, errorCode: PLAYBOOK_CHANGED_WHILE_WAITING, at: this.deps.clock() });
      if (!wasClosed) throw this.refusalOfAnAnswerNotRecorded({ runId: run.id, seq });
      this.deps.observer?.runEnded({ runId: run.id, playbookId: run.playbookId, status: 'needs_review' });
      throw error;
    };
    let pinnedScripts: Record<string, string>;
    try {
      pinnedScripts = this.deps.approvals.assertStillApproved(playbook);
    } catch (error) {
      if (error instanceof OpenFleetError) return cancelThenThrow(error);
      throw error;
    }
    const isTheFlowThatWasRun = playbook.contentRev === run.playbookRev && canonicalDigestOf(playbook.flow) === run.flowSha256;
    if (!isTheFlowThatWasRun) return cancelThenThrow(playbookMovedWhileWaiting());
    return pinnedScripts;
  }

  /** Walks on from the resume point, prepared before the answer: the context is the journal read back with the secrets resolved again. Nothing here reads the journal, so nothing here can fail after the run was set running. */
  private continueAfterManualApproval({ run, playbook, pinnedScripts, secretValues, secretsToMask, masker, resumePoint, tree }: { run: PlaybookRunRecord; playbook: PlaybookRecord; pinnedScripts: Record<string, string>; secretValues: Map<string, string>; secretsToMask: SecretToMask[]; masker: SecretMasker; resumePoint: ResumePoint; tree: TreeBudget }): void {
    const liveTree = this.newLiveTree();
    liveTree.runIds.add(run.id);
    this.liveTrees.set(run.id, liveTree);
    const context: RunContext = { run, playbook, pinnedScripts, inputs: run.inputs, secretValues, masker, lineage: [playbook.id], secretsToMask, tree, liveTree };
    this.executeInBackground(context, resumePoint);
  }

  private async runScriptCell(cell: ScriptCell, context: RunContext, steps: StepFields, iteration?: Iteration): Promise<{ verdict: Verdict; output?: unknown }> {
    const { approvals } = this.deps;
    const { args, env } = this.resolvedTemplatesOf(cell, context, steps, iteration);
    const script = approvals.locatePinned(cell.program, context.pinnedScripts);

    const outcome = await runScriptStep({
      path: script.path, args, env, workingDirectory: dirname(script.path), signal: context.liveTree.signal,
      timeoutMs: (cell.timeoutSeconds ?? DEFAULT_STEP_TIMEOUT_SECONDS) * 1000,
      maxRetainedChars: MAX_STEP_OUTPUT_BYTES + context.masker.longestSpellingLength,
    });

    // The shape-based layer runs before the masker: it would read the marker `[secret:NAME]` as a secret-named key and hide the name.
    // The control characters go last: a secret that holds one must reach the masker as printed.
    const output = withoutControlCharacters(context.masker.mask(maskedSecrets(outcome.output)));
    if (outcome.kind === 'aborted') return { verdict: this.interruptionOf(context), output: { output } };
    if (outcome.kind === 'spawn_failed') return { verdict: { status: 'failed', errorCode: 'script_spawn_failed' } };
    if (outcome.kind === 'timeout') return { verdict: { status: 'failed', errorCode: 'script_timeout' }, output: { output } };
    const stepOutput: StepOutput = { exitCode: outcome.exitCode, output };
    return outcome.exitCode === 0 ? { verdict: { status: 'succeeded' }, output: stepOutput } : { verdict: { status: 'failed', errorCode: 'script_failed' }, output: stepOutput };
  }

  private async runHttpCell(cell: HttpCell, context: RunContext, steps: StepFields, iteration?: Iteration): Promise<{ verdict: Verdict; output?: unknown }> {
    const { scope, untrusted } = this.templateWorldOf(context, steps, iteration);
    const { url, headers, body } = resolveHttpRequest(cell, scope, untrusted);

    const outcome = await sendHttpStep({
      url, method: cell.method, headers, body, allowedHosts: context.playbook.policy.allowedHosts ?? [], signal: context.liveTree.signal,
      timeoutMs: (cell.timeoutSeconds ?? DEFAULT_STEP_TIMEOUT_SECONDS) * 1000,
      maxRetainedChars: MAX_STEP_OUTPUT_BYTES + context.masker.longestSpellingLength,
    }, this.deps.httpNetwork);

    if (outcome.kind === 'aborted') return { verdict: this.interruptionOf(context) };
    if (outcome.kind !== 'response') return { verdict: { status: 'failed', errorCode: HTTP_REFUSAL_CODES[outcome.kind] } };

    // Same order as a script's output: the shape-based layer, then the masker, then the control characters.
    const output = withoutControlCharacters(context.masker.mask(maskedSecrets(outcome.body)));
    const stepOutput: StepOutput = { status: outcome.status, output };
    const isSuccess = outcome.status >= 200 && outcome.status < 300;
    return isSuccess ? { verdict: { status: 'succeeded' }, output: stepOutput } : { verdict: { status: 'failed', errorCode: 'http_status_failed' }, output: stepOutput };
  }

  private runReadFromStoreCell(cell: ReadFromStoreCell, context: RunContext, steps: StepFields, iteration?: Iteration): { verdict: Verdict; output?: unknown } {
    const { scope, untrusted } = this.templateWorldOf(context, steps, iteration);
    const request = resolveStoreRead(cell, scope, untrusted);
    const outcome = readStoreRows({ stores: this.deps.stores, projectId: context.playbook.projectId, request });
    // Same order as a script's output: the shape-based layer, then the masker, then the control characters.
    return this.verdictOfStoreStep(outcome, (output) => ({ ...output, output: withoutControlCharacters(context.masker.mask(maskedSecrets(String(output['output'])))) }));
  }

  private runWriteToStoreCell(cell: WriteToStoreCell, context: RunContext, steps: StepFields, iteration?: Iteration): { verdict: Verdict; output?: unknown } {
    const { scope, untrusted } = this.templateWorldOf(context, steps, iteration);
    const request = resolveStoreWrite(cell, scope, untrusted);
    const outcome = writeStoreRow({ stores: this.deps.stores, projectId: context.playbook.projectId, runId: context.run.id, request, mask: (value) => context.masker.mask(value) });
    return this.verdictOfStoreStep(outcome, (output) => output);
  }

  private verdictOfStoreStep(outcome: StoreOutcome, maskedOutputOf: (output: Record<string, unknown>) => Record<string, unknown>): { verdict: Verdict; output?: unknown } {
    if (outcome.kind === 'failed') return { verdict: { status: 'failed', errorCode: outcome.code } };
    return { verdict: { status: 'succeeded' }, output: maskedOutputOf(outcome.output) };
  }

  private templateWorldOf(context: RunContext, steps: StepFields, iteration?: Iteration): { scope: ResolutionScope; untrusted: UntrustedSources } {
    return {
      untrusted: { stepIds: new Set(context.playbook.flow.cells.map((other) => other.id)), isItemUntrusted: iteration?.isItemUntrusted ?? true, areInputsUntrusted: hasUntrustedInputs(context.run) },
      scope: { inputs: context.inputs, steps, item: iteration?.item, index: iteration?.index, secretValueOf: (name) => context.secretValues.get(name) },
    };
  }

  /** The arguments and environment of a script cell with their tokens resolved. A token is checked in its place again here: a flow stored outside the save path is held to the same rules. */
  private resolvedTemplatesOf(cell: ScriptCell, context: RunContext, steps: StepFields, iteration?: Iteration): { args: string[]; env: Record<string, string> } {
    const { scope, untrusted } = this.templateWorldOf(context, steps, iteration);
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
