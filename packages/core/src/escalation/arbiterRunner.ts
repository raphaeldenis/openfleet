import { ARBITER_ROLE } from '@openfleet/shared';
import { resolveModel, type ModelTable } from '../models.js';
import type { EventBus } from '../events/eventBus.js';
import { log } from '../logger.js';
import { modeOf, type ManagerRecord } from '../managers/managerRepository.js';
import type { ManagerService } from '../managers/managerService.js';
import type { ProjectRepository } from '../projects/projectRepository.js';
import { DEFAULT_TICKET_PATTERN, ticketOfBranch } from '../review/worktreeGit.js';
import type { SessionService } from '../sessions/sessionService.js';
import { arbiterPromptOf, type EarlierDecision } from './arbiterBrief.js';
import type { ArbiterWorkspaces } from './arbiterWorkspaces.js';
import { ARBITER_QUOTA_REASON, ARBITER_UNAVAILABLE_REASON, type EscalatedToHuman, type EscalationService } from './escalationService.js';
import type { EscalationRepository, StoredQuestion } from './escalationRepository.js';
import { escalationPolicyOf } from './projectPolicy.js';

const MINUTE_MS = 60_000;
/** A sleeping manager does not pulse: its arbiter waits a fixed time. */
const SLEEPING_MANAGER_EXPIRY_MS = 30 * MINUTE_MS;
const MIN_EXPIRY_MS = 10 * MINUTE_MS;
const PULSES_BEFORE_EXPIRY = 2;
const MS_PER_SECOND = 1000;
/** After this many refused opinions in a row the arbiter is given up on. */
const MAX_REFUSED_OPINIONS = 3;
/** The first failure of a batch is retried once; the second one fails closed. */
const FAILURES_BEFORE_FAIL_CLOSED = 2;
const ARBITER_EMOJI = '⚖️';
const MAX_CLOSE_ATTEMPTS = 3;
const CLOSE_RETRY_DELAY_MS = 30_000;

const BATCH_TAG_LENGTH = 8;
/** The end of an arbiter's name that tells which batch it answers for, so a resumed arbiter is matched to its batch. */
const batchTagOf = (batchId: string) => `[${batchId.slice(0, BATCH_TAG_LENGTH)}]`;

export type LaunchOutcome =
  | { status: 'idle' }
  | { status: 'running' }
  | { status: 'escalated'; reason: string; escalated?: EscalatedToHuman };

interface Run {
  batchId: string;
  managerId: string;
  cancelExpiry: () => void;
  refusedOpinions: number;
}

export interface ArbiterRunnerDeps {
  sessions: Pick<SessionService, 'create' | 'get' | 'list' | 'close'>;
  bus: Pick<EventBus, 'subscribe'>;
  managers: Pick<ManagerService, 'get'>;
  projects: Pick<ProjectRepository, 'get'>;
  repository: Pick<EscalationRepository, 'findBatch' | 'questionsOfBatch' | 'decisionsOfBatch' | 'addArbiterRun' | 'arbiterRunsOfTicket' | 'batchIdsWithOpenArbiterQuestions'>;
  escalations: Pick<EscalationService, 'escalateBatchToHuman'>;
  modelTable: ModelTable;
  /** Where each arbiter starts: an empty directory of its own, away from any repository. */
  workspaces: ArbiterWorkspaces;
  /** The real path of a directory, symlinks resolved; throws when it does not exist. */
  realPathOf: (path: string) => string;
  /** Arms a timer and answers the function that cancels it. */
  schedule: (callback: () => void, delayMs: number) => () => void;
  ticketPattern?: string;
}

/** How long a manager waits for its arbiter: two pulses when it watches, a fixed half hour when it sleeps, never under ten minutes. */
export const expiryMsOf = (manager: Pick<ManagerRecord, 'mode' | 'pulseEnabled' | 'pulseSeconds'>): number => {
  const isSleeping = modeOf(manager) === 'sleeping';
  return isSleeping ? SLEEPING_MANAGER_EXPIRY_MS : Math.max(MIN_EXPIRY_MS, PULSES_BEFORE_EXPIRY * manager.pulseSeconds * MS_PER_SECOND);
};

/**
 * Spawns the arbiter of a batch, one per batch, on the model the project forces, and gives up on it when it closes, expires or keeps sending refused opinions:
 * the batch is retried once, then handed to the human. The manager never decides in its place.
 */
export class ArbiterRunner {
  private readonly runBySessionId = new Map<string, Run>();
  private readonly failuresByBatchId = new Map<string, number>();
  private readonly workspaceBySessionId = new Map<string, string>();
  private readonly cancelCloseRetries = new Set<() => void>();
  private isStopped = false;

  constructor(private readonly deps: ArbiterRunnerDeps) {
    deps.bus.subscribe((event) => { if (event.type === 'session.closed') this.onSessionClosed({ sessionId: event.sessionId, isDaemonShutdown: event.reason === 'daemon_shutdown' }); });
  }

  /** Cancels the expiry and close-retry timers and schedules no other: the daemon is shutting down. */
  stop(): void {
    this.isStopped = true;
    for (const cancelRetry of this.cancelCloseRetries) cancelRetry();
    this.cancelCloseRetries.clear();
    for (const run of this.runBySessionId.values()) run.cancelExpiry();
    this.runBySessionId.clear();
  }

  /** The batch an arbiter session answers for, when the daemon runs it. */
  batchOf(arbiterSessionId: string): string | undefined {
    return this.runBySessionId.get(arbiterSessionId)?.batchId;
  }

  /** Starts the arbiter of a batch, or hands the batch to the human when the runs of the ticket are used up or the arbiter cannot start twice. */
  async launch(batchId: string): Promise<LaunchOutcome> {
    if (this.isStopped) return { status: 'idle' };
    const { repository } = this.deps;
    const batch = repository.findBatch(batchId);
    if (batch === undefined) return { status: 'idle' };
    const waitingQuestions = repository.questionsOfBatch(batchId).filter((question) => question.route === 'arbiter' && question.status === 'open');
    const hasNothingToArbitrate = waitingQuestions.length === 0;
    if (hasNothingToArbitrate) return { status: 'idle' };

    const policy = escalationPolicyOf(this.deps.projects, this.deps.sessions.get(batch.managerId)?.projectId);
    const runsOfTicket = repository.arbiterRunsOfTicket({ managerId: batch.managerId, ticket: batch.ticket });
    const isQuotaUsedUp = runsOfTicket >= policy.maxArbiterRunsPerTicket;
    if (isQuotaUsedUp) return this.failClosed(batchId, ARBITER_QUOTA_REASON);

    repository.addArbiterRun(batchId);
    try {
      await this.spawnFor({ batchId, model: resolveModel(this.deps.modelTable, policy.arbiterModel) });
      return { status: 'running' };
    } catch (error) {
      log('warn', `arbiter: the arbiter of batch ${batchId} could not start`, error);
      return this.onArbiterLost(batchId);
    }
  }

  /** The opinion of the arbiter is recorded: its timer is cancelled and the daemon closes it. */
  settle(arbiterSessionId: string): void {
    const run = this.forget(arbiterSessionId);
    if (run === undefined) return;
    this.failuresByBatchId.delete(run.batchId);
    void this.closeQuietly(arbiterSessionId);
  }

  /** Counts a refused opinion; the arbiter that keeps sending them is closed and replaced, then given up on. */
  noteRefusedOpinion(arbiterSessionId: string): void {
    const run = this.runBySessionId.get(arbiterSessionId);
    if (run === undefined) return;
    run.refusedOpinions += 1;
    const isGivenUpOn = run.refusedOpinions >= MAX_REFUSED_OPINIONS;
    if (isGivenUpOn) void this.retire(arbiterSessionId);
  }

  private async spawnFor({ batchId, model }: { batchId: string; model: string }): Promise<void> {
    const { repository, sessions, managers } = this.deps;
    const batch = repository.findBatch(batchId)!;
    const manager = managers.get(batch.managerId);
    const managerSession = sessions.get(batch.managerId);
    if (manager === undefined || managerSession === undefined) throw new Error(`manager ${batch.managerId} is gone`);

    const waitingQuestions = repository.questionsOfBatch(batchId).filter((question) => question.route === 'arbiter' && question.status === 'open');
    const directoryToRead = this.deps.realPathOf(this.directoryOf({ managerId: batch.managerId, managerDirectory: managerSession.directory, ticket: batch.ticket }));
    const workspace = this.deps.workspaces.create();
    let arbiter: Awaited<ReturnType<typeof sessions.create>>;
    try {
      arbiter = await sessions.create({
        directory: workspace, readDirectories: [directoryToRead],
        name: `Arbiter ${batch.ticket} ${batchTagOf(batchId)}`, emoji: ARBITER_EMOJI, model, role: ARBITER_ROLE, parentId: batch.managerId,
        harness: managerSession.harness, permissionMode: 'plan', ...(managerSession.projectId && { projectId: managerSession.projectId }),
        seededPrompt: arbiterPromptOf({ batch, questions: waitingQuestions, earlierDecisions: this.earlierDecisionsOf(waitingQuestions) }),
      });
    } catch (error) {
      this.deps.workspaces.remove(workspace);
      throw error;
    }
    this.workspaceBySessionId.set(arbiter.id, workspace);
    if (this.isStopped) return void this.closeQuietly(arbiter.id);
    const hasClosedWhileStarting = sessions.get(arbiter.id)?.state === 'closed';
    if (hasClosedWhileStarting) {
      this.removeWorkspaceOf(arbiter.id);
      throw new Error(`arbiter ${arbiter.id} closed while it was starting`);
    }
    this.track({ arbiterSessionId: arbiter.id, batchId, manager });
  }

  /** The latest arbiter decision on each question that the given reopening questions contest, keyed by the id of the reopening question. */
  private earlierDecisionsOf(questions: readonly StoredQuestion[]): Map<string, EarlierDecision> {
    const earlierDecisions = new Map<string, EarlierDecision>();
    for (const { questionId, reopensBatchId, reopensQuestionId } of questions) {
      const isReopening = reopensBatchId !== undefined && reopensQuestionId !== undefined;
      if (!isReopening) continue;
      const earlier = this.deps.repository.decisionsOfBatch(reopensBatchId).filter((decision) => decision.questionId === reopensQuestionId).at(-1);
      if (earlier !== undefined) earlierDecisions.set(questionId, { decision: earlier.decision, rationale: earlier.rationale });
    }
    return earlierDecisions;
  }

  private track({ arbiterSessionId, batchId, manager }: { arbiterSessionId: string; batchId: string; manager: ManagerRecord }): void {
    if (this.isStopped) return;
    const cancelExpiry = this.deps.schedule(() => void this.retire(arbiterSessionId), expiryMsOf(manager));
    this.runBySessionId.set(arbiterSessionId, { batchId, managerId: manager.sessionId, cancelExpiry, refusedOpinions: 0 });
  }

  /**
   * Called once the sessions are resumed after a boot: every batch still waiting for an arbiter either gets its resumed arbiter back under a fresh expiry,
   * or, when no arbiter came back, is treated as a lost arbiter (one new arbiter, then the human).
   */
  recover(): void {
    const { repository, sessions, managers } = this.deps;
    const liveArbitersBeforeRecovery = sessions.list().filter((session) => session.role === ARBITER_ROLE && session.state !== 'closed');
    for (const { id, directory } of liveArbitersBeforeRecovery) this.workspaceBySessionId.set(id, directory);
    this.deps.workspaces.removeAllExcept(new Set(liveArbitersBeforeRecovery.map((session) => session.directory)));
    for (const batchId of repository.batchIdsWithOpenArbiterQuestions()) {
      const batch = repository.findBatch(batchId)!;
      const manager = managers.get(batch.managerId);
      const resumedArbiter = sessions.list().find((session) => session.role === ARBITER_ROLE && session.parentId === batch.managerId && session.state !== 'closed' && session.name.endsWith(batchTagOf(batchId)));
      if (manager !== undefined && resumedArbiter !== undefined) { this.track({ arbiterSessionId: resumedArbiter.id, batchId, manager }); continue; }
      void this.onArbiterLost(batchId).catch((error) => log('error', `arbiter: batch ${batchId} could not be recovered at boot`, error));
    }
    const untrackedArbiters = liveArbitersBeforeRecovery.filter((session) => !this.runBySessionId.has(session.id));
    for (const { id } of untrackedArbiters) void this.closeQuietly(id);
  }

  /** The worktree of the ticket when one of the manager's children works on it, else the directory of the manager. */
  private directoryOf({ managerId, managerDirectory, ticket }: { managerId: string; managerDirectory: string; ticket: string }): string {
    const ticketPattern = this.deps.ticketPattern ?? DEFAULT_TICKET_PATTERN;
    const worktreeOfTicket = this.deps.sessions.list().find((session) => session.parentId === managerId && session.role !== ARBITER_ROLE && ticketOfBranch({ branch: session.branch, ticketPattern }) === ticket);
    return worktreeOfTicket?.directory ?? managerDirectory;
  }

  /** Removes the workspace of a closed arbiter; a daemon shutdown keeps it, since the arbiter is resumed in it at the next boot. */
  private removeWorkspaceOf(arbiterSessionId: string): void {
    const workspace = this.workspaceBySessionId.get(arbiterSessionId);
    if (workspace === undefined) return;
    this.workspaceBySessionId.delete(arbiterSessionId);
    try {
      this.deps.workspaces.remove(workspace);
    } catch (error) {
      log('warn', `arbiter: the workspace of session ${arbiterSessionId} could not be removed`, error);
    }
  }

  private onSessionClosed({ sessionId, isDaemonShutdown }: { sessionId: string; isDaemonShutdown: boolean }): void {
    if (!isDaemonShutdown) this.removeWorkspaceOf(sessionId);
    const run = this.forget(sessionId);
    if (run === undefined || isDaemonShutdown) return;
    void this.onArbiterLost(run.batchId).catch((error) => log('error', `arbiter: batch ${run.batchId} could not be recovered after its arbiter closed`, error));
  }

  /** Closes the arbiter the daemon gives up on and treats the batch as if the arbiter had closed on its own. */
  private async retire(arbiterSessionId: string): Promise<void> {
    const run = this.forget(arbiterSessionId);
    if (run === undefined) return;
    await this.closeQuietly(arbiterSessionId);
    await this.onArbiterLost(run.batchId).catch((error) => log('error', `arbiter: batch ${run.batchId} could not be recovered after its arbiter was retired`, error));
  }

  /** The first loss of a batch starts a new arbiter; the second hands the batch to the human. */
  private async onArbiterLost(batchId: string): Promise<LaunchOutcome> {
    if (this.isStopped) return { status: 'idle' };
    const failures = (this.failuresByBatchId.get(batchId) ?? 0) + 1;
    this.failuresByBatchId.set(batchId, failures);
    const isLastChance = failures >= FAILURES_BEFORE_FAIL_CLOSED;
    return isLastChance ? this.failClosed(batchId, ARBITER_UNAVAILABLE_REASON) : this.launch(batchId);
  }

  private failClosed(batchId: string, reason: string): LaunchOutcome {
    this.failuresByBatchId.delete(batchId);
    const escalated = this.deps.escalations.escalateBatchToHuman({ batchId, reason });
    return { status: 'escalated', reason, ...(escalated && { escalated }) };
  }

  private forget(arbiterSessionId: string): Run | undefined {
    const run = this.runBySessionId.get(arbiterSessionId);
    if (run === undefined) return undefined;
    run.cancelExpiry();
    this.runBySessionId.delete(arbiterSessionId);
    return run;
  }

  /**
   * Closes the session; a close that fails is tried again later, so a live arbiter never outlives its run.
   * Once the runner is stopped no retry is armed: an arbiter whose creation resolves during shutdown and whose single close fails stays live
   * until the next boot, where recover() closes it.
   */
  private async closeQuietly(sessionId: string, attempt = 1): Promise<void> {
    try {
      await this.deps.sessions.close(sessionId);
    } catch (error) {
      log('warn', `arbiter: session ${sessionId} could not be closed (attempt ${attempt})`, error);
      const hasAttemptsLeft = attempt < MAX_CLOSE_ATTEMPTS;
      if (hasAttemptsLeft && !this.isStopped) this.scheduleCloseRetry({ sessionId, attempt: attempt + 1 });
    }
  }

  private scheduleCloseRetry({ sessionId, attempt }: { sessionId: string; attempt: number }): void {
    const cancelRetry = this.deps.schedule(() => {
      this.cancelCloseRetries.delete(cancelRetry);
      void this.closeQuietly(sessionId, attempt);
    }, CLOSE_RETRY_DELAY_MS);
    this.cancelCloseRetries.add(cancelRetry);
  }
}
