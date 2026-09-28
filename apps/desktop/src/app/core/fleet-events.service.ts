import { Injectable, signal } from '@angular/core';
import type { Approval, ManagerView, ServerEvent, Session } from '@openfleet/shared';
import { Subject } from 'rxjs';
import { environment } from '../../environments/environment';
import { isUserTyping } from './terminal-keystrokes';

const INITIAL_RECONNECT_DELAY_MS = 1000;
const MAX_RECONNECT_DELAY_MS = 10_000;

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
  readonly connected = signal(false);
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

  connect(): void {
    const isAlreadyConnectingOrOpen =
      this.socket !== undefined && (this.socket.readyState === WebSocket.CONNECTING || this.socket.readyState === WebSocket.OPEN);
    if (isAlreadyConnectingOrOpen) return;
    this.openSocket();
  }

  private openSocket(): void {
    const wsUrl = `${environment.apiUrl.replace(/^http/, 'ws')}/ws?token=${encodeURIComponent(environment.adminToken)}`;
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

  private scheduleReconnect(): void {
    this.connected.set(false);
    setTimeout(() => this.openSocket(), this.reconnectDelayMs);
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
    if (!this.isSocketOpen()) {
      this.queuedAttachSessionIds.add(sessionId);
      return;
    }
    this.send({ type: 'attach', sessionId });
  }

  private isSocketOpen(): boolean {
    return this.socket?.readyState === WebSocket.OPEN;
  }

  private send(payload: unknown): void {
    this.socket!.send(JSON.stringify(payload));
  }

  private flushQueuedSends(): void {
    for (const sessionId of this.queuedAttachSessionIds) this.send({ type: 'attach', sessionId });
    this.queuedAttachSessionIds.clear();
    for (const [sessionId, size] of this.queuedResizeBySession) this.send({ type: 'resize', sessionId, ...size });
    this.queuedResizeBySession.clear();
  }

  private reduce(event: ServerEvent): void {
    switch (event.type) {
      case 'snapshot':
        this.sessions.set(event.sessions.map(withoutStaleClosure));
        this.approvals.set(event.approvals);
        this.managers.set(event.managers ?? []);
        this.snapshotReceived.set(true);
        return;
      case 'session.created': return this.upsertSession(event.session);
      case 'session.state': return this.patchSession(event.sessionId, { state: event.state, stateSince: event.stateSince });
      case 'session.closed': return this.patchSession(event.sessionId, { state: 'closed', exitCode: event.exitCode });
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
      default: return;
    }
  }

  private upsertSession(incoming: Session): void {
    this.sessions.update((all) => {
      const local = all.find((s) => s.id === incoming.id);
      const session = withoutClosureNotVouchedFor(incoming, local);
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
    this.sessions.update((all) => all.map((s) => (s.id === id ? withoutStaleClosure({ ...s, ...patch }) : s)));
  }

  // A session closed while this client was connected never received a closedAt from the daemon; stamping it on
  // reopen keeps "closed, now coming back" recognisable for the whole starting window.
  private markReopened(id: string): void {
    const reopenedAt = new Date().toISOString();
    this.sessions.update((all) =>
      all.map((s) => (s.id === id ? { ...s, state: 'starting', exitCode: undefined, closedAt: s.closedAt ?? reopenedAt } : s)),
    );
  }

  private markMessageDelivered(messageId: string): void {
    this.deliveredMessageIds.update((ids) => new Set(ids).add(messageId));
  }
}
