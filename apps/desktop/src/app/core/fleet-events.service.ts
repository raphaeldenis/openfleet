import { Injectable, computed, signal } from '@angular/core';
import { TodoSummarySchema, closeReasonOfExitCode, parseSessionCloseReason } from '@openfleet/shared';
import type { Approval, DaemonIssue, ErrorEnvelope, ErrorEventScope, ManagerView, ServerEvent, Session, SessionTodos, SilentBlock, TodoSummary, WorkingState } from '@openfleet/shared';
import { Subject } from 'rxjs';
import { environment } from '../../environments/environment';
import { parseSessionTodos } from './session-todos-parser';
import { isUserTyping } from './terminal-keystrokes';

const INITIAL_RECONNECT_DELAY_MS = 1000;
const MAX_RECONNECT_DELAY_MS = 10_000;
const MAX_BACKGROUND_FAILURES = 50;

export interface BackgroundFailure {
  key: string;
  sessionId?: string;
  envelope: ErrorEnvelope;
  at: string;
}

// The daemon sends an `error` event both to answer a client message that failed and to announce a failure nobody asked for.
// A daemon that says which one (`scope`) is believed. One that does not is read by the kind: the reply to a rejected request
// (session_closed, invalid_body…) is the user's own doing; only a daemon-side failure, or a message the CLI held for review, is news.
function isBackgroundFailure({ error: envelope, scope }: { error: ErrorEnvelope; scope?: ErrorEventScope }): boolean {
  if (scope) return scope === 'broadcast';
  const isDaemonSideFailure = envelope.kind === 'internal' || envelope.kind === 'unavailable';
  return isDaemonSideFailure || envelope.error === 'message_held_for_review';
}

/** Names one prompt of one session: the same prompt keeps its key for as long as it stays undecided. */
export const silentBlockKey = ({ sessionId, waitingSince }: SilentBlock): string => `${sessionId}@${waitingSince}`;

function readableTodoSummaries(received: unknown[] | undefined): TodoSummary[] {
  const results = (received ?? []).map((summary) => TodoSummarySchema.safeParse(summary));
  return results.flatMap((result) => (result.success ? [result.data] : []));
}

// The close reason lives on the session, whether it arrived live (session.closed) or in a snapshot / full row. A reason this version
// does not know reads as absent, and a close without a stored reason (recorded by an older daemon) falls back to what its exit code encodes.
function withReadableCloseReason(session: Session): Session {
  const isClosed = session.state === 'closed';
  const closeReason = isClosed ? (parseSessionCloseReason(session.closeReason) ?? closeReasonOfExitCode(session.exitCode)) : undefined;
  return closeReason === session.closeReason ? session : { ...session, closeReason };
}

// The daemon never clears closedAt, so a live session keeps the stamp of a close it has long recovered
// from. closedAt only means something while the session is closed or coming back (starting): drop it once live.
function withoutStaleClosure(session: Session): Session {
  const isComingBackOrClosed = session.state === 'starting' || session.state === 'closed';
  const hasStaleClosure = session.closedAt !== undefined && !isComingBackOrClosed;
  return hasStaleClosure ? { ...session, closedAt: undefined } : session;
}

// A full row (session.created / session.updated) of a relaunching session carries the closedAt of a close it
// recovered from long ago. Only a local copy that is closed, or already coming back from a close, vouches for
// a closedAt arriving on a `starting` row; otherwise it is the stale stamp of an ordinary model / mode relaunch.
function withoutClosureNotVouchedFor(incoming: Session, local: Session | undefined): Session {
  const session = withoutStaleClosure(incoming);
  const isLocalCopyClosed = local?.state === 'closed';
  const isLocalCopyComingBackFromClose = local?.state === 'starting' && local.closedAt !== undefined;
  const isClosureVouchedFor = isLocalCopyClosed || isLocalCopyComingBackFromClose;
  const isStaleClosureOnStartingRow = session.state === 'starting' && !isClosureVouchedFor;
  return isStaleClosureOnStartingRow ? { ...session, closedAt: undefined } : session;
}

@Injectable({ providedIn: 'root' })
export class FleetEventsService {
  readonly sessions = signal<Session[]>([]);
  readonly approvals = signal<Approval[]>([]);
  readonly managers = signal<ManagerView[]>([]);
  readonly workingStates = signal<ReadonlyMap<string, WorkingState>>(new Map());
  // A daemon that predates working states sends no list: a missing state then means "not reported", never "overdue".
  readonly workingStatesReported = signal(false);
  readonly workingStateMaxAgeMinutes = signal<number | undefined>(undefined);
  readonly workingStateMaxBytes = signal<number | undefined>(undefined);
  readonly connected = signal(false);
  /** The last list received for each session, from a session.todos event or a REST read. */
  readonly todos = signal<ReadonlyMap<string, SessionTodos>>(new Map());
  readonly todoSummaries = signal<ReadonlyMap<string, TodoSummary>>(new Map());
  // A daemon that predates todos sends no summaries: a missing list then means "not reported", never "empty".
  readonly todosReported = signal(false);
  /** The sessions whose todos the last full snapshot left in the caches: the daemon retains at most CLOSED_SNAPSHOTS_KEPT closed ones. */
  readonly sessionIdsWithRetainedTodos = signal<ReadonlySet<string>>(new Set());
  private readonly todoEventCounts = new Map<string, number>();
  private sessionIdWhoseTodosAreKept?: string;
  /** What keeps the daemon running degraded; empty while it is healthy or when an older daemon reports none. */
  readonly daemonIssues = signal<DaemonIssue[]>([]);
  /** Failures the daemon announced that no request of the user caused, newest first, until the user dismisses them. */
  readonly backgroundFailures = signal<BackgroundFailure[]>([]);
  private readonly reportedSilentBlocks = signal<SilentBlock[]>([]);
  private readonly dismissedSilentBlockKeys = signal<ReadonlySet<string>>(new Set());
  /** Sessions the daemon says sit on a permission prompt nobody decided, minus the ones the user dismissed; empty for a daemon that reports none. */
  readonly silentBlocks = computed(() => this.reportedSilentBlocks().filter((block) => !this.dismissedSilentBlockKeys().has(silentBlockKey(block))));
  private nextFailureNumber = 1;
  // A direct load of a route that never mounts App (e.g. /manager/:id) still needs to know
  // whether the first snapshot has arrived, so it can show a loading state instead of "not found".
  readonly snapshotReceived = signal(false);
  // Increments on every reconnect (not the first connect) — a fresh snapshot already resyncs
  // sessions/approvals on its own; this tells an attached terminal to re-request its replay too.
  readonly reconnectCount = signal(0);
  // messageIds whose message.delivered event has already arrived — a composer showing "queued" for its
  // own messageId flips to "sent" once that id lands here.
  readonly deliveredMessageIds = signal<ReadonlySet<string>>(new Set());
  /** Ids of the sessions whose terminal just received fresh output: a replay of past output is not fresh. */
  readonly liveOutputSessionIds = new Subject<string>();
  /** Ids of the sessions the user just typed in through their terminal: the replies the terminal sends by itself are not typing. */
  readonly typedInSessionIds = new Subject<string>();
  private readonly outputBySession = new Map<string, Subject<string>>();
  private socket?: WebSocket;
  private reconnectDelayMs = INITIAL_RECONNECT_DELAY_MS;
  private hasConnectedBefore = false;
  // An attach or resize made while the socket is not open is not lost, only deferred: it is sent once the
  // socket opens. Keystrokes are never queued here — replaying stale input into a live agent is dangerous.
  private readonly queuedAttachSessionIds = new Set<string>();
  private readonly queuedResizeBySession = new Map<string, { cols: number; rows: number }>();
  // Sessions already attached since the current socket opened. A queued attach flushed on open and a
  // terminal's own reconnect effect can both ask to attach the same session right after that open — this
  // is what makes the second one a no-op instead of a duplicate replay. Cleared the moment the socket
  // drops, so a real future reconnect still attaches normally.
  private readonly attachedSinceOpenSessionIds = new Set<string>();

  connect(): Promise<void> {
    const isAlreadyConnectingOrOpen =
      this.socket !== undefined && (this.socket.readyState === WebSocket.CONNECTING || this.socket.readyState === WebSocket.OPEN);
    if (isAlreadyConnectingOrOpen) return Promise.resolve();
    return this.openSocket();
  }

  // AUD-27: a ticket is fetched fresh over REST (bearer-authenticated, like every other /api/ call) right
  // before every (re)connect, instead of putting the long-lived admin token in the WS URL — the query
  // string is the one place a browser WebSocket can carry a credential at all, and a URL there ends up in
  // the console on every failed reconnect. An unconsumed ticket stays valid for up to its TTL if the
  // handshake fails before consumption, so a leaked one isn't worthless right away — the short TTL,
  // single use, and the loopback-only daemon are what keep that window small.
  private async openSocket(): Promise<void> {
    const ticket = await this.fetchTicket();
    if (ticket === undefined) {
      this.scheduleReconnect();
      return;
    }
    const wsUrl = `${environment.apiUrl.replace(/^http/, 'ws')}/ws?ticket=${encodeURIComponent(ticket)}`;
    const socket = new WebSocket(wsUrl);
    this.socket = socket;
    socket.addEventListener('open', () => {
      this.connected.set(true);
      this.reconnectDelayMs = INITIAL_RECONNECT_DELAY_MS;
      if (this.hasConnectedBefore) this.reconnectCount.update((n) => n + 1);
      this.hasConnectedBefore = true;
      this.flushQueuedSends();
    });
    socket.addEventListener('message', (m) => this.reduce(JSON.parse(String(m.data)) as ServerEvent));
    socket.addEventListener('close', () => this.scheduleReconnect());
  }

  // A failed fetch (daemon down, network blip) is not a crash: it falls back to the same reconnect/backoff
  // loop a dropped socket goes through, so the caller stays offline and read-only (AUD-14) until it works.
  private async fetchTicket(): Promise<string | undefined> {
    try {
      const response = await fetch(`${environment.apiUrl}/api/ws-ticket`, {
        method: 'POST',
        headers: { authorization: `Bearer ${environment.adminToken}` },
      });
      if (!response.ok) return undefined;
      const body = (await response.json()) as { ticket?: string };
      return body.ticket;
    } catch {
      return undefined;
    }
  }

  private scheduleReconnect(): void {
    this.connected.set(false);
    this.attachedSinceOpenSessionIds.clear();
    setTimeout(() => { void this.openSocket(); }, this.reconnectDelayMs);
    this.reconnectDelayMs = Math.min(this.reconnectDelayMs * 2, MAX_RECONNECT_DELAY_MS);
  }

  output(sessionId: string): Subject<string> {
    const existing = this.outputBySession.get(sessionId);
    if (existing) return existing;
    const subject = new Subject<string>();
    this.outputBySession.set(sessionId, subject);
    return subject;
  }

  sendInput(sessionId: string, data: string): void {
    if (!this.isSocketOpen()) return;
    if (isUserTyping(data)) this.typedInSessionIds.next(sessionId);
    this.send({ type: 'input', sessionId, data });
  }

  sendResize(sessionId: string, cols: number, rows: number): void {
    if (!this.isSocketOpen()) {
      this.queuedResizeBySession.set(sessionId, { cols, rows });
      return;
    }
    this.send({ type: 'resize', sessionId, cols, rows });
  }

  sendAttach(sessionId: string): void {
    if (this.attachedSinceOpenSessionIds.has(sessionId)) return;
    if (!this.isSocketOpen()) {
      this.queuedAttachSessionIds.add(sessionId);
      return;
    }
    this.attachedSinceOpenSessionIds.add(sessionId);
    this.send({ type: 'attach', sessionId });
  }

  /** Drops a session's queued attach/resize — nothing left to view means nothing worth sending on reconnect. */
  dropQueuedSendsFor(sessionId: string): void {
    this.queuedAttachSessionIds.delete(sessionId);
    this.queuedResizeBySession.delete(sessionId);
  }

  private isSocketOpen(): boolean {
    return this.socket?.readyState === WebSocket.OPEN;
  }

  private send(payload: unknown): void {
    this.socket!.send(JSON.stringify(payload));
  }

  private flushQueuedSends(): void {
    for (const sessionId of this.queuedAttachSessionIds) {
      this.attachedSinceOpenSessionIds.add(sessionId);
      this.send({ type: 'attach', sessionId });
    }
    this.queuedAttachSessionIds.clear();
    for (const [sessionId, size] of this.queuedResizeBySession) this.send({ type: 'resize', sessionId, ...size });
    this.queuedResizeBySession.clear();
  }

  private reduce(event: ServerEvent): void {
    switch (event.type) {
      case 'snapshot': {
        this.sessions.set(event.sessions.map((session) => withReadableCloseReason(withoutStaleClosure(session))));
        this.approvals.set(event.approvals);
        this.managers.set(event.managers ?? []);
        this.workingStates.set(new Map((event.workingStates ?? []).map((state) => [state.sessionId, state])));
        this.workingStatesReported.set(event.workingStates !== undefined);
        this.workingStateMaxAgeMinutes.set(event.workingStateMaxAgeMinutes);
        this.workingStateMaxBytes.set(event.workingStateMaxBytes);
        this.daemonIssues.set(event.daemonIssues ?? []);
        this.reportSilentBlocks(event.silentBlocks ?? []);
        this.todosReported.set(event.todoSummaries !== undefined);
        const summaries = new Map(readableTodoSummaries(event.todoSummaries).map((summary) => [summary.sessionId, summary]));
        this.todoSummaries.set(summaries);
        this.reconcileTodosWithSnapshot(summaries);
        this.snapshotReceived.set(true);
        return;
      }
      case 'session.todos': return this.receiveTodosEvent(event.todos);
      case 'session.working_state': return this.workingStates.update((all) => new Map(all).set(event.state.sessionId, event.state));
      case 'session.created': return this.upsertSession(event.session);
      case 'session.state': return this.patchSession(event.sessionId, { state: event.state, stateSince: event.stateSince });
      case 'session.closed':
        return this.patchSession(event.sessionId, { state: 'closed', exitCode: event.exitCode, closeReason: parseSessionCloseReason(event.reason) });
      case 'session.updated': return this.upsertSession(event.session);
      case 'session.output':
        this.output(event.sessionId).next(event.data);
        this.liveOutputSessionIds.next(event.sessionId);
        return;
      case 'session.replay': return this.output(event.sessionId).next(event.data);
      case 'session.model_changed': return this.patchSession(event.sessionId, { model: event.model });
      case 'session.permission_mode_changed': return this.patchSession(event.sessionId, { permissionMode: event.mode });
      // resumeOne() already wrote 'starting' to the DB before this event fires; the event itself carries
      // no state, so mirror that transition here rather than waiting for the next session.state event.
      case 'session.reopened': return this.markReopened(event.sessionId);
      case 'message.queued': return; // the sender already knows 'queued' from its own REST response; nothing else reads this yet
      case 'message.delivered': return this.markMessageDelivered(event.messageId);
      case 'approval.created': return this.upsertApproval(event.approval);
      case 'approval.resolved': return this.approvals.update((all) => all.filter((a) => a.id !== event.approval.id));
      case 'manager.created': return this.upsertManager(event.manager);
      case 'manager.pulsed': return this.upsertManager(event.manager);
      case 'error': return this.recordBackgroundFailure(event);
      case 'daemon.issues': return this.daemonIssues.set(event.issues);
      case 'permission.silent_blocks': return this.reportSilentBlocks(event.blocks);
      default: return;
    }
  }

  /** How many session.todos events arrived for a session: a REST answer is stale when this moved since its request left. */
  todoEventCount(sessionId: string): number {
    return this.todoEventCounts.get(sessionId) ?? 0;
  }

  /** Names the session on screen: a snapshot keeps its list even when the daemon reports no summary for it. */
  keepTodosOf(sessionId: string | undefined): void {
    this.sessionIdWhoseTodosAreKept = sessionId;
  }

  storeFetchedTodos(todos: SessionTodos): void {
    this.todos.update((all) => new Map(all).set(todos.sessionId, todos));
  }

  /** Forgets the lists of the sessions a full snapshot no longer reports, so an evicted list is read again instead of shown as fresh. */
  private reconcileTodosWithSnapshot(summaries: ReadonlyMap<string, TodoSummary>): void {
    const retainedSessionIds = new Set(summaries.keys());
    if (this.sessionIdWhoseTodosAreKept) retainedSessionIds.add(this.sessionIdWhoseTodosAreKept);
    this.todos.update((all) => new Map([...all].filter(([sessionId]) => retainedSessionIds.has(sessionId))));
    for (const sessionId of [...this.todoEventCounts.keys()]) if (!retainedSessionIds.has(sessionId)) this.todoEventCounts.delete(sessionId);
    this.sessionIdsWithRetainedTodos.set(retainedSessionIds);
  }

  private receiveTodosEvent(payload: unknown): void {
    const todos = parseSessionTodos(payload);
    if (!todos) return;
    this.todoEventCounts.set(todos.sessionId, this.todoEventCount(todos.sessionId) + 1);
    this.storeFetchedTodos(todos);
    if (todos.updatedAt === null) return;
    const summary: TodoSummary = { sessionId: todos.sessionId, counts: todos.counts, updatedAt: todos.updatedAt };
    this.todoSummaries.update((all) => new Map(all).set(todos.sessionId, summary));
  }

  dismissSilentBlock(key: string): void {
    this.dismissedSilentBlockKeys.update((keys) => new Set(keys).add(key));
  }

  /** A dismissal is forgotten once its prompt is no longer reported, so the list never keeps keys of decided prompts. */
  private reportSilentBlocks(blocks: SilentBlock[]): void {
    const reportedKeys = new Set(blocks.map(silentBlockKey));
    this.dismissedSilentBlockKeys.update((keys) => new Set([...keys].filter((key) => reportedKeys.has(key))));
    this.reportedSilentBlocks.set(blocks);
  }

  dismissBackgroundFailure(key: string): void {
    this.backgroundFailures.update((all) => all.filter((failure) => failure.key !== key));
  }

  private recordBackgroundFailure(event: { error: ErrorEnvelope; sessionId?: string; scope?: ErrorEventScope }): void {
    if (!isBackgroundFailure(event)) return;
    const failure: BackgroundFailure = { key: `failure-${this.nextFailureNumber++}`, sessionId: event.sessionId, envelope: event.error, at: new Date().toISOString() };
    this.backgroundFailures.update((all) => [failure, ...all].slice(0, MAX_BACKGROUND_FAILURES));
  }

  private upsertSession(incoming: Session): void {
    this.sessions.update((all) => {
      const local = all.find((s) => s.id === incoming.id);
      const session = withReadableCloseReason(withoutClosureNotVouchedFor(incoming, local));
      return local ? all.map((s) => (s.id === session.id ? session : s)) : [...all, session];
    });
  }

  private upsertApproval(approval: Approval): void {
    this.approvals.update((all) => (all.some((a) => a.id === approval.id) ? all.map((a) => (a.id === approval.id ? approval : a)) : [...all, approval]));
  }

  private upsertManager(manager: ManagerView): void {
    this.managers.update((all) => (all.some((m) => m.sessionId === manager.sessionId) ? all.map((m) => (m.sessionId === manager.sessionId ? manager : m)) : [...all, manager]));
  }

  private patchSession(id: string, patch: Partial<Session>): void {
    this.sessions.update((all) => all.map((s) => (s.id === id ? withReadableCloseReason(withoutStaleClosure({ ...s, ...patch })) : s)));
  }

  // A session closed while this client was connected never received a closedAt from the daemon; stamping it on
  // reopen keeps "closed, now coming back" recognisable for the whole starting window.
  private markReopened(id: string): void {
    const reopenedAt = new Date().toISOString();
    this.sessions.update((all) =>
      all.map((s) => (s.id === id ? { ...s, state: 'starting', exitCode: undefined, closeReason: undefined, closedAt: s.closedAt ?? reopenedAt } : s)),
    );
  }

  private markMessageDelivered(messageId: string): void {
    this.deliveredMessageIds.update((ids) => new Set(ids).add(messageId));
  }
}
