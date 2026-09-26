import type { DatabaseSync } from 'node:sqlite';
import { PERMISSION_MODES, type PermissionMode, type Session, type SessionSpec, type SessionState } from '@openfleet/shared';
import { EventBus } from '../events/eventBus.js';
import { createWorktree } from '../git/worktrees.js';
import type { Harness, HarnessHandle } from '../harness/harness.js';
import { newId, newToken } from '../ids.js';
import { MessageQueue } from './messageQueue.js';
import { SessionRepository } from './sessionRepository.js';
import { canDeliverNow, nextState, type SessionInput } from './stateMachine.js';

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
// silently discards the keystroke); the common path clears this immediately on the next real state
// transition observed in applyInput, so 5s only matters once hooks are already broken.
export const TURN_START_TIMEOUT_MS = 5000;
export const RESUME_TIMEOUT_EXIT_CODE = -1;
export const RESUME_LAUNCH_FAILED_EXIT_CODE = -2;

// ponytail: 'manual' joins the shared enum in P2-T06b; drop the union then.
const RESUMABLE_PERMISSION_MODES = new Set<string>([...PERMISSION_MODES, 'manual']);

// ponytail: main.ts constructs exactly one SessionService per real daemon process — this module-level
// map (rather than an instance field) is what lets a freshly resumed handle outrank a stale pre-restart
// process's onExit even when a test briefly runs two instances over the same db to simulate the restart
// boundary (Review Focus #2). A multi-daemon future would need a durable, cross-process marker instead.
const activeHandleBySessionId = new Map<string, HarnessHandle>();

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
  // Presence of a sessionId here means its message body has been typed but the separate submit keystroke
  // hasn't landed yet — the session is not deliverable in the meantime, so a second queued message can't
  // interleave with the pending one's \r (see deliver()).
  private readonly pendingSubmitTimers = new Map<string, ReturnType<typeof setTimeout>>();
  // Presence of a sessionId here means its '\r' has landed but no state transition has yet confirmed the
  // CLI actually started that turn — a rescue flush for whatever's still queued once this fires, in case
  // the hook that would normally trigger it never arrives (see armAwaitingTurn/deliver()).
  private readonly awaitingTurnTimers = new Map<string, ReturnType<typeof setTimeout>>();

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
    // An older message already sitting queued must be flushed first — otherwise this one could jump the
    // queue while isDeliverable briefly reads true (e.g. right after the older one's '\r' lands but before
    // its turn is confirmed), stranding the older message out of order.
    const anotherMessageAlreadyQueued = this.queue.nextPending(session.id) !== undefined;
    const message = this.queue.enqueue(input);
    if (anotherMessageAlreadyQueued || !this.isDeliverable(session.id, session.state)) {
      this.deps.bus.emit({ type: 'message.queued', sessionId: session.id, messageId: message.id });
      return { status: 'queued', messageId: message.id };
    }
    this.deliver(session.id, message.id, message.body);
    return { status: 'delivered', messageId: message.id };
  }

  updateModel(sessionId: string, model: string): { status: 'delivered' | 'queued'; messageId: string } {
    const session = this.require(sessionId);
    if (session.state === 'closed') throw new SessionClosedError(sessionId);
    this.repo.setModel(sessionId, model);
    this.deps.bus.emit({ type: 'session.model_changed', sessionId, model });
    return this.sendMessage({ sessionId, body: `/model ${model}` });
  }

  applyInput(sessionId: string, input: SessionInput): void {
    const session = this.require(sessionId);
    const state = nextState(session.state, input);
    if (state === session.state) return;
    // Only a real state transition proves the (resumed) process is alive; an unrecognized Notification
    // that leaves the session in 'starting' must not cancel the safety net that would otherwise close it.
    this.clearResumeTimer(sessionId);
    this.clearAwaitingTurn(sessionId); // any real transition proves the previous turn started; stop waiting for it
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
    if (this.isDeliverable(sessionId, state)) this.flushOne(sessionId);
  }

  recentOutput(sessionId: string): string { return this.outputBuffers.get(sessionId) ?? ''; }
  tokens(sessionId: string): { hookToken: string; mcpToken: string } | undefined { return this.repo.tokens(sessionId); }
  // ponytail: exposes the raw harness handle to the REST edge for test-only routes (fake-output); scope down if the daemon leaves localhost
  harnessHandle(sessionId: string): HarnessHandle | undefined { return this.handles.get(sessionId); }
  writeRaw(sessionId: string, data: string): void { this.handles.get(sessionId)?.write(data); }
  resize(sessionId: string, cols: number, rows: number): void { this.handles.get(sessionId)?.resize(cols, rows); }
  async close(sessionId: string, options?: { escalateAfterMs?: number }): Promise<void> {
    const handle = this.handles.get(sessionId);
    if (!handle) return;
    // markClosed only clears this once the process actually exits, up to the escalation window later —
    // a pending '\r' must not land on a pty that's already mid-teardown.
    this.clearPendingSubmitTimer(sessionId);
    this.clearAwaitingTurn(sessionId);
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
    const openSessionIds = [...this.handles.keys()];
    await Promise.all(openSessionIds.map((id) => this.close(id)));
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

  // ponytail: one message per turn; batch delivery if queues grow
  private flushOne(sessionId: string): void {
    const pending = this.queue.nextPending(sessionId);
    if (!pending) return;
    this.deliver(sessionId, pending.id, pending.body);
  }

  private isDeliverable(sessionId: string, state: SessionState): boolean {
    return canDeliverNow(state) && !this.pendingSubmitTimers.has(sessionId);
  }

  // Rescues a message that would otherwise sit queued forever: sendMessage's own FIFO check (see there)
  // already stops a later send from jumping this one, but only a real transition or this timeout ever
  // triggers the flush that actually delivers it once the CLI's hook goes missing.
  private armAwaitingTurn(sessionId: string): void {
    this.clearAwaitingTurn(sessionId);
    const timer = setTimeout(() => {
      this.awaitingTurnTimers.delete(sessionId);
      const session = this.repo.get(sessionId);
      if (session && this.isDeliverable(sessionId, session.state)) this.flushOne(sessionId);
    }, TURN_START_TIMEOUT_MS);
    this.awaitingTurnTimers.set(sessionId, timer);
  }

  private clearAwaitingTurn(sessionId: string): void {
    const timer = this.awaitingTurnTimers.get(sessionId);
    if (timer) clearTimeout(timer);
    this.awaitingTurnTimers.delete(sessionId);
  }

  // The composer treats one multi-character pty write as a paste and won't submit it, so the body and
  // the submit keystroke land as two separate writes. Until the delayed \r lands, this session is not
  // deliverable (see isDeliverable), so a second queued message can't interleave with this one's \r.
  private deliver(sessionId: string, messageId: string, body: string): void {
    const handle = this.handles.get(sessionId);
    if (!handle) return;
    handle.write(body);
    const timer = setTimeout(() => {
      this.pendingSubmitTimers.delete(sessionId);
      // activeHandleBySessionId (not this.handles) is the cross-instance source of truth: a resume on a
      // fresh SessionService instance retires this handle there even though the stale instance's own
      // handles map never learns about it (see the module-level map's ponytail comment above).
      if (activeHandleBySessionId.get(sessionId) !== handle) return; // session closed or resumed under a new handle: drop the submit keystroke
      const session = this.repo.get(sessionId);
      // Writing '\r' outside a deliverable state would submit into whatever turn is now running, or
      // answer a permission prompt instead of the composer (Review Focus #1) — drop it and leave the
      // row queued so the next idle flush retries it.
      if (!session || !canDeliverNow(session.state)) return;
      try {
        handle.write('\r');
        this.queue.markDelivered(messageId);
        this.deps.bus.emit({ type: 'message.delivered', sessionId, messageId });
      } catch (err) {
        console.error(`deliver: submit keystroke failed for session ${sessionId}, message ${messageId}`, err);
        return;
      }
      this.armAwaitingTurn(sessionId);
    }, this.deps.submitKeystrokeDelayMs ?? SUBMIT_KEYSTROKE_DELAY_MS);
    this.pendingSubmitTimers.set(sessionId, timer);
  }

  private clearPendingSubmitTimer(sessionId: string): void {
    const timer = this.pendingSubmitTimers.get(sessionId);
    if (timer) clearTimeout(timer);
    this.pendingSubmitTimers.delete(sessionId);
  }

  private markClosed(sessionId: string, exitCode: number | undefined): void {
    this.clearResumeTimer(sessionId);
    this.clearPendingSubmitTimer(sessionId);
    this.clearAwaitingTurn(sessionId);
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
