import { accessSync, closeSync, constants, existsSync, lstatSync, openSync, readSync, realpathSync, statSync, type Stats } from 'node:fs';
import { basename, dirname, isAbsolute, join, normalize, sep } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { OpenFleetError, type ErrorCode, type ErrorEnvelope, type PermissionMode, type Session, type SessionCloseReason, type SessionSpec } from '@openfleet/shared';
import { carryLoggedRef, rememberLoggedRef } from '../errors/loggedRef.js';
import { EventBus } from '../events/eventBus.js';
import { createWorktree } from '../git/worktrees.js';
import type { Harness, HarnessHandle } from '../harness/harness.js';
import { claudeProjectsDir } from '../harness/claudeCli/claudeProjects.js';
import { findPermissiveSettingsWarning } from '../harness/claudeCli/permissiveSettings.js';
import { newId, newToken } from '../ids.js';
import { log } from '../logger.js';
import { MessageQueue } from './messageQueue.js';
import { findLatestContextTokens, findResolvedModel, readTranscriptTail } from './resolvedModel.js';
import { wrapAgentMessage } from './messageEnvelope.js';
import { normalizePermissionMode, SessionRepository } from './sessionRepository.js';
import { canDeliverNow, isClear, nextState, provesTurnEnded, startsClearedConversation, type SessionInput } from './stateMachine.js';

// Injected, not imported: describeError imports this module's error classes, so importing it here would make a cycle.
// Absent, the service still closes sessions with their reason but broadcasts no error events.
export type DescribeError = (error: unknown, scope: { sessionId?: string; where?: string }) => ErrorEnvelope;

export interface SessionServiceDeps { db: DatabaseSync; bus: EventBus; harnesses: Harness[]; baseUrl: string; worktreesRoot: string; resumeTimeoutMs?: number; firstStartTimeoutMs?: number; submitKeystrokeDelayMs?: number; clearInFlightTimeoutMs?: number; clearFlushGraceMs?: number; sessionEndExitGraceMs?: number; now?: () => number; describeError?: DescribeError; env?: NodeJS.ProcessEnv }

// `failure`: the typed error that made a launch fail; announced in place of the generic launch_failed when it is not internal.
interface SessionClosure { exitCode?: number; reason?: SessionCloseReason; failure?: unknown }

// Who made a close happen when the API/MCP/relaunch did not: the daemon shutting down, or the CLI ending itself (SessionEnd).
// Absent, the close was asked for by a user, a parent or a relaunch.
type CloseCause = 'shutdown' | 'session_end';

// A close the human must hear about without a request of their own. A user close and a clean exit are not failures.
const FAILURE_CODE_BY_CLOSE_REASON: Partial<Record<SessionCloseReason, ErrorCode>> = {
  launch_failed: 'launch_failed', resume_timeout: 'resume_timeout', harness_exit: 'harness_exited',
};

// A launch that fails on a known, caller-safe cause (the claude CLI is not on the PATH) names it; any other throw stays launch_failed.
const isNamedLaunchFailure = (error: unknown): error is OpenFleetError => error instanceof OpenFleetError && error.kind === 'unavailable';

// After SessionEnd the CLI exits within a fraction of a second on its own; the daemon waits this long before it kills a hung one.
export const SESSION_END_EXIT_GRACE_MS = 2000;
// A process that dies this soon after its spawn most likely never started (e.g. the CLI is not on the PATH).
export const EARLY_EXIT_WINDOW_MS = 3000;
const SIGNAL_EXIT_CODE_BASE = 128;
const CLI_NOT_FOUND_HINT = 'Check that the claude CLI is installed and on the PATH the daemon runs with.';
const REOPEN_HINT = 'reopen the session to resume the conversation.';

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

export class TooManyPendingMessagesError extends Error {
  constructor(targetId: string) {
    super(`too many pending messages to ${targetId}: ${MAX_PENDING_AGENT_MESSAGES_PER_SENDER} already queued, wait for delivery`);
  }
}

export class SessionReopenError extends Error {
  constructor(public readonly code: 'not_closed' | 'directory_missing' | 'directory_changed' | 'directory_unreadable' | 'launch_failed', message: string) {
    super(message);
  }
}

export class UnknownHarnessError extends Error {
  override readonly name = 'UnknownHarnessError';
  constructor(harnessId: string) {
    super(`unknown harness: ${harnessId}`);
  }
}

export class DaemonShuttingDownError extends Error {
  constructor() {
    super('daemon is shutting down');
  }
}

const OUTPUT_BUFFER_LIMIT = 200 * 1024;
export const DEFAULT_CLOSE_ESCALATE_MS = 5000;

interface ClearHold { timer: ReturnType<typeof setTimeout>; isFlushGrace: boolean; ended: Promise<void>; end: () => void }
const RECORDING_RETRY_DELAY_MS = 500;
const DEFAULT_RESUME_TIMEOUT_MS = 15_000;
// A /clear reports SessionEnd then SessionStart a few ms apart; a relaunch in between would resume the
// conversation being left. The hold ends when the SessionStart arrives (after the flush grace) or, if it
// never does, after this timeout.
const DEFAULT_CLEAR_IN_FLIGHT_TIMEOUT_MS = 3000;
// The new conversation's transcript is a 96 B stub until the CLI flushes it (0.32 s measured): a relaunch
// killing the process inside that window would leave a conversation `--resume` refuses.
const DEFAULT_CLEAR_FLUSH_GRACE_MS = 500;
export const NEW_CONVERSATION_NOTICE = '\r\n[OpenFleet] The previous conversation could not be found: started a new one.\r\n';
// A cold real CLI can sit waiting on an auth or trust prompt far longer than a resume ever should, so a
// first launch gets its own, more generous ceiling instead of sharing resumeTimeoutMs (AUD-06).
const DEFAULT_FIRST_START_TIMEOUT_MS = 60_000;
// ponytail: fixed delay giving Claude Code's composer time to settle after typeMessage's bracketed-paste
// write before the separate '\r' submits it; upgrade path is confirming the composer holds the full body
// from the pty output instead of trusting a fixed delay.
export const SUBMIT_KEYSTROKE_DELAY_MS = 150;
// Claude Code strips invisible characters (zero-width, bidi controls, BOM...) from a paste; the Enter that would
// submit such a composer prints this notice and waits for a second Enter instead of sending. The text the model
// receives is the CLI's own stripped text, so confirming is the faithful answer.
// Measured live (2.1.284): the notice follows the Enter by ~3 ms and the CLI ignores every Enter for the next
// ~100-150 ms, accepting one from 150 ms on; an accepted Enter starts the turn ~55 ms later.
// ponytail: matches the CLI's notice wording (2.1.284); a reworded notice only brings back the unsubmitted paste.
// The pty output is read with its escape sequences removed and its words allowed to be separated by anything (a wrap, a
// cursor move, a style change), so a notice wrapped by a narrow terminal still matches.
// A narrow terminal truncates the notice with an ellipsis instead of wrapping it ("… review and press Enter …" at 60
// columns, "… press Enter to s…" at 64), so its stable start "Removed <N> invisible character(s)" is the main anchor.
const INVISIBLE_CHARACTERS_REVIEW_NOTICE_SOURCE = String.raw`Removed\s*\d+\s*invisible\s*characters?|review\s*and\s*press\s*Enter\s*to\s*send|press\s*Enter\s*(?:to\s*s?)?\s*…`;
const INVISIBLE_CHARACTERS_REVIEW_NOTICE = new RegExp(INVISIBLE_CHARACTERS_REVIEW_NOTICE_SOURCE, 'g');
const GENERATING_MARKER = /esc\s*to\s*interrupt/g;
const TERMINAL_ESCAPE_SEQUENCES = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007]*\u0007/g;
const REVIEW_NOTICE_SPLIT_ACROSS_CHUNKS_MARGIN = 256;
export const REVIEW_SETTLE_MS = 300;
export const REVIEW_CONFIRMATION_PATIENCE_MS = 700;
export const MAX_REVIEW_CONFIRMATIONS = 3;
export const REVIEW_NOTICE_WINDOW_MS = 500;
export const COMPOSER_CLEAR_GAP_MS = 300;
// ponytail: a review the CLI neither accepted (no turn-start hook) nor showed still holding the paste keeps the queue
// gated this long, then is released without pressing any key: nothing proves the composer holds the paste, and an
// Escape into a CLI that took it would interrupt its turn. Ceiling: a CLI that really holds the paste for good gets the
// next message typed on top of it after this delay; upgrade path is reading the composer back from the pty output.
export const REVIEW_UNCONFIRMED_RELEASE_MS = 60_000;
const ESCAPE_KEY = '\u001b';
const INTERRUPT_KEYS = ['\u001b', '\u0003'];
// A superset of what the CLI strips from a paste (format, separator and control characters): a body holding one of
// them waits for the review window before it counts as delivered; the CLI's own notice stays the only proof.
const MAY_BE_STRIPPED_BY_THE_CLI = /[\p{Cf}\p{Zl}\p{Zp}\p{Cc}]/u;
// Bounds how many not-yet-delivered messages one agent can stack on a single peer, so a looping agent
// cannot flood a target's queue (8 KB each) faster than the target can read.
export const MAX_PENDING_AGENT_MESSAGES_PER_SENDER = 20;
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
export const TRANSCRIPT_INTERRUPT_MAX_READ_BYTES = 1024 * 1024;
const TRANSCRIPT_INTERRUPT_MAX_CARRIED_LINE_BYTES = 1024 * 1024;
const NEWLINE_BYTE = 0x0a;
const INTERRUPTED_TRANSCRIPT_MARKER = '[Request interrupted by user]';

// ponytail: a watch keeps the transcriptPath it armed with for its whole life — a mid-turn transcript_path
// change (a later hook naming a different file) is not followed, and a file that is emptied and regrown past
// the armed offset between two polls, without changing inode, looks like plain appending.
// Upgrade path: re-read the current transcriptPaths value each poll and re-arm on a mismatch.
interface InterruptWatch {
  transcriptPath: string;
  offset: number;
  // dev:ino of the file the offset belongs to; null while the file does not exist yet.
  fileIdentity: string | null;
  // Raw bytes of a line still waiting for its newline (the CLI's write straddling a poll boundary), kept
  // undecoded so a multibyte character cut by the boundary is decoded whole once its line completes.
  pendingLineBytes: Buffer;
  timer: ReturnType<typeof setInterval>;
  timeout: ReturnType<typeof setTimeout>;
}

function readBytesFrom(path: string, start: number, byteCount: number): Buffer {
  const buffer = Buffer.alloc(byteCount);
  const fileDescriptor = openSync(path, 'r');
  try {
    const bytesRead = readSync(fileDescriptor, buffer, 0, buffer.length, start);
    return buffer.subarray(0, bytesRead);
  } finally {
    closeSync(fileDescriptor);
  }
}

function splitCompleteLines(pendingLineBytes: Buffer, appended: Buffer): { lines: string[]; remainder: Buffer } {
  const combined = Buffer.concat([pendingLineBytes, appended]);
  const lastNewline = combined.lastIndexOf(NEWLINE_BYTE);
  if (lastNewline === -1) return { lines: [], remainder: combined };
  const lines = combined.subarray(0, lastNewline).toString('utf8').split('\n');
  return { lines, remainder: combined.subarray(lastNewline + 1) };
}

function fileIdentityOf(stats: { dev: number; ino: number }): string {
  return `${stats.dev}:${stats.ino}`;
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
const CLI_SESSION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// JSON.stringify escapes ASCII controls but passes C1 controls (U+0080-U+009F, incl. the CSI U+009B) and the U+2028/U+2029 line separators through.
const LINE_BREAKING_CHARACTERS_JSON_LEAVES_RAW = /[\u0080-\u009f\u2028\u2029]/g;

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
// The CLI may answer the submit Enter with its invisible-characters notice instead of sending. Nothing else is typed
// while the session is here, and the message is reported delivered only once the CLI accepted it (its turn started).
// 'watching': a body that may draw the notice was submitted, the notice has not shown yet.
// 'confirming': the notice showed; Enter is pressed after a settle delay, then again after each patience delay.
// 'clearing': the confirmations ran out with proof the composer still holds the paste; the first Escape of the pair
// that empties it was pressed.
// 'exhausted': the confirmations ran out without that proof; nothing is pressed, the queue stays gated until a turn
// starts or REVIEW_UNCONFIRMED_RELEASE_MS passes.
// The three flags are updated in place by the pty output (and raw input) read while the phase lasts.
interface ReviewingPhase {
  name: 'reviewing';
  messageId: string;
  handle: HarnessHandle;
  stage: 'watching' | 'confirming' | 'clearing' | 'exhausted';
  confirmations: number;
  isDeliveryRecorded: boolean;
  // Raw input typed meanwhile waits here, so it is never submitted together with the held message.
  deferredRaw: string[];
  // The notice was drawn again since the last confirmation Enter: the composer still holds the paste.
  isNoticeRedrawn: boolean;
  // The CLI drew its generating marker: it took the message.
  isGeneratingSeen: boolean;
  // A human Escape or Ctrl-C reached the pty: the composer is no longer the one the review knows.
  isHumanInterruptPassedThrough: boolean;
}
type DeliveryPhase =
  | { name: 'ready' }
  | { name: 'typing'; messageId: string; handle: HarnessHandle; deferredRaw: string[] }
  // ponytail: typed trusts the composer still holds the body and only ever adds the '\r' — if something
  // wiped the composer first, the empty submit is a no-op in the CLI and the message is counted delivered
  // but lost. Retyping would risk a doubled body, and Ctrl+U clears only one line of a multi-line body;
  // upgrade path is reading the composer back from the pty output before submitting.
  | TypedPhase
  | { name: 'submitted'; messageId: string }
  | ReviewingPhase
  | { name: 'closing' }
  | { name: 'relaunching' };

interface Delivery { phase: DeliveryPhase; timer?: ReturnType<typeof setTimeout>; failedAttempts: number }

const READY: DeliveryPhase = { name: 'ready' };

function waitForExit(handle: HarnessHandle): Promise<void> {
  return new Promise((resolve) => {
    const unsubscribe = handle.onExit(() => { unsubscribe(); resolve(); });
  });
}

function heldForReviewError(): OpenFleetError {
  return new OpenFleetError('message_held_for_review', 'the message was not sent: the CLI held it for review because it contains invisible characters and never confirmed it.', { hint: 'resend the message without invisible characters (zero-width spaces, direction marks, byte order marks).' });
}

// What the pty drew, without its escape sequences.
const textDrawnBy = (rawOutput: string) => rawOutput.replace(TERMINAL_ESCAPE_SEQUENCES, '');
const countMatches = (pattern: RegExp, rawOutput: string) => textDrawnBy(rawOutput).match(pattern)?.length ?? 0;

const LOW_SURROGATE_RANGE = { min: 0xdc00, max: 0xdfff };

// Reads the code and message of any thrown value (null, a primitive, an object with throwing getters) without ever throwing.
function readThrownDetail(thrown: unknown): string {
  try {
    const { code, message } = Object(thrown) as { code?: unknown; message?: unknown };
    return `${code ?? ''} ${message ?? ''}`.trim();
  } catch {
    return 'unreadable error';
  }
}

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
  // Messages the CLI held for review and the daemon gave up on: a replay of the same message_id must not report them delivered.
  // ponytail: in memory only, so a daemon restart forgets them and a replay then reads the stored status. Ceiling: a sender
  // that replays across a restart is told "delivered"; upgrade path is a 'failed' status in message_queue.
  private readonly abandonedMessageIds = new Set<string>();
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
  // Sessions between a /clear's SessionEnd and the end of its flush grace: a relaunch waits for the timer.
  private readonly clearsInFlight = new Map<string, ClearHold>();
  // When a SessionStart(clear) arrived with no hold running: its SessionEnd(clear) may still follow.
  private readonly clearStartedAt = new Map<string, number>();
  private readonly interruptWatches = new Map<string, InterruptWatch>();
  // Presence means "this launch has no recorded resolved model yet"; the value is the launch's start time
  // and whether its recording failure and its transcript name mismatch were already logged.
  private readonly pendingRecordings = new Map<string, { launchedAt: string; requestedModel: string | null; failureLogged: boolean; nameMismatchLogged: boolean; retryTimer?: ReturnType<typeof setTimeout> }>();
  // Sessions whose model was switched and whose relaunch has not happened yet: the resolved model the old
  // launch recorded stays visible until the relaunch really replaces the process.
  private readonly modelSwitchesAwaitingRelaunch = new Set<string>();
  // The relaunch clear wipes resolved_model even when the same alias is re-applied; this keeps that launch's id
  // for the drift comparison of the next recording. Absent when the switch changes the requested model.
  // ponytail: lost on a daemon restart between the relaunch and the recording; persist the last resolved id (a column) only if that gap matters.
  private readonly resolvedModelBeforeSameAliasRelaunch = new Map<string, { requestedModel: string | null; resolvedModel: string }>();
  // Set once closeAll() starts; refuses any new launch (create, reopen, resumeOne, a relaunch) so it can
  // never spawn a process outside closeAll's own snapshot and survive daemon shutdown.
  private shuttingDown = false;
  private readonly idsClosingForDaemonShutdown = new Set<string>();
  // The one place a close records why it is not a plain user close; markClosed forgets it. The reason is read from here when the exit is known.
  private readonly closeCauses = new Map<string, CloseCause>();
  // Cancels the wait a SessionEnd close gives the CLI to exit on its own (shutdown, a user close, the exit itself).
  private readonly cancelSessionEndGraces = new Map<string, () => void>();
  private readonly launchedAtBySessionId = new Map<string, number>();
  // Children their own parent asked to close, until the close lands: the parent already knows they ended.
  private readonly idsClosingByParent = new Set<string>();
  // The prompt the daemon handed each session at launch (a brief or a mission), for the process lifetime: a resume never replays it.
  private readonly seededPromptBySessionId = new Map<string, string>();

  constructor(private readonly deps: SessionServiceDeps) {
    this.repo = new SessionRepository(deps.db);
    this.queue = new MessageQueue(deps.db);
  }

  async create(spec: SessionSpec, options?: { branch?: string }): Promise<Session> {
    this.assertNotShuttingDown();
    const harness = this.harnessFor(spec.harness);
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
    this.warnIfPermissiveSettings(spec.harness, spec.directory);
    const seededPrompt = spec.seededPrompt?.trim();
    if (seededPrompt) this.seededPromptBySessionId.set(id, seededPrompt);
    this.startPendingRecording(id, spec.model);
    let handle: HarnessHandle;
    try {
      handle = harness.start({
        sessionId: id, directory: spec.directory, model: spec.model, seededPrompt: spec.seededPrompt,
        hookUrl: `${this.deps.baseUrl}/hooks/${hookToken}`, mcpUrl: `${this.deps.baseUrl}/mcp`, mcpToken, displayName: `${spec.emoji} ${spec.name}`,
        permissionMode: spec.permissionMode,
      });
    } catch (err) {
      // The row above already exists: left alone, it would be a ghost forever — starting, no handle,
      // unclosable and unreopenable. Same treatment as resumeOne's own launch failure.
      this.logLaunchFailure(`create: session ${id} failed to launch`, err);
      this.markClosed(id, { exitCode: RESUME_LAUNCH_FAILED_EXIT_CODE, reason: 'launch_failed', failure: err });
      throw err;
    }
    this.handles.set(id, handle);
    activeHandleBySessionId.set(id, handle);
    handle.onData((data) => {
      this.appendOutput(id, data);
      this.deps.bus.emit({ type: 'session.output', sessionId: id, data });
    });
    this.watchProcessExit(id, handle);
    // Same safety net resumeOne arms: a harness that starts but never reports a single real hook (SessionStart
    // included) leaves this session starting forever otherwise. A first launch gets its own, longer timeout
    // (firstStartTimeoutMs) since a cold real CLI can sit waiting on an auth or trust prompt (AUD-06).
    this.armFirstStartTimeout(id, handle);
    const session = this.repo.get(id)!;
    this.deps.bus.emit({ type: 'session.created', session });
    return session;
  }

  async createInWorktree(spec: SessionSpec & { repoPath: string; branchName: string }): Promise<Session> {
    this.harnessFor(spec.harness);
    const worktree = await createWorktree({ repoPath: spec.repoPath, branchName: spec.branchName, worktreesRoot: this.deps.worktreesRoot, env: this.deps.env });
    return this.create({ ...spec, directory: worktree.path }, { branch: worktree.branch });
  }

  hasQueuedMessage(sessionId: string, body: string): boolean {
    return this.queue.hasQueued(sessionId, body);
  }

  // Rewrites a queued message that no delivery has touched yet; false once it is typed, submitted or gone.
  replaceQueuedMessageBody(input: { sessionId: string; messageId: string; body: string }): boolean {
    const { phase } = this.deliveryOf(input.sessionId);
    const isBeingDelivered = (phase.name === 'typing' || phase.name === 'typed' || phase.name === 'reviewing') && phase.messageId === input.messageId;
    const isSubmittedAwaitingRecord = this.unrecordedDeliveries.get(input.sessionId) === input.messageId;
    if (isBeingDelivered || isSubmittedAwaitingRecord) return false;
    return this.queue.replaceQueuedBody(input.messageId, input.body);
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
        if (isSameSend && this.abandonedMessageIds.has(existing.id)) throw heldForReviewError();
        if (isSameSend) return { status: existing.status, messageId: existing.id };
        throw new MessageIdAlreadyUsedError(input.messageId);
      }
    }
    const { fromSessionId } = input;
    const isSenderAtPendingLimit = fromSessionId !== undefined
      && this.queue.countPendingFromSender({ sessionId: session.id, fromSessionId }) >= MAX_PENDING_AGENT_MESSAGES_PER_SENDER;
    if (isSenderAtPendingLimit) throw new TooManyPendingMessagesError(session.id);
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
    this.modelSwitchesAwaitingRelaunch.add(sessionId);
    this.deps.bus.emit({ type: 'session.model_changed', sessionId, model });
    return this.relaunchOrDefer(sessionId, session.state);
  }

  // Same relaunch machinery as updateModel: the mode is only picked up on the next --resume launch
  // (resolveResumePermissionMode), never typed into the terminal, so a busy session defers it instead.
  updatePermissionMode(sessionId: string, mode: PermissionMode): { status: 'relaunching' | 'deferred' } {
    this.assertNotShuttingDown();
    const session = this.requireOpen(sessionId);
    this.repo.setPermissionMode(sessionId, mode);
    this.deps.bus.emit({ type: 'session.permission_mode_changed', sessionId, mode });
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
    const isIdleConfirmed = canDeliverNow(state) && this.deliveryOf(sessionId).phase.name === 'ready' && !this.unfinishedTurns.has(sessionId) && !this.clearsInFlight.has(sessionId);
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
    this.assertDirectoryLaunchable(session);
    // Consumed with the 'starting' transition, like a boot resume: a failed launch then closes the row afresh and no boot retries it.
    const isClosedByShutdown = this.repo.wasClosedByDaemonShutdown(sessionId);
    const reopenedAt = new Date().toISOString();
    const reopenEventId = isClosedByShutdown ? this.repo.reopenFromShutdownClose(sessionId, reopenedAt) : this.repo.recordReopen(sessionId, reopenedAt);
    const outcome = this.resumeOne(session);
    if (!outcome.launched) {
      this.removeReopenRecord({ sessionId, reopenEventId });
      if (isNamedLaunchFailure(outcome.failure)) throw outcome.failure;
      const launchFailure = new SessionReopenError('launch_failed', `session ${sessionId} failed to relaunch: ${outcome.reason}`);
      carryLoggedRef(outcome.failure, launchFailure);
      throw launchFailure;
    }
    this.deps.bus.emit({ type: 'session.reopened', sessionId });
    return this.repo.get(sessionId)!;
  }

  // Every launch of a closed or interrupted row (reopen and boot resume) passes this: the directory exists, still
  // resolves where it did at creation, and is readable.
  private assertDirectoryLaunchable(session: Session): void {
    if (!existsSync(session.directory)) throw new SessionReopenError('directory_missing', `session ${session.id} directory no longer exists: ${session.directory}`);
    this.assertDirectoryUnchanged(session);
    this.assertDirectoryAccessible(session);
  }

  // The child stays closed with its old closed_at after a failed launch, so the reopen it announced must not stay.
  private removeReopenRecord(input: { sessionId: string; reopenEventId: number }): void {
    try {
      this.repo.removeReopen(input.reopenEventId);
    } catch (err) {
      log('warn', `reopen: the reopen record ${input.reopenEventId} of session ${input.sessionId} could not be removed after a failed launch`, err);
    }
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
      .catch((err) => log('error', `relaunch: session ${sessionId} could not be closed after a failed relaunch`, err))
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
        this.markClosed(sessionId, { reason: this.reasonOfRequestedClose(sessionId) });
        return;
      }
      if (this.modelSwitchesAwaitingRelaunch.delete(sessionId)) {
        this.rememberResolvedModelOfSameAlias(session);
        this.repo.clearResolvedModel(sessionId);
        this.deps.bus.emit({ type: 'session.updated', session: this.repo.get(sessionId)! });
      }
      const outcome = this.resumeOne(this.repo.get(sessionId)!);
      // A failed launch already marked the session closed (and stopped its delivery) inside resumeOne:
      // entering READY here would resurrect a delivery record for a session that is no longer open.
      if (outcome.launched) this.enter(sessionId, READY);
    } catch (err) {
      log('error', `relaunch: session ${sessionId} failed to relaunch after a model change`, err);
      await this.failResume(sessionId);
    }
  }

  // Revokes the old tokens first so the dying process's late hooks and MCP calls reach no session, then
  // forgets its handle before killing it: its exit must not trip markClosed, and nothing may kill it twice.
  private async retireForRelaunch(sessionId: string): Promise<void> {
    this.disarmInterruptWatch(sessionId);
    this.transcriptPaths.delete(sessionId);
    // Any approval still gating this session belonged to the process about to die: ApprovalService
    // listens for this to expire it and answer its waiting hook, rather than leave it pending forever
    // behind a relaunch it can never come back from (AUD-07).
    this.deps.bus.emit({ type: 'session.relaunching', sessionId });
    this.repo.setTokens(sessionId, newToken(), newToken());
    const handle = this.handles.get(sessionId);
    if (!handle) return;
    this.handles.delete(sessionId);
    activeHandleBySessionId.delete(sessionId);
    await this.killWithEscalation(handle, DEFAULT_CLOSE_ESCALATE_MS);
  }

  applyInput(sessionId: string, input: SessionInput): void {
    const session = this.require(sessionId);
    // The outgoing conversation's SessionEnd carries its old transcript; the SessionStart that follows names the new one.
    const endsOutgoingConversation = input.kind === 'hook' && isClear(input.event);
    if (endsOutgoingConversation) {
      if (this.consumeClearStartedJustBefore(sessionId)) this.holdRelaunchesFor(sessionId, this.deps.clearFlushGraceMs ?? DEFAULT_CLEAR_FLUSH_GRACE_MS, { isFlushGrace: true });
      else this.holdRelaunchesFor(sessionId, this.deps.clearInFlightTimeoutMs ?? DEFAULT_CLEAR_IN_FLIGHT_TIMEOUT_MS);
      return;
    }
    if (input.kind === 'hook' && input.event.transcript_path && isTrustedTranscriptPath(input.event.transcript_path)) {
      this.transcriptPaths.set(sessionId, input.event.transcript_path);
    }
    if (input.kind === 'hook' && input.event.hook_event_name === 'SessionStart') {
      this.adoptCliSessionId(sessionId, input.event.session_id);
      const hold = this.clearsInFlight.get(sessionId);
      const isWaitingForTheNewConversation = hold?.isFlushGrace === false;
      const startsBeforeTheSessionEndOfItsClear = hold === undefined && startsClearedConversation(input.event);
      if (startsBeforeTheSessionEndOfItsClear) this.clearStartedAt.set(sessionId, Date.now());
      if (isWaitingForTheNewConversation) this.holdRelaunchesFor(sessionId, this.deps.clearFlushGraceMs ?? DEFAULT_CLEAR_FLUSH_GRACE_MS, { isFlushGrace: true });
    }
    if (input.kind === 'hook' && input.event.hook_event_name === 'UserPromptSubmit') {
      this.repo.setCurrentConversationPrompted(sessionId, true);
    }
    this.recordResolvedModelIfPending(sessionId);
    // A new prompt means the previous turn is over from the user's side even when 'generating' ->
    // 'generating' is a no-op transition below (the CLI hadn't reported the previous turn's end yet): an
    // interrupt watch still armed for that turn must not survive to misjudge this one.
    // ponytail: a stray/duplicated UserPromptSubmit hook for the SAME turn disarms a genuine pending
    // ESC the same way a real new turn would (applyInput cannot tell the two apart), so that ESC is
    // dropped until idle_prompt or the next Stop. Upgrade path: compare the hook's user_prompt (or the
    // transcript's user entries) against the armed watch's turn before disarming.
    if (input.kind === 'hook' && input.event.hook_event_name === 'UserPromptSubmit') this.disarmInterruptWatch(sessionId);
    const endsUnfinishedTurn = provesTurnEnded(input) && this.unfinishedTurns.has(sessionId);
    if (endsUnfinishedTurn) this.unfinishedTurns.delete(sessionId);
    const state = nextState(session.state, input);
    if (state === session.state) {
      // A queued /clear never reports a turn start: its SessionStart is the only proof it was processed.
      const startsClearedConversationWhileClearSubmitted = input.kind === 'hook' && startsClearedConversation(input.event) && this.isAwaitingQueuedClear(sessionId);
      if (startsClearedConversationWhileClearSubmitted) this.enter(sessionId, READY);
      // The turn's start was never reported, but its end still releases a relaunch held behind it.
      if (startsClearedConversationWhileClearSubmitted || endsUnfinishedTurn) this.guarded(sessionId, () => this.advance(sessionId));
      return;
    }
    // Only a real state transition proves the (resumed) process is alive; an unrecognized Notification
    // that leaves the session in 'starting' must not cancel the safety net that would otherwise close it.
    this.clearResumeTimer(sessionId);
    // Any real transition away from 'generating' (Stop, a permission prompt, the idle_prompt self-heal,
    // the session closing) makes an armed interrupt watch moot — never let a late-firing one override it.
    this.disarmInterruptWatch(sessionId);
    // A reviewed message is only proven taken by a turn start (UserPromptSubmit lands in generating): any other transition
    // (input asked, a late Stop, the session ending) says nothing about a composer that still holds it, and leaves the review as it is.
    const { phase: deliveryPhase } = this.deliveryOf(sessionId);
    const isTurnStart = state === 'generating' || state === 'waiting_permission';
    if (deliveryPhase.name === 'reviewing') {
      if (isTurnStart) this.acceptReviewedMessage(sessionId, deliveryPhase);
    } else if (this.isAwaitingTurnStart(sessionId)) this.enter(sessionId, READY); // any real transition proves the submitted turn started
    if (state === 'closed') {
      // harness_exit means the process already died — markClosed only records it. Any other path to
      // closed (SessionEnd, etc.) is not proof the process actually exited, so it must go through the
      // real close() (kill, await exit, escalate to SIGKILL) or the PTY is orphaned.
      if (input.kind === 'harness_exit') this.markClosed(sessionId, { reason: this.reasonOfProcessExit(sessionId, undefined) });
      else void this.close(sessionId, { cause: 'session_end' });
      return;
    }
    const since = new Date().toISOString();
    this.repo.setState(sessionId, state, since);
    this.deps.bus.emit({ type: 'session.state', sessionId, state, stateSince: since });
    this.guarded(sessionId, () => this.advance(sessionId));
  }

  private watchProcessExit(sessionId: string, handle: HarnessHandle): void {
    this.launchedAtBySessionId.set(sessionId, this.now());
    handle.onExit((exitCode) => {
      if (activeHandleBySessionId.get(sessionId) !== handle) return; // a stale process we already replaced
      this.markClosed(sessionId, { exitCode, reason: this.reasonOfProcessExit(sessionId, exitCode) });
    });
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  private isAwaitingTurnStart(sessionId: string): boolean {
    return this.deliveryOf(sessionId).phase.name === 'submitted';
  }

  private isAwaitingQueuedClear(sessionId: string): boolean {
    const { phase } = this.deliveryOf(sessionId);
    if (phase.name !== 'submitted') return false;
    return this.queue.getById(phase.messageId)?.body.trim() === '/clear';
  }

  // A SessionStart(clear) that came before its SessionEnd(clear) is remembered for the length of a clear in flight.
  private consumeClearStartedJustBefore(sessionId: string): boolean {
    const startedAt = this.clearStartedAt.get(sessionId);
    this.clearStartedAt.delete(sessionId);
    const timeoutMs = this.deps.clearInFlightTimeoutMs ?? DEFAULT_CLEAR_IN_FLIGHT_TIMEOUT_MS;
    return startedAt !== undefined && Date.now() - startedAt <= timeoutMs;
  }

  private holdRelaunchesFor(sessionId: string, holdMs: number, options: { isFlushGrace: boolean } = { isFlushGrace: false }): void {
    this.releaseClearHold(sessionId);
    let end!: () => void;
    const ended = new Promise<void>((resolve) => { end = resolve; });
    const timer = setTimeout(() => {
      this.clearsInFlight.delete(sessionId);
      end();
      this.guarded(sessionId, () => this.advance(sessionId));
    }, holdMs);
    timer.unref();
    this.clearsInFlight.set(sessionId, { timer, isFlushGrace: options.isFlushGrace, ended, end });
  }

  private releaseClearHold(sessionId: string): void {
    const hold = this.clearsInFlight.get(sessionId);
    if (!hold) return;
    clearTimeout(hold.timer);
    this.clearsInFlight.delete(sessionId);
    hold.end();
  }

  // The CLI writes the new conversation's lines a moment after a /clear; a process killed inside that window leaves
  // a title-only stub the CLI refuses to resume. The wait is the flush grace itself, so it is bounded by it.
  private clearFlushOf(sessionId: string): Promise<void> | undefined {
    const hold = this.clearsInFlight.get(sessionId);
    return hold?.isFlushGrace ? hold.ended : undefined;
  }

  // The conversation the CLI process of this session is in: the launch id until a SessionStart reports another
  // one (a /clear starts a new CLI session inside the same process). The id outlives the process, so a relaunch
  // resumes it.
  private currentCliSessionIdOf(sessionId: string): string {
    return this.repo.cliSessionId(sessionId) ?? sessionId;
  }

  // A CLI session id that is another session's launch id or current id, open or closed, never becomes this session's:
  // otherwise one session's hook could adopt a neighbour's identity and then read its transcript. Ids a session
  // left behind stay reserved to it, also across a daemon restart.
  private adoptCliSessionId(sessionId: string, reportedCliSessionId: string): void {
    if (!CLI_SESSION_ID_PATTERN.test(reportedCliSessionId)) return;
    const cliSessionId = reportedCliSessionId.toLowerCase();
    if (this.repo.isCliSessionIdOfAnotherSession(sessionId, cliSessionId)) return;
    const opensAnotherConversation = cliSessionId !== this.currentCliSessionIdOf(sessionId);
    this.repo.setCliSessionId(sessionId, cliSessionId);
    if (opensAnotherConversation) this.repo.setCurrentConversationPrompted(sessionId, false);
  }

  private isTranscriptOfSession(sessionId: string, path: string): boolean {
    return basename(path).toLowerCase() === `${this.currentCliSessionIdOf(sessionId)}.jsonl`;
  }

  private warnOnceWhenTranscriptNameIsForeign(sessionId: string, path: string, pending: { nameMismatchLogged: boolean }): void {
    if (pending.nameMismatchLogged) return;
    pending.nameMismatchLogged = true;
    const expectedName = `${this.currentCliSessionIdOf(sessionId)}.jsonl`;
    log('warn', `resolved model: transcript name does not match the session's CLI id: session ${sessionId}, expected ${expectedName}, got ${JSON.stringify(basename(path).replace(LINE_BREAKING_CHARACTERS_JSON_LEAVES_RAW, ''))}`);
  }

  // One attempt per hook until the launch's resolution is found, plus one retry a moment after a hook whose
  // attempt found no assistant line: the CLI flushes its answer to the transcript shortly after it fires Stop.
  private recordResolvedModelIfPending(sessionId: string): void {
    const foundNoAssistantLineYet = this.attemptRecording(sessionId) === 'found-no-assistant-line';
    if (foundNoAssistantLineYet) this.scheduleRecordingRetry(sessionId);
  }

  private scheduleRecordingRetry(sessionId: string): void {
    const pending = this.pendingRecordings.get(sessionId);
    if (pending === undefined || pending.retryTimer !== undefined) return;
    pending.retryTimer = setTimeout(() => {
      pending.retryTimer = undefined;
      this.attemptRecording(sessionId);
    }, RECORDING_RETRY_DELAY_MS);
    pending.retryTimer.unref();
  }

  private startPendingRecording(sessionId: string, requestedModel: string | undefined): void {
    this.dropPendingRecording(sessionId);
    this.pendingRecordings.set(sessionId, { launchedAt: new Date().toISOString(), requestedModel: requestedModel ?? null, failureLogged: false, nameMismatchLogged: false });
  }

  private dropPendingRecording(sessionId: string): void {
    clearTimeout(this.pendingRecordings.get(sessionId)?.retryTimer);
    this.pendingRecordings.delete(sessionId);
  }

  // The clear that follows a model switch wipes the row even when the alias is unchanged: the id resolved under that
  // same alias is kept for the drift comparison of the next recording. An id resolved under another alias is not.
  private rememberResolvedModelOfSameAlias(session: Session): void {
    const requestedModel = session.model ?? null;
    if (this.resolvedModelBeforeSameAliasRelaunch.get(session.id)?.requestedModel !== requestedModel) this.resolvedModelBeforeSameAliasRelaunch.delete(session.id);
    const resolvedUnderSameAlias = this.repo.resolvedModelUnderAlias({ id: session.id, requestedModel });
    if (resolvedUnderSameAlias === undefined) return;
    this.resolvedModelBeforeSameAliasRelaunch.set(session.id, { requestedModel, resolvedModel: resolvedUnderSameAlias });
  }

  // The session's own earlier id, resolved under the alias of this launch, wins over another session's: a relaunch is compared with itself first.
  private findDrift(sessionId: string, resolvedModel: string, requestedModel: string | null): { previousModel: string; comparedWith: 'same session relaunched' | { previousSessionId: string } } | undefined {
    const rememberedBeforeRelaunch = this.resolvedModelBeforeSameAliasRelaunch.get(sessionId);
    const rememberedUnderThisAlias = rememberedBeforeRelaunch?.requestedModel === requestedModel ? rememberedBeforeRelaunch.resolvedModel : undefined;
    const ownPreviousModel = this.repo.resolvedModelUnderAlias({ id: sessionId, requestedModel }) ?? rememberedUnderThisAlias;
    const previousOther = ownPreviousModel === undefined ? this.repo.previousResolvedModel({ requestedModel, excludedSessionId: sessionId }) : undefined;
    const previous = ownPreviousModel !== undefined
      ? { previousModel: ownPreviousModel, comparedWith: 'same session relaunched' as const }
      : previousOther && { previousModel: previousOther.resolvedModel, comparedWith: { previousSessionId: previousOther.sessionId } };
    const hasDrifted = previous !== undefined && previous.previousModel !== resolvedModel;
    return hasDrifted ? previous : undefined;
  }

  private logDrift(sessionId: string, resolution: { resolvedModel: string; cliVersion: string }, requestedModel: string | null, drift: NonNullable<ReturnType<SessionService['findDrift']>>): void {
    const comparedWith = drift.comparedWith === 'same session relaunched' ? drift.comparedWith : `previous session ${drift.comparedWith.previousSessionId}`;
    const requested = requestedModel === null ? 'the default model' : JSON.stringify(requestedModel);
    log('warn', `model drift: ${requested} resolves to ${resolution.resolvedModel}, previously ${drift.previousModel} (session ${sessionId}, ${comparedWith}, cli ${resolution.cliVersion})`);
  }

  // Never throws into the hook handler.
  private attemptRecording(sessionId: string): 'found-no-assistant-line' | undefined {
    const pending = this.pendingRecordings.get(sessionId);
    const transcriptPath = this.transcriptPaths.get(sessionId);
    if (pending === undefined || transcriptPath === undefined) return undefined;
    try {
      if (!isTrustedTranscriptPath(transcriptPath)) return undefined;
      if (!this.isTranscriptOfSession(sessionId, transcriptPath)) {
        this.warnOnceWhenTranscriptNameIsForeign(sessionId, transcriptPath, pending);
        return undefined;
      }
      // Reading the resolved path, not the reported one, closes the window between the check and the open.
      const resolvedPath = existsSync(transcriptPath) ? realpathSync(transcriptPath) : transcriptPath;
      if (!this.isTranscriptOfSession(sessionId, resolvedPath)) {
        this.warnOnceWhenTranscriptNameIsForeign(sessionId, resolvedPath, pending);
        return undefined;
      }
      const resolution = findResolvedModel(readTranscriptTail(resolvedPath), pending.launchedAt);
      if (!resolution) return 'found-no-assistant-line';
      const { requestedModel } = pending;
      const drift = this.findDrift(sessionId, resolution.resolvedModel, requestedModel);
      this.repo.recordResolvedModel({ id: sessionId, ...resolution, requestedModel, driftedFrom: drift?.previousModel ?? null });
      this.resolvedModelBeforeSameAliasRelaunch.delete(sessionId);
      if (drift) this.logDrift(sessionId, resolution, requestedModel, drift);
      this.dropPendingRecording(sessionId);
      this.deps.bus.emit({ type: 'session.updated', session: this.repo.get(sessionId)! });
      return undefined;
    } catch (err) {
      if (pending.failureLogged) return undefined;
      pending.failureLogged = true;
      log('error', `resolved model: session ${sessionId} could not record its resolved model`, err);
      return undefined;
    }
  }

  // Display-only measure of the context of the session's current conversation, from the same trusted transcript
  // as the resolved model. Never throws: no trusted readable transcript, or no usable line, is undefined.
  contextTokensOfLatestTurn(sessionId: string): number | undefined {
    const transcriptPath = this.transcriptPaths.get(sessionId);
    if (transcriptPath === undefined) return undefined;
    try {
      if (!isTrustedTranscriptPath(transcriptPath) || !this.isTranscriptOfSession(sessionId, transcriptPath)) return undefined;
      const resolvedPath = existsSync(transcriptPath) ? realpathSync(transcriptPath) : transcriptPath;
      if (!this.isTranscriptOfSession(sessionId, resolvedPath)) return undefined;
      return findLatestContextTokens(readTranscriptTail(resolvedPath));
    } catch (err) {
      log('warn', `context notice: session ${sessionId} transcript could not be read: ${err instanceof Error ? err.message : String(err)}`);
      return undefined;
    }
  }

  setContextNoticeTokens(sessionId: string, tokens: number | null): void {
    this.repo.setContextNoticeTokens(sessionId, tokens);
    this.deps.bus.emit({ type: 'session.updated', session: this.repo.get(sessionId)! });
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
    if (phase.name === 'reviewing') {
      // Typed text would be submitted together with the held message by the confirmation Enter: it waits for the review's end.
      // An Escape or Ctrl-C is the human's intent to interrupt and goes through at once, after what was typed before it.
      const isInterruptIntent = INTERRUPT_KEYS.some((key) => data.includes(key));
      if (!isInterruptIntent) {
        phase.deferredRaw.push(data);
        return;
      }
      phase.isHumanInterruptPassedThrough = true;
      this.flushDeferredRaw(sessionId, handle, phase.deferredRaw.splice(0));
    }
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
    let fileIdentity: string | null;
    try {
      const stats = statSync(transcriptPath);
      offset = stats.size;
      fileIdentity = fileIdentityOf(stats);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') return;
      offset = 0; // no transcript file yet; poll from offset 0 once it's created
      fileIdentity = null;
    }
    const timer = setInterval(() => this.pollInterruptWatch(sessionId), TRANSCRIPT_INTERRUPT_POLL_MS);
    const timeout = setTimeout(() => this.disarmInterruptWatch(sessionId), TRANSCRIPT_INTERRUPT_TIMEOUT_MS);
    this.interruptWatches.set(sessionId, { transcriptPath, offset, fileIdentity, pendingLineBytes: Buffer.alloc(0), timer, timeout });
  }

  // Reads only the bytes appended since the watch armed (or since the last poll), at most
  // TRANSCRIPT_INTERRUPT_MAX_READ_BYTES per poll, never re-scanning the whole transcript. Raw bytes are
  // carried across polls and decoded only as complete lines, so a multi-byte character straddling a poll
  // boundary is decoded whole.
  //
  // A file replaced by another one (new inode) holds turns that were already over: the watch skips to its
  // current end. A file truncated in place is still the CLI's own file: what follows the truncation is new.
  //
  // This is a setInterval callback with nothing above it to catch a throw — an uncaught exception here
  // would crash the whole daemon, taking down every other session's watch with it. isInterruptedTranscriptLine
  // is itself total, but the try/catch is the backstop for anything else in the parse-and-match step
  // (e.g. a future change to it, or to this method) that might not be.
  private pollInterruptWatch(sessionId: string): void {
    try {
      this.pollInterruptWatchUnsafe(sessionId);
    } catch (err) {
      log('error', `interrupt watch: session ${sessionId} poll failed unexpectedly`, err);
    }
  }

  private pollInterruptWatchUnsafe(sessionId: string): void {
    const watch = this.interruptWatches.get(sessionId);
    if (!watch) return;
    let stats: Stats;
    try {
      stats = statSync(watch.transcriptPath);
    } catch {
      return; // e.g. the transcript file vanished this tick; treat as nothing this tick, keep polling until the timeout
    }
    const currentIdentity = fileIdentityOf(stats);
    const transcriptWasReplaced = watch.fileIdentity !== null && watch.fileIdentity !== currentIdentity;
    watch.fileIdentity = currentIdentity;
    if (transcriptWasReplaced) {
      watch.offset = stats.size;
      watch.pendingLineBytes = Buffer.alloc(0);
      return;
    }
    const transcriptWasTruncated = stats.size < watch.offset;
    if (transcriptWasTruncated) {
      watch.offset = 0;
      watch.pendingLineBytes = Buffer.alloc(0);
    }
    const unreadBytes = stats.size - watch.offset;
    if (unreadBytes <= 0) return;
    let appended: Buffer;
    try {
      appended = readBytesFrom(watch.transcriptPath, watch.offset, Math.min(unreadBytes, TRANSCRIPT_INTERRUPT_MAX_READ_BYTES));
    } catch {
      return; // e.g. a transient permission/read error; treat as nothing this tick, keep polling until the timeout
    }
    watch.offset += appended.length;
    const { lines, remainder } = splitCompleteLines(watch.pendingLineBytes, appended);
    const carriedLineIsTooLong = remainder.length > TRANSCRIPT_INTERRUPT_MAX_CARRIED_LINE_BYTES;
    watch.pendingLineBytes = carriedLineIsTooLong ? Buffer.alloc(0) : remainder;
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
  isClosingByParent(sessionId: string): boolean {
    return this.idsClosingByParent.has(sessionId);
  }

  async close(sessionId: string, options?: { escalateAfterMs?: number; closedByParent?: boolean; cause?: CloseCause }): Promise<void> {
    const isSessionEndOfACloseAlreadyRequested = options?.cause === 'session_end' && this.isCloseRequested(sessionId);
    if (isSessionEndOfACloseAlreadyRequested) return;
    if (options?.closedByParent) this.idsClosingByParent.add(sessionId);
    const isExplicitClose = options?.cause === undefined;
    if (isExplicitClose) this.idsClosingForDaemonShutdown.delete(sessionId); // someone asked: the close is theirs, not the shutdown's
    this.recordCloseCause(sessionId, options?.cause);
    // A requested close owns the exit from here on: a start timeout still armed would kill again and close as resume_timeout.
    this.clearResumeTimer(sessionId);
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
    // Entered before the flush grace is awaited: nothing is typed or submitted once the close was requested.
    if (this.handles.has(sessionId)) this.enter(sessionId, { name: 'closing' });
    const clearFlush = this.clearFlushOf(sessionId);
    if (clearFlush) await clearFlush;
    const handle = this.handles.get(sessionId);
    if (!handle) {
      // No process to kill (this instance never launched or resumed one for this row), but the caller
      // still asked this session closed: markClosed is itself a no-op for an unknown or already-closed
      // id (MIN-04), so this only ever closes a real open-but-handle-less row instead of leaving it stuck.
      if (isExplicitClose) this.repo.clearShutdownClose(sessionId); // a close the user asks for on a row the shutdown closed wins over its resume
      this.markClosed(sessionId, { reason: this.reasonOfRequestedClose(sessionId) });
      return;
    }
    if (options?.cause === 'session_end') {
      const exitedOnItsOwn = await this.waitForExitWithinGrace(sessionId, handle);
      const isStillTheLiveProcess = this.handles.get(sessionId) === handle;
      const anotherCloseOwnsTheKill = this.closeCauses.get(sessionId) !== 'session_end';
      if (exitedOnItsOwn || !isStillTheLiveProcess || anotherCloseOwnsTheKill) return;
      // The CLI ended its session but never exited: this kill is the daemon's own, so its exit is no failure.
      this.forgetSessionEndCause(sessionId);
    }
    await this.killWithEscalation(handle, options?.escalateAfterMs ?? DEFAULT_CLOSE_ESCALATE_MS);
  }

  // The CLI's own SessionEnd, fired because the daemon killed it, is the echo of a close somebody already asked for.
  private isCloseRequested(sessionId: string): boolean {
    const isClosing = this.deliveryOf(sessionId).phase.name === 'closing';
    return isClosing || this.idsClosingByParent.has(sessionId) || this.closeCauses.get(sessionId) === 'shutdown';
  }

  // Shutdown outranks every other cause; any other close (a user, a parent, a relaunch) means someone asked, so it drops a pending session_end.
  private recordCloseCause(sessionId: string, cause: CloseCause | undefined): void {
    const isShuttingDown = this.closeCauses.get(sessionId) === 'shutdown';
    if (isShuttingDown) return;
    if (cause) this.closeCauses.set(sessionId, cause);
    else this.closeCauses.delete(sessionId);
    if (cause !== 'session_end') this.cancelSessionEndGraces.get(sessionId)?.();
  }

  private forgetSessionEndCause(sessionId: string): void {
    if (this.closeCauses.get(sessionId) === 'session_end') this.closeCauses.delete(sessionId);
  }

  // Resolves true when the process exits on its own within the grace, false when the grace ends or is cancelled.
  private waitForExitWithinGrace(sessionId: string, handle: HarnessHandle): Promise<boolean> {
    const graceMs = this.deps.sessionEndExitGraceMs ?? SESSION_END_EXIT_GRACE_MS;
    return new Promise((resolve) => {
      const finish = (exitedOnItsOwn: boolean) => {
        clearTimeout(timer);
        unsubscribe();
        this.cancelSessionEndGraces.delete(sessionId);
        resolve(exitedOnItsOwn);
      };
      const timer = setTimeout(() => finish(false), graceMs);
      const unsubscribe = handle.onExit(() => finish(true));
      this.cancelSessionEndGraces.set(sessionId, () => finish(false));
    });
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
    // A session the user already asked to close stays the user's close: only the rest are marked for the next boot.
    const idsInterruptedByShutdown = [...openSessionIds].filter((id) => this.deliveryOf(id).phase.name !== 'closing');
    for (const id of idsInterruptedByShutdown) this.idsClosingForDaemonShutdown.add(id);
    await Promise.all([...openSessionIds].map((id) => this.close(id, { cause: 'shutdown' })));
  }
  get(id: string): Session | undefined { return this.repo.get(id); }
  list(): Session[] { return this.repo.list(); }
  directoryRealpathOf(id: string): string | null | undefined { return this.repo.directoryRealpath(id); }
  /** Returns true when the prompt is the one the daemon launched the session with; the CLI may append to it. */
  isSeededPrompt(sessionId: string, prompt: string): boolean {
    const seededPrompt = this.seededPromptBySessionId.get(sessionId);
    return seededPrompt !== undefined && prompt.trim().startsWith(seededPrompt);
  }

  byHookToken(token: string): Session | undefined { return this.repo.byHookToken(token); }
  transcriptPathOf(id: string): string | undefined { return this.transcriptPaths.get(id); }
  byMcpToken(token: string): Session | undefined { return this.repo.byMcpToken(token); }

  // Boot resume decides here which rows come back: every row still open (a daemon killed without a graceful
  // close) and every row whose latest close was the daemon's own shutdown. A user close, a failed resume or a
  // session closed before the shutdown stays closed.
  async resumeAll(): Promise<void> {
    for (const { id } of this.repo.list()) {
      const session = this.repo.get(id); // read again: a close that landed while an earlier row was resuming wins
      if (!session) continue;
      const wasInterruptedByShutdown = session.state === 'closed' && this.repo.wasClosedByDaemonShutdown(session.id);
      if (session.state === 'closed' && !wasInterruptedByShutdown) continue;
      if (this.handles.has(session.id)) continue; // already resumed by an earlier resumeAll() on this instance
      // Back to 'starting' before the launch: a failed resume then closes the row afresh (new closed_at, exit code),
      // which is what stops the next boot from retrying it.
      try {
        if (wasInterruptedByShutdown) this.repo.resumeFromShutdownClose(session.id, new Date().toISOString());
        this.assertDirectoryLaunchable(session);
        this.resumeOne(session);
      } catch (err) {
        // A failure anywhere past the launch itself (e.g. the state-machine DB write) must not abort
        // resuming the rest of the fleet — kill the process we already launched and move on.
        log('warn', `resume: session ${session.id} is closed instead of resumed: ${readThrownDetail(err)}`);
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
        log('error', `resume: session ${sessionId} could not kill its process after a resume error`, err);
      }
    }
    const closure: SessionClosure = { exitCode: RESUME_LAUNCH_FAILED_EXIT_CODE, reason: 'launch_failed' };
    try {
      // A transition that rolled back leaves the row closed with its shutdown marker: markClosed skips a closed row, so the marker is rewritten here.
      const isStillClosedByShutdown = this.repo.wasClosedByDaemonShutdown(sessionId);
      if (isStillClosedByShutdown) {
        this.rewriteClosedRowAsFailedLaunch(sessionId, closure);
        return;
      }
      this.markClosed(sessionId, closure);
    } catch (err) {
      // The close's own DB write can itself fail; one bad row's cleanup must not stop the rest of the fleet.
      log('error', `resumeAll: failed to close session ${sessionId} after a resume error`, err);
    }
  }

  // ponytail: 200 KB ring buffer, persist scrollback to disk if replays matter more
  private appendOutput(sessionId: string, data: string): void {
    const previousOutput = this.outputBuffers.get(sessionId) ?? '';
    const combined = previousOutput + data;
    this.outputBuffers.set(sessionId, trimToTail(combined, OUTPUT_BUFFER_LIMIT));
    // Only what this chunk added counts: a notice the margin still holds from an earlier chunk is not drawn again.
    const drawnAgain = (pattern: RegExp) => {
      const inThisChunkAndMargin = countMatches(pattern, combined.slice(-(data.length + REVIEW_NOTICE_SPLIT_ACROSS_CHUNKS_MARGIN)));
      const inMarginAlone = countMatches(pattern, previousOutput.slice(-REVIEW_NOTICE_SPLIT_ACROSS_CHUNKS_MARGIN));
      return inThisChunkAndMargin > inMarginAlone;
    };
    const isNoticeDrawn = drawnAgain(INVISIBLE_CHARACTERS_REVIEW_NOTICE);
    const isGeneratingMarkerDrawn = drawnAgain(GENERATING_MARKER);
    if (!isNoticeDrawn && !isGeneratingMarkerDrawn) return;
    const { phase } = this.deliveryOf(sessionId);
    if (phase.name === 'reviewing') {
      phase.isNoticeRedrawn ||= isNoticeDrawn;
      phase.isGeneratingSeen ||= isGeneratingMarkerDrawn;
    }
    if (isNoticeDrawn) this.startConfirmingReview(sessionId);
  }

  // The notice is redrawn as often as the CLI repaints: only the first one of a submitted message starts the confirmations.
  private startConfirmingReview(sessionId: string): void {
    const { phase } = this.deliveryOf(sessionId);
    const handle = this.liveHandle(sessionId);
    if (!handle) return;
    const isReviewOfSubmittedMessage = phase.name === 'submitted';
    const isReviewOfWatchedMessage = phase.name === 'reviewing' && phase.stage === 'watching';
    if (!isReviewOfSubmittedMessage && !isReviewOfWatchedMessage) return;
    // A message that quotes the notice's own words makes the CLI's echo of it look like the notice.
    const isEchoOfTheBody = isReviewOfSubmittedMessage && countMatches(INVISIBLE_CHARACTERS_REVIEW_NOTICE, this.queue.getById(phase.messageId)?.body ?? '') > 0;
    if (isEchoOfTheBody) return;
    const carried = isReviewOfWatchedMessage ? phase : undefined;
    const settle = this.schedule(sessionId, REVIEW_SETTLE_MS, () => this.confirmReview(sessionId));
    this.enter(sessionId, {
      name: 'reviewing', messageId: phase.messageId, handle, stage: 'confirming', confirmations: 0, isDeliveryRecorded: isReviewOfSubmittedMessage,
      deferredRaw: carried?.deferredRaw ?? [], isNoticeRedrawn: false, isGeneratingSeen: carried?.isGeneratingSeen ?? false, isHumanInterruptPassedThrough: carried?.isHumanInterruptPassedThrough ?? false,
    }, settle);
  }

  private confirmReview(sessionId: string): void {
    const { phase } = this.deliveryOf(sessionId);
    if (phase.name !== 'reviewing' || phase.stage !== 'confirming') return;
    const isHandleReplaced = this.liveHandle(sessionId) !== phase.handle;
    if (isHandleReplaced) {
      this.enter(sessionId, READY);
      return;
    }
    const isOutOfConfirmations = phase.confirmations >= MAX_REVIEW_CONFIRMATIONS;
    if (isOutOfConfirmations) {
      this.endConfirmations(sessionId, phase);
      return;
    }
    phase.isNoticeRedrawn = false;
    phase.handle.write('\r');
    const patience = this.schedule(sessionId, REVIEW_CONFIRMATION_PATIENCE_MS, () => this.confirmReview(sessionId));
    this.enter(sessionId, { ...phase, confirmations: phase.confirmations + 1 }, patience);
  }

  // Only a notice drawn again after the last Enter, with no sign the CLI took the message, proves the composer still holds the paste.
  private endConfirmations(sessionId: string, phase: ReviewingPhase): void {
    const isComposerProvenHeld = phase.isNoticeRedrawn && !phase.isGeneratingSeen && !phase.isHumanInterruptPassedThrough;
    if (isComposerProvenHeld) {
      this.clearStuckComposer(sessionId, phase);
      return;
    }
    const release = this.schedule(sessionId, REVIEW_UNCONFIRMED_RELEASE_MS, () => this.releaseUnconfirmedReview(sessionId));
    this.enter(sessionId, { ...phase, stage: 'exhausted' }, release);
  }

  private releaseUnconfirmedReview(sessionId: string): void {
    const { phase } = this.deliveryOf(sessionId);
    if (phase.name !== 'reviewing' || phase.stage !== 'exhausted') return;
    this.giveUpOnReview(sessionId, phase);
  }

  // Claude Code empties its composer on two Escapes in a row; one alone leaves the text.
  private clearStuckComposer(sessionId: string, phase: ReviewingPhase): void {
    phase.handle.write(ESCAPE_KEY);
    const secondEscape = this.schedule(sessionId, COMPOSER_CLEAR_GAP_MS, () => this.abandonReview(sessionId));
    this.enter(sessionId, { ...phase, stage: 'clearing' }, secondEscape);
  }

  private abandonReview(sessionId: string): void {
    const { phase } = this.deliveryOf(sessionId);
    if (phase.name !== 'reviewing' || phase.stage !== 'clearing') return;
    const isHandleReplaced = this.liveHandle(sessionId) !== phase.handle;
    const isTakenByTheCliMeanwhile = phase.isGeneratingSeen || phase.isHumanInterruptPassedThrough;
    if (!isHandleReplaced && !isTakenByTheCliMeanwhile) phase.handle.write(ESCAPE_KEY);
    this.giveUpOnReview(sessionId, phase);
  }

  private giveUpOnReview(sessionId: string, phase: ReviewingPhase): void {
    this.unfinishedTurns.delete(sessionId);
    this.enter(sessionId, READY);
    this.releaseDeferredRaw(sessionId, phase);
    // Out of the queue, or it is typed again and again: it was not submitted, so no message.delivered follows.
    try {
      if (!phase.isDeliveryRecorded) this.queue.markDelivered(phase.messageId);
    } catch (err) {
      log('error', `delivery: session ${sessionId} could not take the unsent message ${phase.messageId} out of the queue`, err);
    }
    this.abandonedMessageIds.add(phase.messageId);
    this.announceError(sessionId, heldForReviewError(), 'delivery failed');
    this.advance(sessionId);
  }

  // What the human typed during the review goes to the pty now, on the handle that held the message (never on a replaced one).
  private releaseDeferredRaw(sessionId: string, phase: ReviewingPhase): void {
    const isHandleReplaced = this.liveHandle(sessionId) !== phase.handle;
    const deferredRaw = phase.deferredRaw.splice(0);
    if (!isHandleReplaced) this.flushDeferredRaw(sessionId, phase.handle, deferredRaw);
  }

  // The turn the CLI started proves it accepted the Enter: only now a reviewed message counts as delivered.
  private acceptReviewedMessage(sessionId: string, phase: ReviewingPhase): void {
    this.enter(sessionId, READY);
    this.releaseDeferredRaw(sessionId, phase);
    if (phase.isDeliveryRecorded) return;
    this.unrecordedDeliveries.set(sessionId, phase.messageId);
    try {
      this.recordDelivery(sessionId);
    } catch (err) {
      log('error', `delivery: session ${sessionId} submitted message ${phase.messageId}, recording it failed and is retried before the next message`, err);
    }
  }

  // Moves the session's delivery as far as it can go right now. Nothing is typed or submitted unless the
  // session is deliverable (idle, or waiting_input: the CLI waits on its composer) — never into a running
  // turn (Review Focus #4) nor onto a permission prompt (Review Focus #1).
  private advance(sessionId: string): void {
    const session = this.repo.get(sessionId);
    const isDeliverable = session !== undefined && canDeliverNow(session.state);
    if (!isDeliverable) return;
    const { phase, failedAttempts } = this.deliveryOf(sessionId);
    if (phase.name === 'typed') this.submit(sessionId, phase);
    // A review whose step threw keeps its phase: the retry resumes it (a review that is not failing is moved by its own timer).
    const isReviewStepFailed = phase.name === 'reviewing' && failedAttempts > 0;
    if (isReviewStepFailed && phase.stage === 'confirming') this.confirmReview(sessionId);
    if (isReviewStepFailed && phase.stage === 'clearing') this.abandonReview(sessionId);
    if (phase.name !== 'ready') return;
    // A deferred relaunch always wins over the next queued message: it was requested first, and typing
    // into a handle we're about to kill would just be retyped into the resumed one anyway.
    const isRelaunchPending = this.pendingRelaunches.has(sessionId);
    const isTurnUnfinished = this.unfinishedTurns.has(sessionId);
    const isClearInFlight = this.clearsInFlight.has(sessionId);
    if (isRelaunchPending && (isTurnUnfinished || isClearInFlight)) return;
    if (isRelaunchPending) this.startRelaunch(sessionId);
    else this.typeNextMessage(sessionId);
  }

  // ponytail: one message per turn; batch delivery if queues grow
  private typeNextMessage(sessionId: string): void {
    this.recordDelivery(sessionId);
    const handle = this.liveHandle(sessionId);
    if (!handle) return;
    // A daemon line ([pulse]) never lands in the composer of a session waiting on the human's answer.
    const isWaitingOnHuman = this.repo.get(sessionId)?.state === 'waiting_input';
    const message = this.queue.nextPending(sessionId, { skipDaemonLines: isWaitingOnHuman });
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
    this.unfinishedTurns.add(sessionId);
    if (this.mayDrawReviewNotice(phase.messageId)) {
      this.watchForReviewNotice(sessionId, phase); // the deferred raw input rides on the review and is flushed when it ends
      return;
    }
    this.commitSubmission(sessionId, phase.messageId);
    // Flushed right after the Enter, in arrival order: whatever was deferred behind this message now goes
    // straight through, on the same handle that just received the Enter. The delivery above is already
    // committed, so a throwing write here only drops the rest of this best-effort flush.
    this.flushDeferredRaw(sessionId, phase.handle, phase.deferredRaw);
  }

  private commitSubmission(sessionId: string, messageId: string): void {
    this.unrecordedDeliveries.set(sessionId, messageId);
    const turnStartTimeout = this.schedule(sessionId, TURN_START_TIMEOUT_MS, () => this.stopAwaitingTurnStart(sessionId));
    this.enter(sessionId, { name: 'submitted', messageId }, turnStartTimeout);
    try {
      this.recordDelivery(sessionId);
    } catch (err) {
      log('error', `delivery: session ${sessionId} submitted message ${messageId}, recording it failed and is retried before the next message`, err);
    }
  }

  private mayDrawReviewNotice(messageId: string): boolean {
    const body = this.queue.getById(messageId)?.body ?? '';
    return MAY_BE_STRIPPED_BY_THE_CLI.test(body.replace(/[\n\r\t]/g, ''));
  }

  // The notice follows the Enter within milliseconds; once its window passed without one, the CLI took the body as is.
  private watchForReviewNotice(sessionId: string, phase: TypedPhase): void {
    const window = this.schedule(sessionId, REVIEW_NOTICE_WINDOW_MS, () => this.settleWithoutNotice(sessionId));
    this.enter(sessionId, {
      name: 'reviewing', messageId: phase.messageId, handle: phase.handle, stage: 'watching', confirmations: 0, isDeliveryRecorded: false,
      deferredRaw: phase.deferredRaw, isNoticeRedrawn: false, isGeneratingSeen: false, isHumanInterruptPassedThrough: false,
    }, window);
  }

  private settleWithoutNotice(sessionId: string): void {
    const { phase } = this.deliveryOf(sessionId);
    if (phase.name !== 'reviewing' || phase.stage !== 'watching') return;
    const isHandleReplaced = this.liveHandle(sessionId) !== phase.handle;
    if (isHandleReplaced) {
      this.enter(sessionId, READY);
      return;
    }
    this.commitSubmission(sessionId, phase.messageId);
    this.releaseDeferredRaw(sessionId, phase);
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
        log('error', `delivery: session ${sessionId} failed to flush deferred raw input, dropping what's left`, err);
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
      log('error', `delivery: session ${sessionId} delivered message ${messageId}, but a message.delivered listener failed`, err);
    }
  }

  // A body the CLI may have held for review, with no turn started: whatever notice it drew (unknown wording, hidden by the
  // terminal width), the composer may still hold it, so the queue stays gated one more step and nothing is pressed.
  private stopAwaitingTurnStart(sessionId: string): void {
    const { phase } = this.deliveryOf(sessionId);
    const handle = this.liveHandle(sessionId);
    const isUnprovenReview = phase.name === 'submitted' && handle !== undefined && this.mayDrawReviewNotice(phase.messageId);
    if (isUnprovenReview) {
      const release = this.schedule(sessionId, REVIEW_UNCONFIRMED_RELEASE_MS, () => this.releaseUnconfirmedReview(sessionId));
      this.enter(sessionId, {
        name: 'reviewing', messageId: phase.messageId, handle, stage: 'exhausted', confirmations: 0, isDeliveryRecorded: true,
        deferredRaw: [], isNoticeRedrawn: false, isGeneratingSeen: false, isHumanInterruptPassedThrough: false,
      }, release);
      return;
    }
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
    if (isNewFailureStreak) {
      log('error', `delivery: session ${sessionId} failed, its message stays queued`, err);
      this.announceError(sessionId, new OpenFleetError('delivery_failed', 'the message could not be delivered and stays queued.', { hint: 'the daemon retries on its own; reopen the session if it keeps failing.' }), 'delivery failed');
    }
    // Past the last fast retry the machine parks on the slow PARKED_RETRY_MS; a state transition advances it sooner.
    const isParked = failedAttempts > MAX_DELIVERY_RETRIES;
    const retryDelayMs = isParked ? PARKED_RETRY_MS : DELIVERY_RETRY_MS;
    const retry = this.handles.has(sessionId) ? this.schedule(sessionId, retryDelayMs, () => this.advance(sessionId)) : undefined;
    clearTimeout(delivery.timer);
    this.deliveries.set(sessionId, { ...delivery, timer: retry, failedAttempts });
  }

  // The reason is decided by who asked for the close. A close nobody asked for (the process died on its own) is a
  // harness exit only when it failed, and so is the exit of a CLI that ended its own session; a user's own close is never a failure.
  private reasonOfProcessExit(sessionId: string, exitCode: number | undefined): SessionCloseReason | undefined {
    const isFailureExit = exitCode !== undefined && exitCode !== 0;
    const cause = this.closeCauses.get(sessionId);
    if (cause === 'shutdown') return 'daemon_shutdown';
    if (cause === 'session_end') return isFailureExit ? 'harness_exit' : 'closed_by_user';
    const isCloseRequested = this.deliveryOf(sessionId).phase.name === 'closing' || this.idsClosingByParent.has(sessionId);
    if (isCloseRequested) return 'closed_by_user';
    return isFailureExit ? 'harness_exit' : undefined;
  }

  // A close with no process exit to read (nothing to kill): the reason is only who asked.
  private reasonOfRequestedClose(sessionId: string): SessionCloseReason {
    return this.closeCauses.get(sessionId) === 'shutdown' ? 'daemon_shutdown' : 'closed_by_user';
  }

  // Best effort: an announcement that cannot be built or sent never stops the launch, close or delivery flow that raised it.
  // Returns the ref the watchers received, when the error is internal and so was logged under one.
  private announceError(sessionId: string, error: OpenFleetError, where: string): string | undefined {
    const describe = this.deps.describeError;
    if (!describe) return undefined;
    try {
      const envelope = describe(error, { sessionId, where });
      this.deps.bus.emit({ type: 'error', sessionId, error: envelope });
      return envelope.id;
    } catch (announceFailure) {
      log('warn', `${where}: the error event could not be broadcast`, { code: (announceFailure as { code?: string }).code });
      return undefined;
    }
  }

  private announceClosure(sessionId: string, { exitCode, reason, failure }: SessionClosure): void {
    const failureCode = reason && FAILURE_CODE_BY_CLOSE_REASON[reason];
    if (!failureCode) return;
    const error = isNamedLaunchFailure(failure) ? failure
      : failureCode === 'harness_exited'
        ? this.harnessExitedError(sessionId, exitCode)
        : new OpenFleetError(failureCode, `session closed: ${reason}${exitCode === undefined ? '' : ` (exit code ${exitCode})`}`, { cause: failure });
    const watchersRef = this.announceError(sessionId, error, `session closed: ${reason}`);
    if (watchersRef) rememberLoggedRef(failure, watchersRef); // the REST answer for the same failure reuses this ref instead of logging again
  }

  // The one record of a launch failure: describeError logs an internal failure with its cause and the ref the client receives;
  // a named failure is not internal and an unwired describeError logs nothing, so the launch logs those itself.
  private logLaunchFailure(message: string, failure: unknown): void {
    const isLoggedByDescribeError = this.deps.describeError !== undefined && !isNamedLaunchFailure(failure);
    if (!isLoggedByDescribeError) log('error', message, failure);
  }

  // harness_exited is not an internal kind (its message reaches the client), so the daemon logs it itself, once.
  private harnessExitedError(sessionId: string, exitCode: number | undefined): OpenFleetError {
    const wasKilledBySignal = exitCode !== undefined && exitCode > SIGNAL_EXIT_CODE_BASE;
    const launchedAt = this.launchedAtBySessionId.get(sessionId);
    const exitedRightAfterLaunch = launchedAt !== undefined && this.now() - launchedAt < EARLY_EXIT_WINDOW_MS;
    const exitDescription = exitCode === undefined ? '' : ` (exit code ${exitCode})`;
    log('error', `session ${sessionId}: the agent process ended abnormally${exitDescription}${exitedRightAfterLaunch ? ' right after launch' : ''}`, undefined, { code: 'harness_exited', sessionId });
    if (wasKilledBySignal) return new OpenFleetError('harness_exited', `the agent process was killed (signal ${exitCode - SIGNAL_EXIT_CODE_BASE}).`, { hint: REOPEN_HINT });
    if (exitedRightAfterLaunch) return new OpenFleetError('harness_exited', `the agent process exited right after launch${exitDescription}.`, { hint: CLI_NOT_FOUND_HINT });
    return new OpenFleetError('harness_exited', `the agent process exited${exitDescription}.`, { hint: REOPEN_HINT });
  }

  // A launch that fails on a row already closed (an ordinary reopen, a shutdown row a transition rolled back) leaves markClosed
  // nothing to do: the row is rewritten here so live clients and a fresh snapshot agree on the failed close.
  private rewriteClosedRowAsFailedLaunch(sessionId: string, closure: SessionClosure): void {
    this.repo.failClosedRow(sessionId, RESUME_LAUNCH_FAILED_EXIT_CODE, new Date().toISOString());
    this.deps.bus.emit({ type: 'session.closed', sessionId, exitCode: closure.exitCode, reason: closure.reason });
    this.announceClosure(sessionId, closure);
  }

  private closeAfterFailedLaunch(sessionId: string, closure: SessionClosure): void {
    const isRowAlreadyClosed = this.repo.get(sessionId)?.state === 'closed';
    this.markClosed(sessionId, closure);
    if (isRowAlreadyClosed) this.rewriteClosedRowAsFailedLaunch(sessionId, closure);
  }

  private markClosed(sessionId: string, closure: SessionClosure): void {
    const { exitCode, reason } = closure;
    this.clearResumeTimer(sessionId);
    this.disarmInterruptWatch(sessionId);
    this.transcriptPaths.delete(sessionId);
    this.dropPendingRecording(sessionId);
    this.modelSwitchesAwaitingRelaunch.delete(sessionId);
    this.resolvedModelBeforeSameAliasRelaunch.delete(sessionId);
    this.stopDelivery(sessionId);
    this.pendingRelaunches.delete(sessionId);
    this.unfinishedTurns.delete(sessionId);
    this.releaseClearHold(sessionId);
    this.clearStartedAt.delete(sessionId);
    const isClosingForShutdown = this.idsClosingForDaemonShutdown.delete(sessionId);
    this.closeCauses.delete(sessionId);
    this.cancelSessionEndGraces.get(sessionId)?.();
    const session = this.repo.get(sessionId);
    if (!session || session.state === 'closed') { this.idsClosingByParent.delete(sessionId); this.launchedAtBySessionId.delete(sessionId); return; }
    // Revoked, not just marked closed, in the same write as the state change: a subprocess the agent left
    // behind, or anyone who read the token (MAJ-03), must not go on calling the hook or MCP surface as this
    // session once it is closed — defence in depth alongside byHookToken/byMcpToken's own state filter,
    // which is what actually protects a row a pre-patch build already left closed. reopen() issues its own
    // fresh pair on the way back up (resumeOne), so this never collides with that rotation.
    const isFailedStart = closure.reason === 'resume_timeout' || closure.reason === 'launch_failed'; // a start that failed stays closed: no boot retries it
    const closedByDaemonShutdown = isClosingForShutdown && !isFailedStart;
    this.repo.setClosed(sessionId, exitCode, new Date().toISOString(), newToken(), newToken(), { closedByDaemonShutdown });
    this.handles.delete(sessionId);
    activeHandleBySessionId.delete(sessionId);
    try {
      this.deps.bus.emit({ type: 'session.closed', sessionId, exitCode, ...(reason && { reason }) });
      this.announceClosure(sessionId, closure);
    } finally {
      this.idsClosingByParent.delete(sessionId);
      this.launchedAtBySessionId.delete(sessionId);
    }
  }

  // Boot resume and reopen both call this, but only reopen acts on the outcome: boot resume keeps its
  // existing "log and mark closed" behaviour for one bad row so the rest of the fleet still comes up.
  private resumeOne(session: Session): { launched: true } | { launched: false; reason: string; failure?: unknown } {
    this.assertNotShuttingDown();
    const tokens = this.repo.tokens(session.id);
    if (!tokens) return { launched: false, reason: 'session has no stored tokens' }; // defensive: every session row carries its tokens
    let harness: Harness;
    try {
      harness = this.harnessFor(session.harness);
    } catch (err) {
      if (!(err instanceof UnknownHarnessError)) throw err;
      this.logLaunchFailure(`resumeOne: session ${session.id} cannot resume`, err);
      this.closeAfterFailedLaunch(session.id, { exitCode: RESUME_LAUNCH_FAILED_EXIT_CODE, reason: 'launch_failed', failure: err });
      return { launched: false, reason: err.message, failure: err };
    }
    this.warnIfPermissiveSettings(session.harness, session.directory);
    const permissionMode = this.resolveResumePermissionMode(session);
    // A daemon crash can leave the pre-restart process alive for a moment in its orphaned PTY (ponytail:
    // it can still touch files on disk until it actually exits — persisting the PTY pid and killing its
    // process group on resume would close that window, but the DB row has no pid column yet). Rotating
    // both tokens before launch means its late hooks 404/no-op and its MCP bearer gets 401 immediately,
    // rather than letting it act as the resumed session.
    const hookToken = newToken();
    const mcpToken = newToken();
    this.repo.setTokens(session.id, hookToken, mcpToken);
    this.startPendingRecording(session.id, session.model);
    let handle: HarnessHandle;
    let isNewConversationAnnounced = false;
    try {
      const conversation = this.conversationToLaunch(session, harness);
      handle = harness.start({
        sessionId: session.id,
        cliSessionId: conversation.cliSessionId,
        directory: session.directory,
        model: session.model,
        hookUrl: `${this.deps.baseUrl}/hooks/${hookToken}`,
        mcpUrl: `${this.deps.baseUrl}/mcp`,
        mcpToken,
        displayName: `${session.emoji} ${session.name}`,
        permissionMode,
        resuming: conversation.isResumed,
      });
      isNewConversationAnnounced = conversation.isNewConversationAnnounced;
    } catch (err) {
      // The launch builder refuses to resume with a missing/invalid session id (it would otherwise open
      // the CLI's interactive picker inside the PTY) — close this one row and keep resuming the rest of
      // the fleet rather than letting one bad row abort resumeAll for every other session.
      this.logLaunchFailure(`resumeOne: session ${session.id} failed to launch`, err);
      this.closeAfterFailedLaunch(session.id, { exitCode: RESUME_LAUNCH_FAILED_EXIT_CODE, reason: 'launch_failed', failure: err });
      return { launched: false, reason: (err as Error).message, failure: err };
    }
    this.handles.set(session.id, handle);
    activeHandleBySessionId.set(session.id, handle);
    handle.onData((data) => {
      this.appendOutput(session.id, data);
      this.deps.bus.emit({ type: 'session.output', sessionId: session.id, data });
    });
    this.watchProcessExit(session.id, handle);
    this.armResumeTimeout(session.id, handle);
    if (isNewConversationAnnounced) this.announceNewConversation(session.id);
    // The DB write is last: if it throws, the handle is already fully wired (onExit + resume timeout),
    // so resumeAll's catch can close this row via markClosed without leaving an untracked process behind.
    const startingSince = new Date().toISOString();
    this.repo.setState(session.id, 'starting', startingSince);
    this.deps.bus.emit({ type: 'session.state', sessionId: session.id, state: 'starting', stateSince: startingSince });
    return { launched: true };
  }

  // The CLI exits with code 1 on a conversation it has no file for, which would close the session on every
  // relaunch. A conversation that is gone gets a fresh one under a new id, recorded at once so the next relaunch
  // resumes it; the launch id is never the fallback (it would silently undo a /clear). A conversation that never
  // got a prompt has no file either, and nothing was lost: it is launched again under its own id, without notice.
  // A conversation the harness cannot inspect is resumed as stored: only a file that is not there proves it gone.
  private conversationToLaunch(session: Session, harness: Harness): { cliSessionId: string; isResumed: boolean; isNewConversationAnnounced: boolean } {
    const currentCliSessionId = this.currentCliSessionIdOf(session.id);
    const presence = harness.conversationExists?.({ cliSessionId: currentCliSessionId, directory: session.directory }) ?? 'present';
    if (presence === 'present') return { cliSessionId: currentCliSessionId, isResumed: true, isNewConversationAnnounced: false };
    if (presence === 'unknown') {
      log('warn', `resume: conversation state unknown, resuming the stored one: session ${session.id}, conversation ${currentCliSessionId}`);
      return { cliSessionId: currentCliSessionId, isResumed: true, isNewConversationAnnounced: false };
    }
    const isConversationLost = this.repo.isCurrentConversationPrompted(session.id);
    if (!isConversationLost) return { cliSessionId: currentCliSessionId, isResumed: false, isNewConversationAnnounced: false };
    const freshCliSessionId = newId();
    this.repo.setCliSessionId(session.id, freshCliSessionId);
    this.repo.setCurrentConversationPrompted(session.id, false);
    log('warn', `resume: conversation not found: session ${session.id}, missing ${currentCliSessionId}, started ${freshCliSessionId}`);
    return { cliSessionId: freshCliSessionId, isResumed: false, isNewConversationAnnounced: true };
  }

  // A failing listener (e.g. a WS client on a closing socket) must not undo a launch that already happened.
  private announceNewConversation(sessionId: string): void {
    this.appendOutput(sessionId, NEW_CONVERSATION_NOTICE);
    try {
      this.deps.bus.emit({ type: 'session.output', sessionId, data: NEW_CONVERSATION_NOTICE });
    } catch (err) {
      log('error', `resume: session ${sessionId} started a new conversation, but a session.output listener failed`, err);
    }
  }

  // Read-only, best-effort informational signal: a worktree can carry a .claude settings file with a
  // permission bypass, but launchConfig's `--setting-sources user` (AUD-28) keeps claude-cli from ever
  // loading it, so this can no longer let a session skip the daemon's own approval gate. Only claude-cli
  // would otherwise read those settings, so a 'fake' harness launch is never inspected.
  private warnIfPermissiveSettings(harnessId: Session['harness'], directory: string): void {
    if (harnessId !== 'claude-cli') return;
    const warning = findPermissiveSettingsWarning(directory);
    if (warning) console.warn(`session directory ${directory} has permissive Claude settings, but OpenFleet ignores project settings: ${warning}`);
  }

  private resolveResumePermissionMode(session: Session): PermissionMode | undefined {
    // session.permissionMode already went through normalizePermissionMode() once in the repository
    // mapper, which discards whether the raw column value was recognized — re-read the raw column here
    // so the resume path can still warn on an unrecognized value the repository silently turned into undefined.
    const raw = this.repo.rawPermissionMode(session.id);
    const { mode, wasRecognized } = normalizePermissionMode(raw);
    if (!wasRecognized) log('warn', `resumeOne: session ${session.id} has an unrecognized permission_mode "${raw}", resuming without --permission-mode`);
    return mode;
  }

  private armResumeTimeout(sessionId: string, handle: HarnessHandle): void {
    this.armStartTimeout(sessionId, handle, this.deps.resumeTimeoutMs ?? DEFAULT_RESUME_TIMEOUT_MS);
  }

  private armFirstStartTimeout(sessionId: string, handle: HarnessHandle): void {
    this.armStartTimeout(sessionId, handle, this.deps.firstStartTimeoutMs ?? DEFAULT_FIRST_START_TIMEOUT_MS);
  }

  private armStartTimeout(sessionId: string, handle: HarnessHandle, timeoutMs: number): void {
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
        this.markClosed(sessionId, { exitCode: RESUME_TIMEOUT_EXIT_CODE, reason: 'resume_timeout' });
      });
    }, timeoutMs);
    this.resumeTimers.set(sessionId, timer);
  }

  private clearResumeTimer(sessionId: string): void {
    const timer = this.resumeTimers.get(sessionId);
    if (timer) clearTimeout(timer);
    this.resumeTimers.delete(sessionId);
  }

  private harnessFor(id: string): Harness {
    const harness = this.deps.harnesses.find((h) => h.id === id);
    if (!harness) throw new UnknownHarnessError(id);
    return harness;
  }

  private require(id: string): Session {
    const session = this.repo.get(id);
    if (!session) throw new Error(`unknown session: ${id}`);
    return session;
  }
}
