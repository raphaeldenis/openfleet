import type { EventBus } from '../events/eventBus.js';
import type { SessionService } from '../sessions/sessionService.js';
import type { RuntimeProgress } from '../sessions/sessionRuntime.js';
import type { RuntimeAttention, ServerEvent } from '@openfleet/shared';
import type { PowerApi, PowerAssertion } from './powerApi.js';

interface SleepGuardDeps {
  sessions: SessionService;
  bus: EventBus;
  power: PowerApi;
  enabled: boolean;
  clock: () => number;
  schedule: (callback: () => void, delayMs: number) => () => void;
  onPowerUnavailable: () => void;
  onPowerAvailable?: () => void;
}

const POLL_MS = 5000;
const RESUME_DRIFT_MS = 30_000;
const POST_RESUME_WINDOW_MS = 120_000;
const MAX_POWER_ATTEMPTS = 3;

interface ResumeWatch {
  baseline: RuntimeProgress;
  remainingMs: number;
}

export class SleepGuard {
  private assertion: PowerAssertion | undefined;
  private unsubscribe: (() => void) | undefined;
  private cancelPoll: (() => void) | undefined;
  private lastPollAt = 0;
  private readonly watches = new Map<string, ResumeWatch>();
  private powerAttempts = 0;

  constructor(private readonly deps: SleepGuardDeps) {}

  observeSessionEvents(): void {
    if (this.unsubscribe) return;
    this.unsubscribe = this.deps.bus.subscribe((event) => this.handleEvent(event));
  }

  start(): void {
    if (this.cancelPoll) return;
    this.observeSessionEvents();
    this.reconcilePower();
    this.lastPollAt = this.deps.clock();
    this.armPoll();
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.cancelPoll?.();
    this.cancelPoll = undefined;
    this.watches.clear();
    this.releasePower();
  }

  private armPoll(): void {
    this.cancelPoll = this.deps.schedule(() => {
      this.poll();
      if (this.unsubscribe) this.armPoll();
    }, POLL_MS);
  }

  private handleEvent(event: ServerEvent): void {
    if (event.type === 'session.attention' || event.type === 'session.output') return;
    if (event.type === 'session.closed') this.handleClose(event);
    const isSessionReset = event.type === 'session.relaunching' || event.type === 'session.reopened';
    const leavesGenerating = event.type === 'session.state' && event.state !== 'generating';
    if (isSessionReset || leavesGenerating) this.finishWatch(event.sessionId);
    this.reconcilePower();
  }

  private handleClose(event: Extract<ServerEvent, { type: 'session.closed' }>): void {
    const watch = this.watches.get(event.sessionId);
    const exitsDuringResumeCheck = watch !== undefined && event.reason === 'harness_exit';
    if (!exitsDuringResumeCheck) return this.finishWatch(event.sessionId);
    this.raiseAttention(event.sessionId, watch.baseline.launchId, 'post_wake_process_exited');
    this.watches.delete(event.sessionId);
  }

  private poll(): void {
    const now = this.deps.clock();
    const elapsedMs = now - this.lastPollAt;
    this.lastPollAt = now;
    const isPossibleResume = elapsedMs > RESUME_DRIFT_MS;
    const clockMovesBackward = elapsedMs < 0;
    const activeElapsedMs = clockMovesBackward ? 0 : elapsedMs;
    if (isPossibleResume) this.beginResumeChecks();
    else this.checkProgress(activeElapsedMs);
    this.reconcilePower();
  }

  private beginResumeChecks(): void {
    this.checkProgress(0);
    this.watches.clear();
    for (const session of this.deps.sessions.list()) {
      if (session.state !== 'generating') continue;
      const baseline = this.deps.sessions.runtimeProgressOf(session.id);
      if (baseline) this.watches.set(session.id, { baseline, remainingMs: POST_RESUME_WINDOW_MS });
    }
  }

  private checkProgress(elapsedMs: number): void {
    for (const [sessionId, watch] of this.watches) this.checkSession(sessionId, watch, elapsedMs);
  }

  private checkSession(sessionId: string, watch: ResumeWatch, elapsedMs: number): void {
    const session = this.deps.sessions.get(sessionId);
    const progress = this.deps.sessions.runtimeProgressOf(sessionId);
    const isCurrentGeneratingLaunch = session?.state === 'generating' && progress?.launchId === watch.baseline.launchId;
    if (!isCurrentGeneratingLaunch || !progress) return this.finishWatch(sessionId);
    if (progress.processState === 'exited') return this.raiseAttention(sessionId, progress.launchId, 'post_wake_process_exited');
    const previousCursor = watch.baseline.transcriptCursor;
    const currentCursor = progress.transcriptCursor;
    const hasTranscriptProgress = previousCursor !== undefined && currentCursor !== undefined
      && currentCursor.identity === previousCursor.identity && currentCursor.offset > previousCursor.offset;
    const hasStrongProgress = progress.hookSequence > watch.baseline.hookSequence || hasTranscriptProgress;
    if (hasStrongProgress) return this.finishWatch(sessionId);
    watch.baseline = progress;
    watch.remainingMs -= elapsedMs;
    if (watch.remainingMs > 0) return;
    const reason = progress.processState === 'unknown' ? 'post_wake_health_unknown' : 'post_wake_no_progress';
    this.raiseAttention(sessionId, progress.launchId, reason);
  }

  private raiseAttention(sessionId: string, launchId: string, reason: RuntimeAttention['reason']): void {
    this.deps.sessions.setRuntimeAttention(sessionId, { launchId, reason, wakeSource: 'resume_suspected', detectedAt: new Date(this.deps.clock()).toISOString() });
  }

  private finishWatch(sessionId: string): void {
    this.watches.delete(sessionId);
    this.deps.sessions.setRuntimeAttention(sessionId, undefined);
  }

  private reconcilePower(): void {
    const hasGeneratingSession = this.deps.sessions.list().some((session) => session.state === 'generating' && this.deps.sessions.hasLiveLaunch(session.id));
    const needsAssertion = this.deps.enabled && hasGeneratingSession;
    if (!needsAssertion) {
      this.powerAttempts = 0;
      return this.releasePower();
    }
    const assertionEndsUnexpectedly = this.assertion?.isActive?.() === false;
    if (assertionEndsUnexpectedly) {
      this.releasePower();
      this.deps.onPowerUnavailable();
    }
    if (this.assertion) return;
    if (this.powerAttempts >= MAX_POWER_ATTEMPTS) return;
    this.powerAttempts += 1;
    try {
      this.assertion = this.deps.power.acquire();
      this.deps.onPowerAvailable?.();
    } catch {
      this.deps.onPowerUnavailable();
    }
  }

  private releasePower(): void {
    const assertion = this.assertion;
    this.assertion = undefined;
    try { assertion?.release(); } catch { this.deps.onPowerUnavailable(); }
  }
}
