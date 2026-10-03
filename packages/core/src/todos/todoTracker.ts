import { CLOSED_SNAPSHOTS_KEPT, EMIT_COALESCE_MS, MAX_FOLD_BYTES, MAX_QUEUED_HOOKS, SEEN_CALLS_KEPT, TODO_CHUNK_BYTES, TODO_GET_WAIT_MS, type SessionTodos, type TodoSummary } from '@openfleet/shared';
import type { EventBus } from '../events/eventBus.js';
import { log } from '../logger.js';
import { confirmSeenCall, createTodoFold, foldHookPayload, foldTranscriptText, markRowsUnverified, snapshotOf, type TodoFold } from './todoFold.js';
import type { TodoHookCall } from './todoHookCall.js';
import { readTranscriptChunk } from './transcriptChunkReader.js';

/** The waits before each fallback read of a todo hook that carried no usable payload: about five times the worst flush lag observed, 4.65 s in all. */
export const FALLBACK_READ_DELAYS_MS = [150, 300, 600, 1200, 2400] as const;
const MAX_FALLBACK_TOOL_USE_IDS = 50;
const MAX_CHUNKS_PER_READ = Math.ceil(MAX_FOLD_BYTES / TODO_CHUNK_BYTES);

type WarnCode = 'todo_fold_failed' | 'todo_read_failed' | 'todo_emit_failed' | 'todo_transcript_unreadable' | 'todo_listener_failed';

export type Schedule = (run: () => void, delayMs: number) => () => void;

export interface TodoSessions {
  get(sessionId: string): { createdAt: string; state?: string } | undefined;
  /** The resolved transcript path of the session's current conversation, or undefined when there is none the daemon trusts. */
  trustedTranscriptFileOf(sessionId: string): string | undefined;
}

export interface TodoTrackerDeps {
  sessions: TodoSessions;
  bus: EventBus;
  schedule?: Schedule;
  now?: () => Date;
  readChunk?: typeof readTranscriptChunk;
  getWaitMs?: number;
}

type Task = { kind: 'hook'; call: TodoHookCall } | { kind: 'read' };
interface Cursor { path: string; inode: number; offset: number }
interface Fallback { toolUseIds: Set<string>; attempt: number; isTimerPending: boolean; snapshotKeyAtStart: string }

interface SessionState {
  sessionId: string;
  fold: TodoFold;
  cursor: Cursor | undefined;
  /** True once a read returned history text and the live calls folded before it were replayed over it. An empty or missing transcript reconciles nothing. */
  hasReconciledTheHistory: boolean;
  /** The newest live calls folded before the history was reconciled: replayed over the history when it arrives. */
  liveCallsAwaitingTheHistory: TodoHookCall[];
  /** The live calls pushed out of that buffer: the list stays stale until the history holds them. */
  evictedLiveCallIds: Set<string>;
  tasks: Task[];
  hasQueuedARead: boolean;
  isRunning: boolean;
  isClosing: boolean;
  isStale: boolean;
  lastEmittedKey: string;
  isEmitPending: boolean;
  fallback: Fallback | undefined;
  warnedReasons: Set<string>;
  idleWaiters: (() => void)[];
  cancelTimers: Set<() => void>;
}

const realSchedule: Schedule = (run, delayMs) => {
  const timer = setTimeout(run, delayMs);
  timer.unref();
  return () => clearTimeout(timer);
};

const nextTurnOfTheEventLoop = () => new Promise<void>((resolve) => setImmediate(resolve));

/** What a client would see change: the snapshot without its display-only timestamp. */
const keyOf = (snapshot: SessionTodos): string => JSON.stringify({ ...snapshot, updatedAt: null });

const errnoOf = (error: unknown): string | undefined => (typeof error === 'object' && error !== null && typeof (error as { code?: unknown }).code === 'string' ? (error as { code: string }).code : undefined);

/**
 * Keeps, per session, the list the CLI's todo tools hold. The hook delivers each completed call; the transcript catches up what the hooks
 * missed (restart, dropped hook, unusable payload). Every entry point only enqueues: folds and reads of one session run in order on its own queue.
 */
export class TodoTracker {
  private readonly states = new Map<string, SessionState>();
  private readonly closedSnapshots = new Map<string, SessionTodos>();
  private readonly listeners = new Set<(todos: SessionTodos) => void>();
  private readonly schedule: Schedule;
  private readonly readChunk: typeof readTranscriptChunk;
  private readonly getWaitMs: number;
  private readonly cancelPending = new Set<() => void>();
  private readonly unsubscribeFromBus: () => void;
  private readGate: Promise<unknown> = Promise.resolve();

  constructor(private readonly deps: TodoTrackerDeps) {
    this.schedule = deps.schedule ?? realSchedule;
    this.readChunk = deps.readChunk ?? readTranscriptChunk;
    this.getWaitMs = deps.getWaitMs ?? TODO_GET_WAIT_MS;
    this.unsubscribeFromBus = deps.bus.subscribe((event) => {
      if (event.type === 'session.closed') this.closeSession(event.sessionId);
      if (event.type === 'session.reopened') this.reopenSession(event.sessionId);
    });
  }

  onUpdate(listener: (todos: SessionTodos) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Queues the fold of one completed todo call, delivered by its PostToolUse hook. Never folds inline. A state that never read its transcript reads it first, so the hook folds after the history. */
  applyHook(sessionId: string, call: TodoHookCall): void {
    const state = this.stateOf(sessionId);
    if (!state.hasQueuedARead) this.enqueueRead(state);
    this.enqueue(state, { kind: 'hook', call });
  }

  /** Queues a read of the whole current transcript (a session that resumed after a restart). */
  repair(sessionId: string): void {
    this.enqueueRead(this.stateOf(sessionId));
  }

  /** Queues a read of what the transcript gained since the last read, for a session that already has a list. */
  catchUp(sessionId: string): void {
    const state = this.states.get(sessionId);
    if (state) this.enqueueRead(state);
  }

  /** A todo hook came without a usable payload: reads the transcript after growing delays, until the call shows up there. */
  readAfterHookWithoutPayload(sessionId: string, toolUseId?: string): void {
    this.startFallback(this.stateOf(sessionId), toolUseId);
  }

  get(sessionId: string): SessionTodos | undefined {
    const state = this.states.get(sessionId);
    return state ? this.snapshotOfState(state) : this.closedSnapshots.get(sessionId);
  }

  /** The list of a session for the REST route: waits for the queue of the session to drain, at most `getWaitMs`, then answers what it has. */
  async read(sessionId: string): Promise<SessionTodos> {
    const isKnown = this.states.has(sessionId) || this.closedSnapshots.has(sessionId);
    const session = this.deps.sessions.get(sessionId);
    const isOpenSession = session !== undefined && session.state !== 'closed';
    if (!isKnown && isOpenSession) this.repair(sessionId);
    const state = this.states.get(sessionId);
    const hasTimedOut = state ? await this.untilIdle(state) : false;
    const snapshot = this.get(sessionId) ?? snapshotOf(createTodoFold(), sessionId);
    return hasTimedOut ? { ...snapshot, stale: true } : snapshot;
  }

  /** One summary per session that has a list, open or closed and still kept. */
  summaries(): TodoSummary[] {
    const snapshots = [...this.states.values()].map((state) => this.snapshotOfState(state));
    return [...snapshots, ...this.closedSnapshots.values()].flatMap(({ sessionId, counts, source, updatedAt }) => (source !== null && updatedAt !== null ? [{ sessionId, counts, updatedAt }] : []));
  }

  stop(): void {
    this.unsubscribeFromBus();
    for (const cancel of this.cancelPending) cancel();
    this.cancelPending.clear();
  }

  private stateOf(sessionId: string): SessionState {
    const known = this.states.get(sessionId);
    if (known) return known;
    const createdAt = this.deps.sessions.get(sessionId)?.createdAt;
    const notBefore = createdAt !== undefined && Number.isFinite(Date.parse(createdAt)) ? new Date(createdAt) : undefined;
    const fold = createTodoFold({ now: this.deps.now, notBefore });
    const state: SessionState = {
      sessionId, fold, cursor: undefined, hasReconciledTheHistory: false, liveCallsAwaitingTheHistory: [], evictedLiveCallIds: new Set(), tasks: [], hasQueuedARead: false, isRunning: false, isClosing: false, isStale: false,
      lastEmittedKey: keyOf(snapshotOf(fold, sessionId)), isEmitPending: false, fallback: undefined, warnedReasons: new Set(), idleWaiters: [], cancelTimers: new Set(),
    };
    this.states.set(sessionId, state);
    return state;
  }

  private snapshotOfState(state: SessionState): SessionTodos {
    const snapshot = snapshotOf(state.fold, state.sessionId);
    const hasUnrecoveredLiveCalls = state.evictedLiveCallIds.size > 0;
    return state.isStale || hasUnrecoveredLiveCalls ? { ...snapshot, stale: true } : snapshot;
  }

  private enqueue(state: SessionState, task: Task): void {
    state.tasks.push(task);
    const hookCount = state.tasks.filter((queued) => queued.kind === 'hook').length;
    if (hookCount > MAX_QUEUED_HOOKS) {
      state.tasks.splice(state.tasks.findIndex((queued) => queued.kind === 'hook'), 1);
      this.enqueueRead(state);
    }
    this.scheduleRun(state);
  }

  private enqueueRead(state: SessionState): void {
    state.hasQueuedARead = true;
    const hasReadQueued = state.tasks.some((queued) => queued.kind === 'read');
    if (!hasReadQueued) this.enqueue(state, { kind: 'read' });
  }

  private scheduleRun(state: SessionState): void {
    if (state.isRunning) return;
    state.isRunning = true;
    setImmediate(() => void this.run(state));
  }

  private async run(state: SessionState): Promise<void> {
    for (let task = state.tasks.shift(); task !== undefined; task = state.tasks.shift()) {
      try {
        if (task.kind === 'hook') this.foldHook(state, task.call);
        else await this.readTranscript(state);
      } catch (error) {
        this.markStale(state, task.kind === 'hook' ? 'todo_fold_failed' : 'todo_read_failed', error);
      }
    }
    state.isRunning = false;
    this.afterRun(state);
  }

  private foldHook(state: SessionState, call: TodoHookCall): void {
    const wasAlreadyFolded = state.fold.seenCalls.has(call.toolUseId);
    if (wasAlreadyFolded) confirmSeenCall(state.fold, call);
    if (!state.hasReconciledTheHistory) this.keepLiveCallUntilTheHistoryIsReconciled(state, call);
    const isApplied = foldHookPayload(state.fold, call);
    const wasRejectedByTheCli = call.response?.success === false;
    if (!isApplied && !wasAlreadyFolded && !wasRejectedByTheCli) this.startFallback(state, call.toolUseId);
  }

  private keepLiveCallUntilTheHistoryIsReconciled(state: SessionState, call: TodoHookCall): void {
    state.liveCallsAwaitingTheHistory.push(call);
    if (state.liveCallsAwaitingTheHistory.length <= MAX_QUEUED_HOOKS) return;
    const evicted = state.liveCallsAwaitingTheHistory.shift();
    if (evicted) this.rememberEvictedLiveCall(state, evicted.toolUseId);
  }

  private rememberEvictedLiveCall(state: SessionState, toolUseId: string): void {
    state.evictedLiveCallIds.add(toolUseId);
    if (state.evictedLiveCallIds.size <= SEEN_CALLS_KEPT) return;
    const oldest = state.evictedLiveCallIds.values().next().value;
    if (oldest !== undefined) state.evictedLiveCallIds.delete(oldest);
  }

  /** The history is the base, the live calls it does not hold replay over it in arrival order, and an evicted live call the history holds is recovered. */
  private reconcileLiveCallsWithTheHistory(state: SessionState): void {
    for (const call of state.liveCallsAwaitingTheHistory) {
      if (state.fold.seenCalls.has(call.toolUseId)) confirmSeenCall(state.fold, call);
      else foldHookPayload(state.fold, call);
    }
    for (const toolUseId of state.evictedLiveCallIds) {
      if (state.fold.seenCalls.has(toolUseId)) state.evictedLiveCallIds.delete(toolUseId);
    }
    state.liveCallsAwaitingTheHistory = [];
    state.hasReconciledTheHistory = true;
  }

  private async readTranscript(state: SessionState): Promise<void> {
    await this.exclusively(async () => {
      const path = this.deps.sessions.trustedTranscriptFileOf(state.sessionId);
      if (path === undefined) return;
      const hasMovedToAnotherFile = state.cursor !== undefined && state.cursor.path !== path;
      const isAwaitingTheHistory = !state.hasReconciledTheHistory;
      const mustRebuildUnderLiveCalls = isAwaitingTheHistory && state.liveCallsAwaitingTheHistory.length > 0;
      let cursor = hasMovedToAnotherFile || mustRebuildUnderLiveCalls ? undefined : state.cursor;
      let target = mustRebuildUnderLiveCalls ? createTodoFold({ now: this.deps.now, notBefore: state.fold.notBefore }) : state.fold;
      let isRebuilding = mustRebuildUnderLiveCalls;
      let hasReadHistoryText = false;
      let sizeAtStart: number | undefined;
      let chunksRead = 0;
      for (;;) {
        const read = this.readChunk(path, { offset: cursor?.offset ?? 0, inode: cursor?.inode, maxBytes: TODO_CHUNK_BYTES, windowBytes: MAX_FOLD_BYTES });
        if (read.kind === 'nothing') break;
        if (read.kind === 'reset') {
          target = createTodoFold({ now: this.deps.now, notBefore: state.fold.notBefore });
          cursor = undefined;
          isRebuilding = true;
          sizeAtStart = undefined;
          continue;
        }
        foldTranscriptText(target, read.text);
        hasReadHistoryText ||= read.text.length > 0;
        const madeProgress = read.nextOffset > (cursor?.offset ?? 0);
        cursor = { path, inode: read.inode, offset: read.nextOffset };
        if (!isRebuilding) state.cursor = cursor;
        sizeAtStart ??= read.size;
        chunksRead += 1;
        const hasReadWhatWasThereAtStart = read.nextOffset >= sizeAtStart;
        const hasSpentTheBudgetOfARead = chunksRead >= MAX_CHUNKS_PER_READ;
        if (hasReadWhatWasThereAtStart || hasSpentTheBudgetOfARead || !madeProgress) break;
        await nextTurnOfTheEventLoop();
      }
      const historyArrivedForTheFirstTime = isAwaitingTheHistory && hasReadHistoryText;
      const hasReadTheReplacement = isRebuilding && cursor !== undefined && (!isAwaitingTheHistory || hasReadHistoryText);
      if (hasReadTheReplacement) {
        state.fold = target;
        state.cursor = cursor;
      }
      const rowsComeFromHistory = hasReadTheReplacement || historyArrivedForTheFirstTime;
      if (rowsComeFromHistory) markRowsUnverified(state.fold);
      if (historyArrivedForTheFirstTime) this.reconcileLiveCallsWithTheHistory(state);
      state.isStale = false;
    });
  }

  private exclusively(work: () => Promise<void>): Promise<void> {
    const result = this.readGate.then(work, work);
    this.readGate = result.catch(() => undefined);
    return result;
  }

  private afterRun(state: SessionState): void {
    if (state.isClosing) return this.finalizeClosedSession(state);
    this.continueFallback(state);
    this.requestEmit(state);
    for (const resolve of state.idleWaiters.splice(0)) resolve();
  }

  private requestEmit(state: SessionState): void {
    if (state.isEmitPending) return;
    state.isEmitPending = true;
    this.scheduleFor(state, () => {
      state.isEmitPending = false;
      this.failingStale(state, 'todo_emit_failed', () => this.emitIfChanged(state));
    }, EMIT_COALESCE_MS);
  }

  private emitIfChanged(state: SessionState): void {
    const snapshot = this.snapshotOfState(state);
    const key = keyOf(snapshot);
    if (key === state.lastEmittedKey) return;
    state.lastEmittedKey = key;
    for (const listener of this.listeners) {
      try {
        listener(snapshot);
      } catch (error) {
        this.warnOnce(state, 'todo_listener_failed', error);
      }
    }
  }

  private startFallback(state: SessionState, toolUseId: string | undefined): void {
    const fallback = state.fallback ?? { toolUseIds: new Set<string>(), attempt: 0, isTimerPending: false, snapshotKeyAtStart: keyOf(snapshotOf(state.fold, state.sessionId)) };
    state.fallback = fallback;
    if (toolUseId !== undefined && fallback.toolUseIds.size < MAX_FALLBACK_TOOL_USE_IDS) fallback.toolUseIds.add(toolUseId);
    fallback.attempt = 0;
    this.scheduleFallbackRead(state, fallback);
  }

  private scheduleFallbackRead(state: SessionState, fallback: Fallback): void {
    const delay = FALLBACK_READ_DELAYS_MS[fallback.attempt];
    if (delay === undefined) {
      state.fallback = undefined;
      const hasNoTranscriptToTrust = this.deps.sessions.trustedTranscriptFileOf(state.sessionId) === undefined;
      if (hasNoTranscriptToTrust) this.markStale(state, 'todo_transcript_unreadable', undefined);
      return;
    }
    if (fallback.isTimerPending) return;
    fallback.isTimerPending = true;
    this.scheduleFor(state, () => {
      fallback.isTimerPending = false;
      fallback.attempt += 1;
      this.failingStale(state, 'todo_read_failed', () => this.enqueueRead(state));
    }, delay);
  }

  private isCurrent(state: SessionState): boolean {
    return this.states.get(state.sessionId) === state;
  }

  private isLive(state: SessionState): boolean {
    return this.isCurrent(state) && !state.isClosing;
  }

  /** Arms a timer that only runs while its session state is the live one: a closed or replaced state arms none and never acts. */
  private scheduleFor(state: SessionState, run: () => void, delayMs: number): void {
    if (!this.isLive(state)) return;
    const cancel = this.schedule(() => {
      this.cancelPending.delete(cancel);
      state.cancelTimers.delete(cancel);
      if (this.isLive(state)) run();
    }, delayMs);
    this.cancelPending.add(cancel);
    state.cancelTimers.add(cancel);
  }

  private cancelTimersOf(state: SessionState): void {
    for (const cancel of state.cancelTimers) {
      cancel();
      this.cancelPending.delete(cancel);
    }
    state.cancelTimers.clear();
  }

  private continueFallback(state: SessionState): void {
    const { fallback } = state;
    if (!fallback || fallback.isTimerPending) return;
    const hasReadSinceTheTimer = fallback.attempt > 0;
    if (!hasReadSinceTheTimer) return;
    const hasFoundTheCalls = fallback.toolUseIds.size > 0 ? [...fallback.toolUseIds].every((id) => state.fold.seenCalls.has(id)) : keyOf(snapshotOf(state.fold, state.sessionId)) !== fallback.snapshotKeyAtStart;
    if (hasFoundTheCalls) state.fallback = undefined;
    else this.scheduleFallbackRead(state, fallback);
  }

  private untilIdle(state: SessionState): Promise<boolean> {
    const isIdle = state.tasks.length === 0 && !state.isRunning;
    if (isIdle) return Promise.resolve(false);
    return new Promise((resolve) => {
      const answeredInTime = () => { clearTimeout(timer); resolve(false); };
      const timer = setTimeout(() => {
        const position = state.idleWaiters.indexOf(answeredInTime);
        if (position !== -1) state.idleWaiters.splice(position, 1);
        resolve(true);
      }, this.getWaitMs);
      timer.unref();
      state.idleWaiters.push(answeredInTime);
    });
  }

  /** Runs `work` from a timer callback, where a throw would be an uncaught exception: a fault marks the list stale instead. */
  private failingStale(state: SessionState, code: WarnCode, work: () => void): void {
    try {
      work();
    } catch (error) {
      this.markStale(state, code, error);
    }
  }

  private markStale(state: SessionState, code: WarnCode, error: unknown): void {
    state.isStale = true;
    this.warnOnce(state, code, error);
  }

  private warnOnce(state: SessionState, code: WarnCode, error: unknown): void {
    if (state.warnedReasons.has(code)) return;
    state.warnedReasons.add(code);
    log('warn', `todos: session ${state.sessionId}: the list could not be updated, keeping the last one`, undefined, { code, sessionId: state.sessionId, errno: errnoOf(error) });
  }

  private closeSession(sessionId: string): void {
    const state = this.states.get(sessionId);
    if (!state) return;
    state.isClosing = true;
    this.cancelTimersOf(state);
    if (!state.isRunning && state.tasks.length === 0) this.finalizeClosedSession(state);
  }

  /** The reopened session starts from a state of its own: the closing one, possibly still reading, is detached and never finalizes. */
  private reopenSession(sessionId: string): void {
    this.closedSnapshots.delete(sessionId);
    const closing = this.states.get(sessionId);
    if (!closing?.isClosing) return;
    this.states.delete(sessionId);
    for (const resolve of closing.idleWaiters.splice(0)) resolve();
  }

  /** Frees the fold of a closed session and keeps its last snapshot, for at most CLOSED_SNAPSHOTS_KEPT closed sessions. */
  private finalizeClosedSession(state: SessionState): void {
    if (!this.isCurrent(state)) return;
    this.emitIfChanged(state);
    this.closedSnapshots.set(state.sessionId, this.snapshotOfState(state));
    this.states.delete(state.sessionId);
    for (const resolve of state.idleWaiters.splice(0)) resolve();
    const oldest = this.closedSnapshots.keys().next().value;
    if (this.closedSnapshots.size > CLOSED_SNAPSHOTS_KEPT && oldest !== undefined) this.closedSnapshots.delete(oldest);

  }
}
