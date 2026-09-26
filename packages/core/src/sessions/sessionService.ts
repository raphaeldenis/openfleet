import type { DatabaseSync } from 'node:sqlite';
import { PERMISSION_MODES, type PermissionMode, type Session, type SessionSpec } from '@openfleet/shared';
import { EventBus } from '../events/eventBus.js';
import { createWorktree } from '../git/worktrees.js';
import type { Harness, HarnessHandle } from '../harness/harness.js';
import { newId, newToken } from '../ids.js';
import { MessageQueue } from './messageQueue.js';
import { SessionRepository } from './sessionRepository.js';
import { canDeliverNow, nextState, provesTurnEnded, type SessionInput } from './stateMachine.js';

export interface SessionServiceDeps { db: DatabaseSync; bus: EventBus; harnesses: Harness[]; baseUrl: string; worktreesRoot: string; resumeTimeoutMs?: number; submitKeystrokeDelayMs?: number }

export class SessionClosedError extends Error {
  constructor(sessionId: string) {
    super(`session ${sessionId} is closed`);
  }
}

const OUTPUT_BUFFER_LIMIT = 200 * 1024;
export const DEFAULT_CLOSE_ESCALATE_MS = 5000;
const DEFAULT_RESUME_TIMEOUT_MS = 15_000;
// ponytail: fixed delay tuned for Claude Code's paste detection (a multi-char single write reads as a
// paste and never submits); upgrade path is a per-harness submit strategy, e.g. bracketed paste mode.
export const SUBMIT_KEYSTROKE_DELAY_MS = 150;
// ponytail: fallback for a hook that never confirms the turn started (a dropped webhook, or a CLI that
// silently discards the keystroke); the common path ends the wait on the next real state transition.
// Ceiling: a UserPromptSubmit hook later than this leaves the DB saying idle while the CLI generates, so
// the next body is typed mid-turn (Claude Code buffers it in the composer). Upgrade path: confirm the turn
// from the pty output instead of trusting the DB state.
export const TURN_START_TIMEOUT_MS = 5000;
// ponytail: fixed retry for a throwing delivery step, then a slow parked retry so a wedged-not-exited pty
// (which may never produce a state transition) is still retried without a tight loop; add exponential
// backoff if pty writes fail transiently often enough to matter.
export const DELIVERY_RETRY_MS = 5000;
export const MAX_DELIVERY_RETRIES = 3;
export const PARKED_RETRY_MS = 60_000;
export const RESUME_TIMEOUT_EXIT_CODE = -1;
export const RESUME_LAUNCH_FAILED_EXIT_CODE = -2;

// ponytail: 'manual' joins the shared enum in P2-T06b; drop the union then.
const RESUMABLE_PERMISSION_MODES = new Set<string>([...PERMISSION_MODES, 'manual']);

// ponytail: main.ts constructs exactly one SessionService per real daemon process — this module-level
// map (rather than an instance field) is what lets a freshly resumed handle outrank a stale pre-restart
// process's onExit even when a test briefly runs two instances over the same db to simulate the restart
// boundary (Review Focus #2). A multi-daemon future would need a durable, cross-process marker instead.
const activeHandleBySessionId = new Map<string, HarnessHandle>();

// One delivery at a time per session: ready -> typing -> typed -> submitted -> ready, or closing until exit.
interface TypedPhase { name: 'typed'; messageId: string; handle: HarnessHandle }
type DeliveryPhase =
  | { name: 'ready' }
  | { name: 'typing'; messageId: string; handle: HarnessHandle }
  // ponytail: typed trusts the composer still holds the body and only ever adds the '\r' — if something
  // wiped the composer first, the empty submit is a no-op in the CLI and the message is counted delivered
  // but lost. Retyping would risk a doubled body, and Ctrl+U clears only one line of a multi-line body;
  // upgrade path is reading the composer back from the pty output before submitting.
  | TypedPhase
  | { name: 'submitted'; messageId: string }
  | { name: 'closing' }
  | { name: 'relaunching' };

interface Delivery { phase: DeliveryPhase; timer?: ReturnType<typeof setTimeout>; failedAttempts: number }

const READY: DeliveryPhase = { name: 'ready' };

function waitForExit(handle: HarnessHandle): Promise<void> {
  return new Promise((resolve) => {
    const unsubscribe = handle.onExit(() => { unsubscribe(); resolve(); });
  });
}

const LOW_SURROGATE_RANGE = { min: 0xdc00, max: 0xdfff };

function trimToTail(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  const start = text.length - maxLength;
  const startsMidSurrogatePair = text.charCodeAt(start) >= LOW_SURROGATE_RANGE.min && text.charCodeAt(start) <= LOW_SURROGATE_RANGE.max;
  return text.slice(startsMidSurrogatePair ? start + 1 : start);
}

export class SessionService {
  private readonly repo: SessionRepository;
  private readonly queue: MessageQueue;
  private readonly handles = new Map<string, HarnessHandle>();
  private readonly outputBuffers = new Map<string, string>();
  private readonly resumeTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly deliveries = new Map<string, Delivery>();
  // Message ids whose '\r' reached the pty but whose markDelivered has not succeeded yet.
  private readonly unrecordedDeliveries = new Map<string, string>();
  // Sessions whose updateModel() could not relaunch immediately (a turn, a permission prompt, or an
  // in-flight delivery was in the way); advance() consumes this the next time the session is deliverable.
  private readonly pendingRelaunches = new Set<string>();
  // ponytail: sessions whose last submitted turn was never seen ending. Only a hook from the idle CLI clears
  // it, never TURN_START_TIMEOUT_MS, so a relaunch cannot kill a CLI that may be generating. Ceiling: with
  // every hook lost, a pending relaunch (and the queue behind it) waits for the next Stop.
  private readonly unfinishedTurns = new Set<string>();
  private readonly relaunches = new Map<string, Promise<void>>();

  constructor(private readonly deps: SessionServiceDeps) {
    this.repo = new SessionRepository(deps.db);
    this.queue = new MessageQueue(deps.db);
  }

  async create(spec: SessionSpec): Promise<Session> {
    const id = newId();
    const hookToken = newToken();
    const mcpToken = newToken();
    const now = new Date().toISOString();
    this.repo.insert({ id, name: spec.name, emoji: spec.emoji, directory: spec.directory, worktree: null, model: spec.model ?? null,
      parent_id: spec.parentId ?? null, role: spec.role ?? null, harness: spec.harness, state: 'starting', state_since: now, hook_token: hookToken, mcp_token: mcpToken,
      permission_mode: spec.permissionMode ?? null, created_at: now });
    const harness = this.harnessFor(spec.harness);
    const handle = harness.start({
      sessionId: id, directory: spec.directory, model: spec.model, seededPrompt: spec.seededPrompt,
      hookUrl: `${this.deps.baseUrl}/hooks/${hookToken}`, mcpUrl: `${this.deps.baseUrl}/mcp`, mcpToken, displayName: `${spec.emoji} ${spec.name}`,
      permissionMode: spec.permissionMode,
    });
    this.handles.set(id, handle);
    activeHandleBySessionId.set(id, handle);
    handle.onData((data) => {
      this.appendOutput(id, data);
      this.deps.bus.emit({ type: 'session.output', sessionId: id, data });
    });
    handle.onExit((exitCode) => {
      if (activeHandleBySessionId.get(id) !== handle) return; // a stale process we already replaced (e.g. by a resume)
      this.markClosed(id, exitCode);
    });
    const session = this.repo.get(id)!;
    this.deps.bus.emit({ type: 'session.created', session });
    return session;
  }

  async createInWorktree(spec: SessionSpec & { repoPath: string; branchName: string }): Promise<Session> {
    const worktree = await createWorktree({ repoPath: spec.repoPath, branchName: spec.branchName, worktreesRoot: this.deps.worktreesRoot });
    return this.create({ ...spec, directory: worktree.path });
  }

  hasQueuedMessage(sessionId: string, body: string): boolean {
    return this.queue.hasQueued(sessionId, body);
  }

  sendMessage(input: { sessionId: string; body: string; fromSessionId?: string }): { status: 'delivered' | 'queued'; messageId: string } {
    const session = this.require(input.sessionId);
    const message = this.queue.enqueue(input);
    this.guarded(session.id, () => this.advance(session.id));
    const { phase } = this.deliveryOf(session.id);
    const isHandedToTerminal = phase.name === 'typing' && phase.messageId === message.id;
    if (isHandedToTerminal) return { status: 'delivered', messageId: message.id };
    this.deps.bus.emit({ type: 'message.queued', sessionId: session.id, messageId: message.id });
    return { status: 'queued', messageId: message.id };
  }

  // ponytail: a relaunch costs a CLI restart (~2s) and drops the TUI's in-memory state that never made it
  // into the transcript; acceptable because the transcript carries the conversation. Upgrade path: drive
  // this through a session-scoped model switch if Claude Code ever offers one, instead of a full restart.
  updateModel(sessionId: string, model: string): { status: 'relaunching' | 'deferred' } {
    const session = this.require(sessionId);
    if (session.state === 'closed') throw new SessionClosedError(sessionId);
    this.repo.setModel(sessionId, model);
    this.deps.bus.emit({ type: 'session.model_changed', sessionId, model });
    const isIdleConfirmed = canDeliverNow(session.state) && this.deliveryOf(sessionId).phase.name === 'ready' && !this.unfinishedTurns.has(sessionId);
    if (!isIdleConfirmed) {
      this.pendingRelaunches.add(sessionId);
      return { status: 'deferred' };
    }
    this.startRelaunch(sessionId);
    return { status: 'relaunching' };
  }

  // Closes the running process without telling the user the session is closed, then resumes it under the
  // model already written to the DB by updateModel — the same --resume/--model/fresh-tokens path a daemon
  // restart uses (Amendments A2/A3), never a typed '/model' (Amendment A4).
  private startRelaunch(sessionId: string): void {
    this.pendingRelaunches.delete(sessionId);
    this.enter(sessionId, { name: 'relaunching' });
    const relaunch = this.performRelaunch(sessionId)
      .catch((err) => console.error(`relaunch: session ${sessionId} could not be closed after a failed relaunch`, err))
      .finally(() => this.relaunches.delete(sessionId));
    this.relaunches.set(sessionId, relaunch);
  }

  private async performRelaunch(sessionId: string): Promise<void> {
    try {
      await this.retireForRelaunch(sessionId);
      const session = this.repo.get(sessionId);
      if (!session || session.state === 'closed') return; // closed by something else while the relaunch was in flight
      const isCloseRequested = this.deliveryOf(sessionId).phase.name === 'closing';
      if (isCloseRequested) {
        this.markClosed(sessionId, undefined);
        return;
      }
      this.resumeOne(session);
      this.enter(sessionId, READY);
    } catch (err) {
      console.error(`relaunch: session ${sessionId} failed to relaunch after a model change`, err);
      await this.failResume(sessionId);
    }
  }

  // Revokes the old tokens first so the dying process's late hooks and MCP calls reach no session, then
  // forgets its handle before killing it: its exit must not trip markClosed, and nothing may kill it twice.
  private async retireForRelaunch(sessionId: string): Promise<void> {
    this.repo.setTokens(sessionId, newToken(), newToken());
    const handle = this.handles.get(sessionId);
    if (!handle) return;
    this.handles.delete(sessionId);
    activeHandleBySessionId.delete(sessionId);
    await this.killWithEscalation(handle, DEFAULT_CLOSE_ESCALATE_MS);
  }

  applyInput(sessionId: string, input: SessionInput): void {
    const session = this.require(sessionId);
    const endsUnfinishedTurn = provesTurnEnded(input) && this.unfinishedTurns.has(sessionId);
    if (endsUnfinishedTurn) this.unfinishedTurns.delete(sessionId);
    const state = nextState(session.state, input);
    if (state === session.state) {
      // The turn's start was never reported, but its end still releases a relaunch held behind it.
      if (endsUnfinishedTurn) this.guarded(sessionId, () => this.advance(sessionId));
      return;
    }
    // Only a real state transition proves the (resumed) process is alive; an unrecognized Notification
    // that leaves the session in 'starting' must not cancel the safety net that would otherwise close it.
    this.clearResumeTimer(sessionId);
    const isAwaitingTurnStart = this.deliveryOf(sessionId).phase.name === 'submitted';
    if (isAwaitingTurnStart) this.enter(sessionId, READY); // any real transition proves the submitted turn started
    if (state === 'closed') {
      // harness_exit means the process already died — markClosed only records it. Any other path to
      // closed (SessionEnd, etc.) is not proof the process actually exited, so it must go through the
      // real close() (kill, await exit, escalate to SIGKILL) or the PTY is orphaned.
      if (input.kind === 'harness_exit') this.markClosed(sessionId, undefined);
      else void this.close(sessionId);
      return;
    }
    const since = new Date().toISOString();
    this.repo.setState(sessionId, state, since);
    this.deps.bus.emit({ type: 'session.state', sessionId, state, stateSince: since });
    this.guarded(sessionId, () => this.advance(sessionId));
  }

  recentOutput(sessionId: string): string { return this.outputBuffers.get(sessionId) ?? ''; }
  tokens(sessionId: string): { hookToken: string; mcpToken: string } | undefined { return this.repo.tokens(sessionId); }
  // ponytail: exposes the raw harness handle to the REST edge for test-only routes (fake-output); scope down if the daemon leaves localhost
  harnessHandle(sessionId: string): HarnessHandle | undefined { return this.handles.get(sessionId); }
  writeRaw(sessionId: string, data: string): void { this.handles.get(sessionId)?.write(data); }
  resize(sessionId: string, cols: number, rows: number): void { this.handles.get(sessionId)?.resize(cols, rows); }
  async close(sessionId: string, options?: { escalateAfterMs?: number }): Promise<void> {
    const relaunch = this.relaunches.get(sessionId);
    if (relaunch) {
      // The relaunch is already killing the process: it sees 'closing' once it exits and stops there.
      this.enter(sessionId, { name: 'closing' });
      return relaunch;
    }
    const handle = this.handles.get(sessionId);
    if (!handle) return;
    // The process may take the whole escalation window to exit: nothing is typed or submitted into it meanwhile.
    this.enter(sessionId, { name: 'closing' });
    await this.killWithEscalation(handle, options?.escalateAfterMs ?? DEFAULT_CLOSE_ESCALATE_MS);
  }

  private async killWithEscalation(handle: HarnessHandle, escalateAfterMs: number): Promise<void> {
    const exited = waitForExit(handle);
    handle.kill();
    let escalateTimer: ReturnType<typeof setTimeout>;
    const gracePeriodExpired = new Promise<false>((resolve) => {
      escalateTimer = setTimeout(() => resolve(false), escalateAfterMs);
    });
    const exitedGracefully = await Promise.race([exited.then(() => true as const), gracePeriodExpired]);
    clearTimeout(escalateTimer!);
    if (exitedGracefully) return;
    const exitedAfterForce = waitForExit(handle);
    handle.kill({ force: true });
    await exitedAfterForce;
  }

  async closeAll(): Promise<void> {
    const openSessionIds = new Set([...this.handles.keys(), ...this.relaunches.keys()]);
    await Promise.all([...openSessionIds].map((id) => this.close(id)));
  }
  get(id: string): Session | undefined { return this.repo.get(id); }
  list(): Session[] { return this.repo.list(); }
  byHookToken(token: string): Session | undefined { return this.repo.byHookToken(token); }
  byMcpToken(token: string): Session | undefined { return this.repo.byMcpToken(token); }

  async resumeAll(): Promise<void> {
    for (const session of this.repo.list()) {
      if (session.state === 'closed') continue;
      if (this.handles.has(session.id)) continue; // already resumed by an earlier resumeAll() on this instance
      try {
        this.resumeOne(session);
      } catch {
        // A failure anywhere past the launch itself (e.g. the state-machine DB write) must not abort
        // resuming the rest of the fleet — kill the process we already launched and move on.
        await this.failResume(session.id);
      }
    }
  }

  private async failResume(sessionId: string): Promise<void> {
    const handle = this.handles.get(sessionId);
    if (handle) {
      // Detach first, same reasoning as armResumeTimeout: the handle's own onExit must not record
      // whatever exit code the harness reports over RESUME_LAUNCH_FAILED_EXIT_CODE below.
      activeHandleBySessionId.delete(sessionId);
      await this.killWithEscalation(handle, DEFAULT_CLOSE_ESCALATE_MS);
    }
    try {
      this.markClosed(sessionId, RESUME_LAUNCH_FAILED_EXIT_CODE);
    } catch (err) {
      // markClosed's own DB write can itself fail; one bad row's cleanup must not stop the rest of the fleet.
      console.error(`resumeAll: failed to close session ${sessionId} after a resume error`, err);
    }
  }

  // ponytail: 200 KB ring buffer, persist scrollback to disk if replays matter more
  private appendOutput(sessionId: string, data: string): void {
    const combined = (this.outputBuffers.get(sessionId) ?? '') + data;
    this.outputBuffers.set(sessionId, trimToTail(combined, OUTPUT_BUFFER_LIMIT));
  }

  // Moves the session's delivery as far as it can go right now. Nothing is typed or submitted unless the
  // session is deliverable (idle, or waiting_input: the CLI waits on its composer) — never into a running
  // turn (Review Focus #4) nor onto a permission prompt (Review Focus #1).
  private advance(sessionId: string): void {
    const session = this.repo.get(sessionId);
    const isDeliverable = session !== undefined && canDeliverNow(session.state);
    if (!isDeliverable) return;
    const { phase } = this.deliveryOf(sessionId);
    if (phase.name === 'typed') this.submit(sessionId, phase);
    if (phase.name !== 'ready') return;
    // A deferred relaunch always wins over the next queued message: it was requested first, and typing
    // into a handle we're about to kill would just be retyped into the resumed one anyway.
    const isRelaunchPending = this.pendingRelaunches.has(sessionId);
    const isTurnUnfinished = this.unfinishedTurns.has(sessionId);
    if (isRelaunchPending && isTurnUnfinished) return;
    if (isRelaunchPending) this.startRelaunch(sessionId);
    else this.typeNextMessage(sessionId);
  }

  // ponytail: one message per turn; batch delivery if queues grow
  private typeNextMessage(sessionId: string): void {
    this.recordDelivery(sessionId);
    const handle = this.liveHandle(sessionId);
    if (!handle) return;
    const message = this.queue.nextPending(sessionId);
    if (!message) return;
    // Assumes HarnessHandle.write throws only when no bytes reached the pty: a failed body is retyped from 'ready'.
    handle.write(message.body);
    // The composer reads a body and its '\r' in one write as a paste and never submits it: the '\r' waits.
    const submitDelayMs = this.deps.submitKeystrokeDelayMs ?? SUBMIT_KEYSTROKE_DELAY_MS;
    const submitDelay = this.schedule(sessionId, submitDelayMs, () => this.finishTyping(sessionId));
    this.enter(sessionId, { name: 'typing', messageId: message.id, handle }, submitDelay);
  }

  private finishTyping(sessionId: string): void {
    const { phase } = this.deliveryOf(sessionId);
    if (phase.name !== 'typing') return;
    this.enter(sessionId, { ...phase, name: 'typed' });
    this.advance(sessionId);
  }

  private submit(sessionId: string, phase: TypedPhase): void {
    // A new handle's pty starts with an empty composer: the message is typed there from scratch.
    const isHandleReplaced = this.liveHandle(sessionId) !== phase.handle;
    if (isHandleReplaced) {
      this.enter(sessionId, READY);
      return;
    }
    phase.handle.write('\r');
    // The '\r' reached the pty: the delivery is committed, so nothing past this line may lead to a second '\r'.
    this.unrecordedDeliveries.set(sessionId, phase.messageId);
    this.unfinishedTurns.add(sessionId);
    const turnStartTimeout = this.schedule(sessionId, TURN_START_TIMEOUT_MS, () => this.stopAwaitingTurnStart(sessionId));
    this.enter(sessionId, { name: 'submitted', messageId: phase.messageId }, turnStartTimeout);
    try {
      this.recordDelivery(sessionId);
    } catch (err) {
      console.error(`delivery: session ${sessionId} submitted message ${phase.messageId}, recording it failed and is retried before the next message`, err);
    }
  }

  // Throws while the db refuses the write; typeNextMessage retries it first, so the submitted body is never retyped.
  private recordDelivery(sessionId: string): void {
    const messageId = this.unrecordedDeliveries.get(sessionId);
    if (messageId === undefined) return;
    this.queue.markDelivered(messageId);
    this.unrecordedDeliveries.delete(sessionId);
    this.announceDelivered(sessionId, messageId);
  }

  // A failing listener (e.g. a WS client on a closing socket) is not a delivery failure: it never feeds the retry.
  private announceDelivered(sessionId: string, messageId: string): void {
    try {
      this.deps.bus.emit({ type: 'message.delivered', sessionId, messageId });
    } catch (err) {
      console.error(`delivery: session ${sessionId} delivered message ${messageId}, but a message.delivered listener failed`, err);
    }
  }

  private stopAwaitingTurnStart(sessionId: string): void {
    this.enter(sessionId, READY);
    this.advance(sessionId);
  }

  // activeHandleBySessionId (not this.handles) is the cross-instance source of truth: a resume on a fresh
  // SessionService retires this instance's handle there, even though this.handles never learns about it.
  private liveHandle(sessionId: string): HarnessHandle | undefined {
    const handle = this.handles.get(sessionId);
    const isLive = handle !== undefined && activeHandleBySessionId.get(sessionId) === handle;
    return isLive ? handle : undefined;
  }

  private deliveryOf(sessionId: string): Delivery {
    return this.deliveries.get(sessionId) ?? { phase: READY, failedAttempts: 0 };
  }

  // The only place a delivery timer is replaced, so a session never has more than one.
  private enter(sessionId: string, phase: DeliveryPhase, timer?: ReturnType<typeof setTimeout>): void {
    clearTimeout(this.deliveries.get(sessionId)?.timer);
    this.deliveries.set(sessionId, { phase, timer, failedAttempts: 0 });
  }

  private stopDelivery(sessionId: string): void {
    clearTimeout(this.deliveries.get(sessionId)?.timer);
    this.deliveries.delete(sessionId);
  }

  private schedule(sessionId: string, delayMs: number, step: () => void): ReturnType<typeof setTimeout> {
    return setTimeout(() => this.guarded(sessionId, step), delayMs);
  }

  // The one error boundary of delivery: a throwing step keeps its phase and its message queued.
  private guarded(sessionId: string, step: () => void): void {
    try {
      step();
    } catch (err) {
      this.retryAfterFailure(sessionId, err);
    }
  }

  private retryAfterFailure(sessionId: string, err: unknown): void {
    const delivery = this.deliveryOf(sessionId);
    const failedAttempts = delivery.failedAttempts + 1;
    const isNewFailureStreak = failedAttempts === 1;
    if (isNewFailureStreak) console.error(`delivery: session ${sessionId} failed, its message stays queued`, err);
    // Past the last fast retry the machine parks on the slow PARKED_RETRY_MS; a state transition advances it sooner.
    const isParked = failedAttempts > MAX_DELIVERY_RETRIES;
    const retryDelayMs = isParked ? PARKED_RETRY_MS : DELIVERY_RETRY_MS;
    const retry = this.handles.has(sessionId) ? this.schedule(sessionId, retryDelayMs, () => this.advance(sessionId)) : undefined;
    clearTimeout(delivery.timer);
    this.deliveries.set(sessionId, { ...delivery, timer: retry, failedAttempts });
  }

  private markClosed(sessionId: string, exitCode: number | undefined): void {
    this.clearResumeTimer(sessionId);
    this.stopDelivery(sessionId);
    this.pendingRelaunches.delete(sessionId);
    this.unfinishedTurns.delete(sessionId);
    const session = this.repo.get(sessionId);
    if (!session || session.state === 'closed') return;
    this.repo.setClosed(sessionId, exitCode, new Date().toISOString());
    this.handles.delete(sessionId);
    activeHandleBySessionId.delete(sessionId);
    this.deps.bus.emit({ type: 'session.closed', sessionId, exitCode });
  }

  private resumeOne(session: Session): void {
    const tokens = this.repo.tokens(session.id);
    if (!tokens) return; // defensive: every session row carries its tokens, but never resume without them
    const harness = this.harnessFor(session.harness);
    const permissionMode = this.resolveResumePermissionMode(session);
    // A daemon crash can leave the pre-restart process alive for a moment in its orphaned PTY (ponytail:
    // it can still touch files on disk until it actually exits — persisting the PTY pid and killing its
    // process group on resume would close that window, but the DB row has no pid column yet). Rotating
    // both tokens before launch means its late hooks 404/no-op and its MCP bearer gets 401 immediately,
    // rather than letting it act as the resumed session.
    const hookToken = newToken();
    const mcpToken = newToken();
    this.repo.setTokens(session.id, hookToken, mcpToken);
    let handle: HarnessHandle;
    try {
      handle = harness.start({
        sessionId: session.id,
        directory: session.directory,
        model: session.model,
        hookUrl: `${this.deps.baseUrl}/hooks/${hookToken}`,
        mcpUrl: `${this.deps.baseUrl}/mcp`,
        mcpToken,
        displayName: `${session.emoji} ${session.name}`,
        permissionMode,
        resuming: true,
      });
    } catch {
      // The launch builder refuses to resume with a missing/invalid session id (it would otherwise open
      // the CLI's interactive picker inside the PTY) — close this one row and keep resuming the rest of
      // the fleet rather than letting one bad row abort resumeAll for every other session.
      this.markClosed(session.id, RESUME_LAUNCH_FAILED_EXIT_CODE);
      return;
    }
    this.handles.set(session.id, handle);
    activeHandleBySessionId.set(session.id, handle);
    handle.onData((data) => {
      this.appendOutput(session.id, data);
      this.deps.bus.emit({ type: 'session.output', sessionId: session.id, data });
    });
    handle.onExit((exitCode) => {
      if (activeHandleBySessionId.get(session.id) !== handle) return; // a stale process we already replaced
      this.markClosed(session.id, exitCode);
    });
    this.armResumeTimeout(session.id, handle);
    // The DB write is last: if it throws, the handle is already fully wired (onExit + resume timeout),
    // so resumeAll's catch can close this row via markClosed without leaving an untracked process behind.
    this.repo.setState(session.id, 'starting', new Date().toISOString());
  }

  private resolveResumePermissionMode(session: Session): PermissionMode | undefined {
    const stored = session.permissionMode;
    if (stored === undefined) return undefined;
    if (stored === 'default') return 'manual' as PermissionMode;
    if (RESUMABLE_PERMISSION_MODES.has(stored)) return stored as PermissionMode;
    console.warn(`resumeOne: session ${session.id} has an unrecognized permission_mode "${stored}", resuming without --permission-mode`);
    return undefined;
  }

  private armResumeTimeout(sessionId: string, handle: HarnessHandle): void {
    const timer = setTimeout(() => {
      if (activeHandleBySessionId.get(sessionId) !== handle) return; // already replaced or closed by something else
      // Detach first so the handle's own onExit (fired by killWithEscalation below) can't race this
      // timeout's own RESUME_TIMEOUT_EXIT_CODE with whatever exit code the harness happens to report.
      activeHandleBySessionId.delete(sessionId);
      void this.killWithEscalation(handle, DEFAULT_CLOSE_ESCALATE_MS).then(() => {
        // Re-check: killWithEscalation can run for up to DEFAULT_CLOSE_ESCALATE_MS, long enough for another
        // instance sharing this db (a second daemon restart mid-escalation) to resume this same session
        // under a new handle. Our own deletion above already left this slot empty — that's the expected,
        // common case and must still proceed to markClosed; only a handle claimed by someone else means skip.
        if (activeHandleBySessionId.has(sessionId)) return;
        this.markClosed(sessionId, RESUME_TIMEOUT_EXIT_CODE);
      });
    }, this.deps.resumeTimeoutMs ?? DEFAULT_RESUME_TIMEOUT_MS);
    this.resumeTimers.set(sessionId, timer);
  }

  private clearResumeTimer(sessionId: string): void {
    const timer = this.resumeTimers.get(sessionId);
    if (timer) clearTimeout(timer);
    this.resumeTimers.delete(sessionId);
  }

  private harnessFor(id: string): Harness {
    const harness = this.deps.harnesses.find((h) => h.id === id);
    if (!harness) throw new Error(`unknown harness: ${id}`);
    return harness;
  }

  private require(id: string): Session {
    const session = this.repo.get(id);
    if (!session) throw new Error(`unknown session: ${id}`);
    return session;
  }
}
