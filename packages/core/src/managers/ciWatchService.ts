import { OpenFleetError } from '@openfleet/shared';
import type { CheckOutcome, GhPullRequestPort, PullRequestSnapshot } from '../github/ghPullRequestPort.js';
import { pullRequestUrlOf, requirePullRequestRef, type PullRequestRef } from '../github/pullRequestRef.js';
import { log } from '../logger.js';
import type { ScheduledEventService } from './scheduledEventService.js';
import type { WatchedPr, WatchedPrRepository } from './watchedPrRepository.js';

export const MAX_WATCHED_PRS_PER_MANAGER = 5;
export const CI_POLL_INTERVAL_MS = 60_000;
export const CI_MAX_BACKOFF_MS = 5 * 60_000;
export const CI_EVENT_TITLE = 'ci.finished';
// The scheduled events refuse a due time that is not in the future: one millisecond is the closest.
const DELIVER_IMMEDIATELY_IN_MINUTES = 1 / 60_000;
// A pull request has no check for a moment after a push: an empty answer counts only when the next poll repeats it.
const EMPTY_ANSWER_CONFIRMATIONS = 2;
const GH_WIDE_FAILURE_CODES = new Set(['gh_unavailable', 'gh_not_authenticated']);

export type CiStatus = 'success' | 'failure' | 'skipped';

/** The overall status once every check is done; undefined while one is still running. */
export const ciStatusOf = (outcomes: CheckOutcome[]): CiStatus | undefined => {
  if (outcomes.includes('pending')) return undefined;
  if (outcomes.length === 0) return 'skipped';
  return outcomes.includes('failure') ? 'failure' : 'success';
};

/** The only text a manager receives about a finished CI run: a status, the pull request address and a sha. */
export const ciFinishedMessageOf = ({ status, pullRequest, sha }: { status: CiStatus; pullRequest: PullRequestRef; sha: string }): string =>
  `${CI_EVENT_TITLE} status=${status} pr=${pullRequestUrlOf(pullRequest)} sha=${sha}`;

const logPassFailure = (error: unknown): void => log('error', 'a CI watch pass failed; the next pass retries', error);

export interface CiWatchServiceDeps {
  repository: WatchedPrRepository;
  gh: GhPullRequestPort;
  scheduledEvents: Pick<ScheduledEventService, 'schedule'>;
  now?: () => number;
}

export class CiWatchService {
  private readonly now: () => number;
  private readonly retryAtOf = new Map<string, number>();
  private readonly failuresOf = new Map<string, number>();
  private readonly emptyAnswersOf = new Map<string, { sha: string; count: number }>();
  private passInProgress: Promise<void> | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private isStopped = false;

  constructor(private readonly deps: CiWatchServiceDeps) {
    this.now = deps.now ?? Date.now;
  }

  start(): void {
    this.isStopped = false;
    this.armNextPass();
  }

  /** Resolves once the poll in flight has finished, so nothing is written after the returned promise settles. */
  async stop(): Promise<void> {
    this.isStopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    await this.passInProgress?.catch(() => undefined);
  }

  watch({ managerId, ...input }: PullRequestRef & { managerId: string }): WatchedPr {
    const pullRequest = requirePullRequestRef(input);
    const watchedByManager = this.deps.repository.activeOf(managerId);
    const isAlreadyWatched = this.watchedBy(managerId, pullRequest) !== undefined;
    const hasRoom = watchedByManager.length < MAX_WATCHED_PRS_PER_MANAGER;
    if (!isAlreadyWatched && !hasRoom) throw new OpenFleetError('too_many_watched_prs', `you already watch ${MAX_WATCHED_PRS_PER_MANAGER} pull requests.`, { hint: 'unwatch one with unwatch_pr, or wait for one to merge.' });
    return this.deps.repository.watch({ managerId, ...pullRequest });
  }

  /** True when the manager was watching the pull request. */
  unwatch({ managerId, ...input }: PullRequestRef & { managerId: string }): boolean {
    const pullRequest = requirePullRequestRef(input);
    const unwatched = this.watchedBy(managerId, pullRequest);
    const wasWatching = this.deps.repository.unwatch({ managerId, ...pullRequest });
    if (unwatched) this.forget(unwatched.id);
    return wasWatching;
  }

  private watchedBy(managerId: string, { repo, number }: PullRequestRef): WatchedPr | undefined {
    return this.deps.repository.activeOf(managerId).find((watched) => watched.repo === repo && watched.number === number);
  }

  private forget(id: string): void {
    this.retryAtOf.delete(id);
    this.failuresOf.delete(id);
    this.emptyAnswersOf.delete(id);
  }

  activeOf(managerId: string): WatchedPr[] {
    return this.deps.repository.activeOf(managerId);
  }

  /** Polls every watched pull request that is not backing off; a pass already running is joined, never doubled. */
  pollOnce(): Promise<void> {
    this.passInProgress ??= this.pollDuePullRequests().finally(() => { this.passInProgress = undefined; });
    return this.passInProgress;
  }

  private armNextPass(): void {
    if (this.isStopped) return;
    this.timer = setTimeout(() => void this.pollOnce().catch(logPassFailure).finally(() => this.armNextPass()), CI_POLL_INTERVAL_MS);
  }

  private async pollDuePullRequests(): Promise<void> {
    const now = this.now();
    const duePullRequests = this.deps.repository.allActive().filter((watched) => (this.retryAtOf.get(watched.id) ?? 0) <= now);
    for (const watched of duePullRequests) {
      if (this.isStopped) return;
      const canPollTheNext = await this.pollOne(watched);
      if (!canPollTheNext) return;
    }
  }

  /** False when gh itself cannot answer for any pull request, so the rest of the pass is skipped. */
  private async pollOne(watched: WatchedPr): Promise<boolean> {
    let snapshot: PullRequestSnapshot;
    try {
      snapshot = await this.deps.gh.snapshotOf(watched);
    } catch (error) {
      return this.noteFailure(watched, error);
    }
    this.failuresOf.delete(watched.id);
    this.retryAtOf.delete(watched.id);
    if (watched.lastErrorCode !== undefined) this.deps.repository.recordError(watched.id, undefined);
    this.handle(watched, snapshot);
    return true;
  }

  private handle(watched: WatchedPr, snapshot: PullRequestSnapshot): void {
    if (snapshot.state !== 'OPEN') return this.stopWatching(watched);
    const status = ciStatusOf(snapshot.checkOutcomes);
    const isFinished = status !== undefined;
    const isAlreadyNotified = snapshot.headSha === watched.lastNotifiedSha;
    if (!isFinished || isAlreadyNotified) return void this.emptyAnswersOf.delete(watched.id);
    if (status === 'skipped' && !this.isEmptyAnswerConfirmed(watched, snapshot.headSha)) return;
    this.tellManager(watched, { status, sha: snapshot.headSha });
  }

  private isEmptyAnswerConfirmed(watched: WatchedPr, sha: string): boolean {
    const previous = this.emptyAnswersOf.get(watched.id);
    const count = previous?.sha === sha ? previous.count + 1 : 1;
    this.emptyAnswersOf.set(watched.id, { sha, count });
    return count >= EMPTY_ANSWER_CONFIRMATIONS;
  }

  // The event is scheduled before the sha is recorded: a crash between the two repeats an event, it never loses one.
  private tellManager(watched: WatchedPr, { status, sha }: { status: CiStatus; sha: string }): void {
    try {
      this.deps.scheduledEvents.schedule({
        managerId: watched.managerId,
        creator: 'manager',
        title: CI_EVENT_TITLE,
        message: ciFinishedMessageOf({ status, pullRequest: watched, sha }),
        inMinutes: DELIVER_IMMEDIATELY_IN_MINUTES,
      });
    } catch (error) {
      const code = error instanceof OpenFleetError ? error.code : undefined;
      log('error', `ci.finished for ${watched.repo}#${watched.number} could not be scheduled for manager ${watched.managerId}; the next poll retries`, error);
      if (code !== undefined) this.deps.repository.recordError(watched.id, code);
      return;
    }
    this.deps.repository.recordNotified(watched.id, sha);
    this.emptyAnswersOf.delete(watched.id);
  }

  private stopWatching(watched: WatchedPr): void {
    this.deps.repository.close(watched.id);
    this.forget(watched.id);
  }

  /** Records the typed failure on the row and backs off; false when gh cannot answer for any pull request. */
  private noteFailure(watched: WatchedPr, error: unknown): boolean {
    const code = error instanceof OpenFleetError ? error.code : undefined;
    if (code !== undefined && watched.lastErrorCode !== code) log('warn', `gh failed for ${watched.repo}#${watched.number}: ${code}`);
    if (code === undefined) log('error', `unexpected failure while polling ${watched.repo}#${watched.number}`, error);
    if (code !== undefined) this.deps.repository.recordError(watched.id, code);
    const isGhWide = code !== undefined && GH_WIDE_FAILURE_CODES.has(code);
    const backingOff = isGhWide ? this.deps.repository.allActive() : [watched];
    for (const pullRequest of backingOff) this.backOff(pullRequest.id);
    return !isGhWide;
  }

  private backOff(id: string): void {
    const failures = (this.failuresOf.get(id) ?? 0) + 1;
    this.failuresOf.set(id, failures);
    const delayMs = Math.min(CI_POLL_INTERVAL_MS * 2 ** (failures - 1), CI_MAX_BACKOFF_MS);
    this.retryAtOf.set(id, this.now() + delayMs);
  }
}
