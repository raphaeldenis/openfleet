import type { ServerEvent, SilentBlock } from '@openfleet/shared';

const MINUTE_MS = 60_000;

type CancelTimer = () => void;

export interface SilentBlockDetectorDeps {
  thresholdMinutes: number;
  schedule: (callback: () => void, delayMs: number) => CancelTimer;
  /** Receives the full list of silent blocks every time it changes. */
  onChange: (blocks: SilentBlock[]) => void;
}

interface WatchedPrompt {
  waitingSince: string;
  cancelTimer: CancelTimer;
  isRaised: boolean;
}

const endsSessionPrompts = (event: ServerEvent): event is Extract<ServerEvent, { type: 'session.closed' | 'session.reopened' | 'session.relaunching' }> =>
  event.type === 'session.closed' || event.type === 'session.reopened' || event.type === 'session.relaunching';

/**
 * Raises one silent block per session prompt that stays undecided past the threshold, and lowers it when the
 * session leaves the prompt, closes, reopens or relaunches. State lives in memory: a prompt does not survive
 * a daemon restart, so there is nothing to restore.
 */
export class SilentBlockDetector {
  private readonly watchedBySessionId = new Map<string, WatchedPrompt>();

  constructor(private readonly deps: SilentBlockDetectorDeps) {}

  handle(event: ServerEvent): void {
    if (event.type === 'session.state') return this.handleState(event);
    if (endsSessionPrompts(event)) this.stopWatching(event.sessionId);
  }

  list(): SilentBlock[] {
    const raised = [...this.watchedBySessionId].filter(([, watched]) => watched.isRaised);
    return raised.map(([sessionId, { waitingSince }]) => ({ sessionId, waitingSince }));
  }

  stop(): void {
    for (const sessionId of [...this.watchedBySessionId.keys()]) this.stopWatching(sessionId, { announce: false });
  }

  private handleState({ sessionId, state, stateSince }: { sessionId: string; state: string; stateSince: string }): void {
    const isWaitingOnPrompt = state === 'waiting_permission';
    if (!isWaitingOnPrompt) return this.stopWatching(sessionId);
    const isSamePromptAsBefore = this.watchedBySessionId.has(sessionId);
    if (isSamePromptAsBefore) return;
    const thresholdMs = this.deps.thresholdMinutes * MINUTE_MS;
    const cancelTimer = this.deps.schedule(() => this.raise(sessionId), thresholdMs);
    this.watchedBySessionId.set(sessionId, { waitingSince: stateSince, cancelTimer, isRaised: false });
  }

  private raise(sessionId: string): void {
    const watched = this.watchedBySessionId.get(sessionId);
    if (!watched || watched.isRaised) return;
    watched.isRaised = true;
    this.deps.onChange(this.list());
  }

  private stopWatching(sessionId: string, { announce = true } = {}): void {
    const watched = this.watchedBySessionId.get(sessionId);
    if (!watched) return;
    watched.cancelTimer();
    this.watchedBySessionId.delete(sessionId);
    if (watched.isRaised && announce) this.deps.onChange(this.list());
  }
}
