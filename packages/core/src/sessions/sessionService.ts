import { accessSync, constants, existsSync, lstatSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, normalize, sep } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { PermissionMode, Session, SessionSpec } from '@openfleet/shared';
import { EventBus } from '../events/eventBus.js';
import { createWorktree } from '../git/worktrees.js';
import type { Harness, HarnessHandle } from '../harness/harness.js';
import { newId, newToken } from '../ids.js';
import { MessageQueue } from './messageQueue.js';
import { wrapAgentMessage } from './messageEnvelope.js';
import { normalizePermissionMode, SessionRepository } from './sessionRepository.js';
import { canDeliverNow, nextState, provesTurnEnded, type SessionInput } from './stateMachine.js';

export interface SessionServiceDeps { db: DatabaseSync; bus: EventBus; harnesses: Harness[]; baseUrl: string; worktreesRoot: string; resumeTimeoutMs?: number; submitKeystrokeDelayMs?: number }

export class SessionClosedError extends Error {
  constructor(sessionId: string) {
    super(`session ${sessionId} is closed`);
  }
}

// message_id is caller-chosen and never namespaced by sender, so two unrelated callers (or one caller
// resending a corrected body) can collide on the same id. Idempotent replay is only safe when the replay
// is provably the same send (same sender, same target, same resulting body); any other collision must
// fail loudly rather than silently return another send's status or drop the new one.
export class MessageIdAlreadyUsedError extends Error {
  constructor(messageId: string) {
    super(`message_id already used: ${messageId}`);
  }
}

export class SessionReopenError extends Error {
  constructor(public readonly code: 'not_closed' | 'directory_missing' | 'directory_changed' | 'directory_unreadable' | 'launch_failed', message: string) {
    super(message);
  }
}

export class DaemonShuttingDownError extends Error {
  constructor() {
    super('daemon is shutting down');
  }
}

const OUTPUT_BUFFER_LIMIT = 200 * 1024;
export const DEFAULT_CLOSE_ESCALATE_MS = 5000;
const DEFAULT_RESUME_TIMEOUT_MS = 15_000;
// ponytail: fixed delay giving Claude Code's composer time to settle after typeMessage's bracketed-paste
// write before the separate '\r' submits it; upgrade path is confirming the composer holds the full body
// from the pty output instead of trusting a fixed delay.
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
// ponytail: fixed-interval poll on the transcript file's size instead of fs.watch — fs.watch coalesces or
// drops events on some platforms (notably network/tmpfs mounts) and this only ever needs to catch one
// appended line within the timeout below; upgrade to fs.watch (or tailing over the hook channel) if the
// poll interval's latency ever matters.
export const TRANSCRIPT_INTERRUPT_POLL_MS = 200;
export const TRANSCRIPT_INTERRUPT_TIMEOUT_MS = 30_000;
const INTERRUPTED_TRANSCRIPT_MARKER = '[Request interrupted by user]';

// ponytail: a watch keeps the transcriptPath and offset it armed with for its whole life — a mid-turn
// transcript_path change (a later hook naming a different file) is not followed, and the CLI truncating
// or replacing the file while armed is not detected; both leave the watch tailing something stale.
// Upgrade path: re-read the current transcriptPaths value each poll and re-arm on a mismatch or a size
// that shrank.
interface InterruptWatch {
  transcriptPath: string;
  offset: number;
  // A line split across two polls (the CLI's write straddling the poll boundary) would otherwise be
  // dropped for good: the tail end read on its own poll is not valid JSON. Carried over and prepended to
  // the next poll's read, like tail -f line buffering.
  pendingPartialLine: string;
  timer: ReturnType<typeof setInterval>;
  timeout: ReturnType<typeof setTimeout>;
}

// Claude Code fires no Stop hook when Escape cancels a turn, but it does append this line to the
// session's own transcript JSONL (confirmed in T06h's real-CLI QA evidence) — the one place the daemon
// can see the turn actually ended.
// ponytail: matches the marker's exact literal text, so a real user turn typed through raw passthrough
// while a watch happens to be armed and containing this exact sentence would false-positive as an
// interrupt. Upgrade path: only trust a marker appended within a short window right after the ESC that
// armed the watch, or corroborate with a harness-native turn-end signal if one ever exists.
//
// Runs inside a setInterval callback with nothing above it to catch a throw, on a line the session's own
// (or a compromised) CLI process fully controls — it must return false for any shape it doesn't recognize,
// never throw, no matter how the JSON parses.
function isInterruptedTranscriptLine(line: string): boolean {
  const trimmedLine = line.trim();
  if (!trimmedLine) return false;
  let entry: unknown;
  try {
    entry = JSON.parse(trimmedLine);
  } catch {
    return false;
  }
  if (typeof entry !== 'object' || entry === null) return false;
  const record = entry as { type?: unknown; message?: unknown };
  if (record.type !== 'user') return false;
  const message = record.message;
  if (typeof message !== 'object' || message === null) return false;
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) return false;
  return content.some((block) => {
    if (typeof block !== 'object' || block === null) return false;
    const textBlock = block as { type?: unknown; text?: unknown };
    return textBlock.type === 'text' && textBlock.text === INTERRUPTED_TRANSCRIPT_MARKER;
  });
}

// The daemon's own env is what the harness passes through to the CLI child (childEnvironment.ts keeps
// CLAUDE_CONFIG_DIR — it's user configuration, not a session marker), so it is also the daemon's own
// source of truth for where that CLI writes transcripts.
function claudeProjectsDir(): string {
  const configDir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
  return join(configDir, 'projects');
}

// Walks up from `path` to the nearest ancestor that already exists on disk, returning that ancestor
// alongside the path segments below it that don't exist yet (outermost first). The first session ever run
// in a new directory reports a transcript_path whose whole per-directory project subfolder is still
// unborn — not just the file — so realpath-ing the immediate parent (which doesn't exist) would throw.
function nearestExistingAncestor(path: string): { existingAncestor: string; unbornSegments: string[] } {
  const unbornSegments: string[] = [];
  let current = path;
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) break; // reached the filesystem root; it always exists, so this never actually returns
    unbornSegments.unshift(basename(current));
    current = parent;
  }
  return { existingAncestor: current, unbornSegments };
}

// A session's own hook payload names its own transcript_path — a prompt-injected or hostile CLI could
// report any file there (e.g. /etc/hosts) and have the daemon start tailing it. Trust only a path that
// ends in .jsonl, is an absolute path with no ".."/"."/doubled-separator segments, and whose directory
// resolves, symlinks included, under the Claude projects directory the daemon's own environment implies.
// Neither the transcript file nor its per-directory project subfolder need exist yet: the CLI's own
// UserPromptSubmit hook can report transcript_path before it has created either, and realpath-ing a
// dirname that doesn't exist yet would reject a legitimate path just because it's early — so this walks up
// to the nearest existing ancestor and resolves the still-unborn segments against that ancestor's realpath
// instead. Never throws: a missing file, missing directory, or missing projects directory is just
// "untrusted".
function isTrustedTranscriptPath(path: string): boolean {
  if (!path.endsWith('.jsonl')) return false;
  if (!isAbsolute(path) || normalize(path) !== path) return false;
  try {
    const resolvedProjectsDir = realpathSync(claudeProjectsDir());
    const isUnderProjectsDir = (resolved: string) => resolved === resolvedProjectsDir || resolved.startsWith(resolvedProjectsDir + sep);
    // The leaf itself can already exist as a symlink (planted by a hostile CLI) pointing outside the
    // projects tree even though its containing directory resolves cleanly inside it — realpath-ing only
    // the directory would miss that. Once the leaf exists (lstat succeeds, even for a symlink whose
    // target is missing), resolve and trust the full path itself instead of just its directory.
    const leafExists = (() => {
      try {
        lstatSync(path);
        return true;
      } catch {
        return false;
      }
    })();
    if (leafExists) return isUnderProjectsDir(realpathSync(path));
    const { existingAncestor, unbornSegments } = nearestExistingAncestor(dirname(path));
    const resolvedAncestor = realpathSync(existingAncestor);
    const resolvedDir = unbornSegments.length === 0 ? resolvedAncestor : join(resolvedAncestor, ...unbornSegments);
    return isUnderProjectsDir(resolvedDir);
  } catch {
    return false;
  }
}

// ponytail: main.ts constructs exactly one SessionService per real daemon process — this module-level
// map (rather than an instance field) is what lets a freshly resumed handle outrank a stale pre-restart
// process's onExit even when a test briefly runs two instances over the same db to simulate the restart
// boundary (Review Focus #2). A multi-daemon future would need a durable, cross-process marker instead.
const activeHandleBySessionId = new Map<string, HarnessHandle>();

// One delivery at a time per session: ready -> typing -> typed -> submitted -> ready, or closing until exit.
// deferredRaw holds raw input (writeRaw) that arrived while the composer already held this message's body,
// so it can never land ahead of the Enter that submits it. It rides on the phase object itself: closing or
// relaunching replaces the phase wholesale, so a dead or replaced pty never receives it.
interface TypedPhase { name: 'typed'; messageId: string; handle: HarnessHandle; deferredRaw: string[] }
type DeliveryPhase =
  | { name: 'ready' }
  | { name: 'typing'; messageId: string; handle: HarnessHandle; deferredRaw: string[] }
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
  // Last transcript_path any hook reported for this session — the only way an ESC-armed watch below
  // knows which file to tail.
  private readonly transcriptPaths = new Map<string, string>();
  private readonly interruptWatches = new Map<string, InterruptWatch>();
  // Set once closeAll() starts; refuses any new launch (create, reopen, resumeOne, a relaunch) so it can
  // never spawn a process outside closeAll's own snapshot and survive daemon shutdown.
  private shuttingDown = false;

  constructor(private readonly deps: SessionServiceDeps) {
    this.repo = new SessionRepository(deps.db);
    this.queue = new MessageQueue(deps.db);
  }

  async create(spec: SessionSpec, options?: { branch?: string }): Promise<Session> {
    this.assertNotShuttingDown();
    const id = newId();
    const hookToken = newToken();
    const mcpToken = newToken();
    const now = new Date().toISOString();
    this.repo.insert({ id, name: spec.name, emoji: spec.emoji, directory: spec.directory, worktree: null, model: spec.model ?? null,
      parent_id: spec.parentId ?? null, role: spec.role ?? null, harness: spec.harness, state: 'starting', state_since: now, hook_token: hookToken, mcp_token: mcpToken,
      permission_mode: spec.permissionMode ?? null, branch: options?.branch ?? null, created_at: now });
    // Captured now so a later reopen can tell a directory that still resolves the same way apart from an
    // in-between symlink swap from one whose path never resolved to a real directory at all.
    if (existsSync(spec.directory)) this.repo.setDirectoryRealpath(id, realpathSync.native(spec.directory));
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
    return this.create({ ...spec, directory: worktree.path }, { branch: worktree.branch });
  }

  hasQueuedMessage(sessionId: string, body: string): boolean {
    return this.queue.hasQueued(sessionId, body);
  }

  queuedMessageCount(sessionId: string): number {
    return this.queue.countPending(sessionId);
  }

  // A messageId lets the caller retry a delivery attempt idempotently: resending the same id to the same
  // target returns the already-enqueued message's current status instead of enqueuing a second copy.
  // requireOpen runs first: a closed target is refused outright, before any envelope wrapping, idempotency
  // lookup, or enqueue — a dead session must never end up with something queued behind it (Task 12).
  sendMessage(input: { sessionId: string; body: string; fromSessionId?: string; messageId?: string }): { status: 'delivered' | 'queued'; messageId: string } {
    const session = this.requireOpen(input.sessionId);
    const messageId = input.messageId ?? newId();
    // Agent-to-agent messages (message_parent, send_session_message) always carry fromSessionId; a human
    // REST call and a manager's pulse never do, so its presence alone tells apart what needs the untrusted
    // envelope from what keeps its own shape (Task 6f).
    const body = input.fromSessionId
      ? wrapAgentMessage({ fromSessionId: input.fromSessionId, fromBranch: this.senderBranchOf(input.fromSessionId), messageId, body: input.body })
      : input.body;
    if (input.messageId) {
      const existing = this.queue.getById(input.messageId);
      if (existing) {
        // message_id carries no namespace of its own: it is only a safe idempotency key for a replay of
        // this exact send (same sender, same target, same resulting body). Anything else reusing it is a
        // collision, not a retry, and must fail loudly — never return a stranger's status, never drop the
        // new send on the floor.
        const isSameSend = existing.sessionId === session.id && existing.fromSessionId === input.fromSessionId && existing.body === body;
        if (isSameSend) return { status: existing.status, messageId: existing.id };
        throw new MessageIdAlreadyUsedError(input.messageId);
      }
    }
    const message = this.queue.enqueue({ id: messageId, sessionId: session.id, fromSessionId: input.fromSessionId, body });
    this.guarded(session.id, () => this.advance(session.id));
    const { phase } = this.deliveryOf(session.id);
    const isHandedToTerminal = phase.name === 'typing' && phase.messageId === message.id;
    if (isHandedToTerminal) return { status: 'delivered', messageId: message.id };
    this.deps.bus.emit({ type: 'message.queued', sessionId: session.id, messageId: message.id });
    return { status: 'queued', messageId: message.id };
  }

  // ponytail: Session carries no branch field yet (only a worktree path), so the daemon has nothing to
  // read here and every envelope shows '?' — add a branch column once a session records the one it runs
  // on, rather than shelling out to git for it.
  private senderBranchOf(_fromSessionId: string): string | undefined {
    return undefined;
  }

  // ponytail: a relaunch costs a CLI restart (~2s) and drops the TUI's in-memory state that never made it
  // into the transcript; acceptable because the transcript carries the conversation. Upgrade path: drive
  // this through a session-scoped model switch if Claude Code ever offers one, instead of a full restart.
  updateModel(sessionId: string, model: string): { status: 'relaunching' | 'deferred' } {
    this.assertNotShuttingDown();
    const session = this.requireOpen(sessionId);
    this.repo.setModel(sessionId, model);
    this.deps.bus.emit({ type: 'session.model_changed', sessionId, model });
    return this.relaunchOrDefer(sessionId, session.state);
  }

  // Same relaunch machinery as updateModel: the mode is only picked up on the next --resume launch
  // (resolveResumePermissionMode), never typed into the terminal, so a busy session defers it instead.
  updatePermissionMode(sessionId: string, mode: PermissionMode): { status: 'relaunching' | 'deferred' } {
    this.assertNotShuttingDown();
    const session = this.requireOpen(sessionId);
    this.repo.setPermissionMode(sessionId, mode);
    return this.relaunchOrDefer(sessionId, session.state);
  }

  private requireOpen(sessionId: string): Session {
    const session = this.require(sessionId);
    if (session.state === 'closed') throw new SessionClosedError(sessionId);
    return session;
  }

  // ponytail: a permission-mode change arriving while a model-change relaunch for the same session is
  // already in flight defers behind pendingRelaunches and then fires its own extra relaunch once the first
  // one lands, even though the first relaunch already picked up both the new model and the new mode — one
  // redundant restart with already-correct settings. Upgrade path: collapse a pending relaunch request into
  // one already in flight instead of always queuing a second one.
  private relaunchOrDefer(sessionId: string, state: Session['state']): { status: 'relaunching' | 'deferred' } {
    const isIdleConfirmed = canDeliverNow(state) && this.deliveryOf(sessionId).phase.name === 'ready' && !this.unfinishedTurns.has(sessionId);
    if (!isIdleConfirmed) {
      this.pendingRelaunches.add(sessionId);
      return { status: 'deferred' };
    }
    this.startRelaunch(sessionId);
    return { status: 'relaunching' };
  }

  // Renaming only changes the label — allowed on a closed session too, since it does not touch the process.
  rename(sessionId: string, patch: { name?: string; emoji?: string }): Session {
    this.require(sessionId);
    this.repo.setNameAndEmoji(sessionId, patch);
    const session = this.repo.get(sessionId)!;
    this.deps.bus.emit({ type: 'session.updated', session });
    return session;
  }

  // Resumes a closed session through the same --resume path a daemon restart uses (resumeOne): fresh
  // tokens, same model, same directory. Refuses a session that is not closed, whose directory has since
  // been removed (e.g. its worktree was cleaned up) rather than launching into a missing cwd, whose
  // directory now resolves somewhere else than it did when the session was created, or whose harness fails
  // to launch — the last leaves the session closed rather than reporting a fake success.
  reopen(sessionId: string): Session {
    this.assertNotShuttingDown();
    const session = this.require(sessionId);
    if (session.state !== 'closed') throw new SessionReopenError('not_closed', `session ${sessionId} is not closed`);
    if (!existsSync(session.directory)) throw new SessionReopenError('directory_missing', `session ${sessionId} directory no longer exists: ${session.directory}`);
    this.assertDirectoryUnchanged(session);
    this.assertDirectoryAccessible(session);
    const outcome = this.resumeOne(session);
    if (!outcome.launched) throw new SessionReopenError('launch_failed', `session ${sessionId} failed to relaunch: ${outcome.reason}`);
    this.deps.bus.emit({ type: 'session.reopened', sessionId });
    return this.repo.get(sessionId)!;
  }

  // A directory that resolved somewhere at creation and resolves somewhere else now had a path segment
  // swapped for a symlink while the session sat closed; a session created before this check existed (or
  // whose directory didn't exist yet at creation) has no recorded realpath, so the fallback at least
  // refuses a directory that is itself a symlink rather than a real one.
  private assertDirectoryUnchanged(session: Session): void {
    const currentRealpath = realpathSync.native(session.directory);
    const realpathAtCreation = this.repo.directoryRealpath(session.id);
    const isTrustworthy = realpathAtCreation ? currentRealpath === realpathAtCreation : lstatSync(session.directory).isDirectory();
    if (!isTrustworthy) throw new SessionReopenError('directory_changed', `session ${session.id} directory changed since it closed: ${session.directory}`);
  }

  // Catches a directory the harness could never actually launch into (e.g. chmod 000) before anything is
  // launched or announced, rather than reporting a fake 200 "starting" and a session.reopened event that
  // the CLI then contradicts ~2s later by dying and closing the session (Task 12b QA).
  // ponytail: no grace window for a launch that dies moments after this check passes (a permission race, a
  // mid-launch unmount) — this pre-check only covers a directory already unreadable at reopen time. Upgrade
  // path: have the launch itself emit a launch-failed event when the harness process exits within N seconds
  // of starting, instead of delaying every reopen reply to wait and see.
  private assertDirectoryAccessible(session: Session): void {
    try {
      accessSync(session.directory, constants.R_OK | constants.X_OK);
    } catch {
      throw new SessionReopenError('directory_unreadable', `session ${session.id} directory is not readable: ${session.directory}`);
    }
  }

  private assertNotShuttingDown(): void {
    if (this.shuttingDown) throw new DaemonShuttingDownError();
  }

  // Closes the running process without telling the user the session is closed, then resumes it under the
  // model already written to the DB by updateModel — the same --resume/--model/fresh-tokens path a daemon
  // restart uses (Amendments A2/A3), never a typed '/model' (Amendment A4).
  private startRelaunch(sessionId: string): void {
    this.assertNotShuttingDown();
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
      const outcome = this.resumeOne(session);
      // A failed launch already marked the session closed (and stopped its delivery) inside resumeOne:
      // entering READY here would resurrect a delivery record for a session that is no longer open.
      if (outcome.launched) this.enter(sessionId, READY);
    } catch (err) {
      console.error(`relaunch: session ${sessionId} failed to relaunch after a model change`, err);
      await this.failResume(sessionId);
    }
  }

  // Revokes the old tokens first so the dying process's late hooks and MCP calls reach no session, then
  // forgets its handle before killing it: its exit must not trip markClosed, and nothing may kill it twice.
  private async retireForRelaunch(sessionId: string): Promise<void> {
    this.disarmInterruptWatch(sessionId);
    this.transcriptPaths.delete(sessionId);
    this.repo.setTokens(sessionId, newToken(), newToken());
    const handle = this.handles.get(sessionId);
    if (!handle) return;
    this.handles.delete(sessionId);
    activeHandleBySessionId.delete(sessionId);
    await this.killWithEscalation(handle, DEFAULT_CLOSE_ESCALATE_MS);
  }

  applyInput(sessionId: string, input: SessionInput): void {
    const session = this.require(sessionId);
    if (input.kind === 'hook' && input.event.transcript_path && isTrustedTranscriptPath(input.event.transcript_path)) {
      this.transcriptPaths.set(sessionId, input.event.transcript_path);
    }
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
    // Any real transition away from 'generating' (Stop, a permission prompt, the idle_prompt self-heal,
    // the session closing) makes an armed interrupt watch moot — never let a late-firing one override it.
    this.disarmInterruptWatch(sessionId);
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
  // While the composer holds a message's body awaiting its Enter ('typing'), raw input is deferred onto
  // that phase instead of writing straight through — otherwise it could land between the body and the '\r'
  // that submits it. Outside that window it still writes straight through, as before, and either way the
  // arming check below runs where the bytes actually reach the pty, not here.
  writeRaw(sessionId: string, data: string): void {
    const { phase } = this.deliveryOf(sessionId);
    if (phase.name === 'typing') {
      phase.deferredRaw.push(data);
      return;
    }
    const handle = this.handles.get(sessionId);
    if (!handle) return;
    this.writeRawChunkAndArm(sessionId, handle, data);
  }

  // Single place a raw chunk reaches the pty, whether written straight through or flushed out of
  // deferredRaw: arming on ESC has to happen here, at the point the bytes actually land, not at writeRaw's
  // call site — a deferred ESC only means the CLI is generating (and so worth watching) once it's actually
  // flushed, which can be well after the write() call that queued it. Arming (which samples the
  // transcript's current size as the watch's offset) runs before handle.write, not after: arming after the
  // write would let the CLI's own reaction to the ESC append the interrupt marker in between, so the watch
  // would start past it and never see it. Free defense-in-depth, not a full guarantee against that race.
  private writeRawChunkAndArm(sessionId: string, handle: HarnessHandle, data: string): void {
    if (data.includes('\x1b')) this.armInterruptWatchIfGenerating(sessionId);
    handle.write(data);
  }

  // Arms a one-shot watch the moment a raw write containing the ESC byte lands while the CLI is
  // generating — the only signal the daemon has that the human meant to cancel the running turn. An
  // arrow key's CSI sequence also starts with ESC and arms it too; harmless, since arming costs at most
  // one poll interval running for up to TRANSCRIPT_INTERRUPT_TIMEOUT_MS. No-ops (per the manager's rule)
  // when a watch is already armed, the session isn't generating, or no hook has ever reported a
  // transcript_path for it.
  private armInterruptWatchIfGenerating(sessionId: string): void {
    if (this.interruptWatches.has(sessionId)) return;
    const session = this.repo.get(sessionId);
    if (!session || session.state !== 'generating') return;
    const transcriptPath = this.transcriptPaths.get(sessionId);
    if (!transcriptPath) return;
    // A trusted transcript_path can still name a file the CLI hasn't created yet (its own UserPromptSubmit
    // hook can fire before the write) — start the offset at 0 so the first poll picks up the whole file
    // once it exists, rather than refusing to arm at all. Any other stat failure (e.g. a permission error)
    // is not "file doesn't exist yet": arming at offset 0 there would replay whatever the file already
    // held — including a stale interrupt line from an earlier turn — as soon as the error clears, so the
    // watch must not arm at all.
    let offset: number;
    try {
      offset = statSync(transcriptPath).size;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') return;
      offset = 0; // no transcript file yet; poll from offset 0 once it's created
    }
    const timer = setInterval(() => this.pollInterruptWatch(sessionId), TRANSCRIPT_INTERRUPT_POLL_MS);
    const timeout = setTimeout(() => this.disarmInterruptWatch(sessionId), TRANSCRIPT_INTERRUPT_TIMEOUT_MS);
    this.interruptWatches.set(sessionId, { transcriptPath, offset, pendingPartialLine: '', timer, timeout });
  }

  // Reads only the bytes appended since the watch armed (or since the last poll), never re-scanning the
  // whole transcript. A byte offset (not a string index) keeps a multi-byte character straddling a poll
  // boundary from ever being read.
  //
  // This is a setInterval callback with nothing above it to catch a throw — an uncaught exception here
  // would crash the whole daemon, taking down every other session's watch with it. isInterruptedTranscriptLine
  // is itself total, but the try/catch is the backstop for anything else in the parse-and-match step
  // (e.g. a future change to it, or to this method) that might not be.
  private pollInterruptWatch(sessionId: string): void {
    try {
      this.pollInterruptWatchUnsafe(sessionId);
    } catch (err) {
      console.error(`interrupt watch: session ${sessionId} poll failed unexpectedly`, err);
    }
  }

  private pollInterruptWatchUnsafe(sessionId: string): void {
    const watch = this.interruptWatches.get(sessionId);
    if (!watch) return;
    let size: number;
    try {
      size = statSync(watch.transcriptPath).size;
    } catch {
      return; // e.g. the transcript file vanished this tick; treat as nothing this tick, keep polling until the timeout
    }
    if (size <= watch.offset) return;
    let appended: string;
    try {
      appended = readFileSync(watch.transcriptPath).subarray(watch.offset, size).toString('utf8');
    } catch {
      return; // e.g. a transient permission/read error; treat as nothing this tick, keep polling until the timeout
    }
    watch.offset = size;
    const lines = (watch.pendingPartialLine + appended).split('\n');
    watch.pendingPartialLine = lines.pop() ?? '';
    const sawInterruptMarker = lines.some(isInterruptedTranscriptLine);
    if (!sawInterruptMarker) return;
    this.disarmInterruptWatch(sessionId);
    this.applyInput(sessionId, { kind: 'transcript_interrupted' });
  }

  private disarmInterruptWatch(sessionId: string): void {
    const watch = this.interruptWatches.get(sessionId);
    if (!watch) return;
    clearInterval(watch.timer);
    clearTimeout(watch.timeout);
    this.interruptWatches.delete(sessionId);
  }


  resize(sessionId: string, cols: number, rows: number): void { this.handles.get(sessionId)?.resize(cols, rows); }
  async close(sessionId: string, options?: { escalateAfterMs?: number }): Promise<void> {
    // Disarmed eagerly, like retireForRelaunch, before the SIGTERM->SIGKILL grace window even starts: a
    // watch left armed through that window could still see a marker and flip session state while the
    // process is on its way out (or wedged and never exiting at all).
    this.disarmInterruptWatch(sessionId);
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
    // Set before the snapshot below is even taken: refusing every new launch from this point on is what
    // guarantees the snapshot stays complete for the rest of this method.
    this.shuttingDown = true;
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
      try {
        await this.killWithEscalation(handle, DEFAULT_CLOSE_ESCALATE_MS);
      } catch (err) {
        // A kill that throws must not leave the session wedged: it is closed below all the same.
        console.error(`resume: session ${sessionId} could not kill its process after a resume error`, err);
      }
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
    // Assumes HarnessHandle.typeMessage throws only when no bytes reached the pty: a failed body is retyped from 'ready'.
    handle.typeMessage(message.body);
    // typeMessage frames the body as one bracketed paste (see claudeCli/bracketedPaste.ts) so the composer
    // never reads it as keystrokes to submit line by line; the '\r' that actually submits stays a separate
    // write, sent only after the delay below.
    const submitDelayMs = this.deps.submitKeystrokeDelayMs ?? SUBMIT_KEYSTROKE_DELAY_MS;
    const submitDelay = this.schedule(sessionId, submitDelayMs, () => this.finishTyping(sessionId));
    this.enter(sessionId, { name: 'typing', messageId: message.id, handle, deferredRaw: [] }, submitDelay);
  }

  private finishTyping(sessionId: string): void {
    const { phase } = this.deliveryOf(sessionId);
    if (phase.name !== 'typing') return;
    // The phase leaves 'typing' before the deliverability read below, which can itself throw (a db hiccup):
    // the retry logic (advance(), driven by guarded()'s retryAfterFailure) only knows how to move a 'ready'
    // or 'typed' phase forward, so a throwing read must never strand the session in 'typing' forever (task 6i).
    this.enter(sessionId, { ...phase, name: 'typed' });
    const session = this.repo.get(sessionId);
    const isDeliverable = session !== undefined && canDeliverNow(session.state);
    // Raw input deferred behind this Enter targets the busy state it was pressed against (e.g. Interrupt
    // stops the running turn) — holding it for the eventual submit would misfire it onto whatever runs
    // next, so a non-deliverable session flushes it here, in arrival order, and the 'typed' phase carries
    // nothing. A deliverable session is unchanged: it still flushes right after the Enter, in submit().
    if (!isDeliverable) {
      const isHandleReplaced = this.liveHandle(sessionId) !== phase.handle;
      this.enter(sessionId, { ...phase, name: 'typed', deferredRaw: [] });
      // Mirrors submit()'s own guard: a handle a resume already replaced must never receive this, same as
      // the eventual '\r' never would.
      if (!isHandleReplaced) this.flushDeferredRaw(sessionId, phase.handle, phase.deferredRaw);
    }
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
    // The '\r' reached the pty: the delivery is committed here, before the deferred flush below, so nothing
    // past this line may lead to a second '\r' — a throwing flush must never look like a failed submit.
    this.unrecordedDeliveries.set(sessionId, phase.messageId);
    this.unfinishedTurns.add(sessionId);
    const turnStartTimeout = this.schedule(sessionId, TURN_START_TIMEOUT_MS, () => this.stopAwaitingTurnStart(sessionId));
    this.enter(sessionId, { name: 'submitted', messageId: phase.messageId }, turnStartTimeout);
    try {
      this.recordDelivery(sessionId);
    } catch (err) {
      console.error(`delivery: session ${sessionId} submitted message ${phase.messageId}, recording it failed and is retried before the next message`, err);
    }
    // Flushed right after the Enter, in arrival order: whatever was deferred behind this message now goes
    // straight through, on the same handle that just received the Enter. The delivery above is already
    // committed, so a throwing write here only drops the rest of this best-effort flush.
    this.flushDeferredRaw(sessionId, phase.handle, phase.deferredRaw);
  }

  // Deferred raw input is best-effort keystrokes, never part of a delivery's commit: a throwing write stops
  // the flush and drops whatever was still queued behind it — there is no caller left to report it to, so
  // it is only logged, the same way delivery already reports a write failure elsewhere in this file.
  // Never rethrowing here is load-bearing: a rethrow reaches retryAfterFailure via guarded(), whose
  // clearTimeout would cancel the turn-start timeout submit() just armed, wedging the session in 'submitted'.
  private flushDeferredRaw(sessionId: string, handle: HarnessHandle, deferredRaw: string[]): void {
    for (const raw of deferredRaw) {
      try {
        this.writeRawChunkAndArm(sessionId, handle, raw);
      } catch (err) {
        console.error(`delivery: session ${sessionId} failed to flush deferred raw input, dropping what's left`, err);
        return;
      }
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
    this.disarmInterruptWatch(sessionId);
    this.transcriptPaths.delete(sessionId);
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

  // Boot resume and reopen both call this, but only reopen acts on the outcome: boot resume keeps its
  // existing "log and mark closed" behaviour for one bad row so the rest of the fleet still comes up.
  private resumeOne(session: Session): { launched: true } | { launched: false; reason: string } {
    this.assertNotShuttingDown();
    const tokens = this.repo.tokens(session.id);
    if (!tokens) return { launched: false, reason: 'session has no stored tokens' }; // defensive: every session row carries its tokens
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
    } catch (err) {
      // The launch builder refuses to resume with a missing/invalid session id (it would otherwise open
      // the CLI's interactive picker inside the PTY) — close this one row and keep resuming the rest of
      // the fleet rather than letting one bad row abort resumeAll for every other session.
      console.error(`resumeOne: session ${session.id} failed to launch`, err);
      this.markClosed(session.id, RESUME_LAUNCH_FAILED_EXIT_CODE);
      return { launched: false, reason: (err as Error).message };
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
    return { launched: true };
  }

  private resolveResumePermissionMode(session: Session): PermissionMode | undefined {
    // session.permissionMode already went through normalizePermissionMode() once in the repository
    // mapper, which discards whether the raw column value was recognized — re-read the raw column here
    // so the resume path can still warn on an unrecognized value the repository silently turned into undefined.
    const raw = this.repo.rawPermissionMode(session.id);
    const { mode, wasRecognized } = normalizePermissionMode(raw);
    if (!wasRecognized) console.warn(`resumeOne: session ${session.id} has an unrecognized permission_mode "${raw}", resuming without --permission-mode`);
    return mode;
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
