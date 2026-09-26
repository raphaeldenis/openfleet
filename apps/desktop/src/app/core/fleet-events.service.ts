import { Injectable, signal } from '@angular/core';
import type { Approval, ManagerView, ServerEvent, Session } from '@openfleet/shared';
import { Subject } from 'rxjs';
import { environment } from '../../environments/environment';

const INITIAL_RECONNECT_DELAY_MS = 1000;
const MAX_RECONNECT_DELAY_MS = 10_000;

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
  private readonly outputBySession = new Map<string, Subject<string>>();
  private socket?: WebSocket;
  private reconnectDelayMs = INITIAL_RECONNECT_DELAY_MS;
  private hasConnectedBefore = false;

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

  sendInput(sessionId: string, data: string): void { this.socket?.send(JSON.stringify({ type: 'input', sessionId, data })); }
  sendResize(sessionId: string, cols: number, rows: number): void { this.socket?.send(JSON.stringify({ type: 'resize', sessionId, cols, rows })); }
  sendAttach(sessionId: string): void { this.socket?.send(JSON.stringify({ type: 'attach', sessionId })); }

  private reduce(event: ServerEvent): void {
    switch (event.type) {
      case 'snapshot':
        this.sessions.set(event.sessions);
        this.approvals.set(event.approvals);
        this.managers.set(event.managers ?? []);
        this.snapshotReceived.set(true);
        return;
      case 'session.created': return this.upsertSession(event.session);
      case 'session.state': return this.patchSession(event.sessionId, { state: event.state, stateSince: event.stateSince });
      case 'session.closed': return this.patchSession(event.sessionId, { state: 'closed', exitCode: event.exitCode });
      case 'session.output': return this.output(event.sessionId).next(event.data);
      case 'session.replay': return this.output(event.sessionId).next(event.data);
      case 'approval.created': return this.upsertApproval(event.approval);
      case 'approval.resolved': return this.approvals.update((all) => all.filter((a) => a.id !== event.approval.id));
      case 'manager.created': return this.upsertManager(event.manager);
      case 'manager.pulsed': return this.upsertManager(event.manager);
      default: return;
    }
  }

  private upsertSession(session: Session): void {
    this.sessions.update((all) => (all.some((s) => s.id === session.id) ? all.map((s) => (s.id === session.id ? session : s)) : [...all, session]));
  }

  private upsertApproval(approval: Approval): void {
    this.approvals.update((all) => (all.some((a) => a.id === approval.id) ? all.map((a) => (a.id === approval.id ? approval : a)) : [...all, approval]));
  }

  private upsertManager(manager: ManagerView): void {
    this.managers.update((all) => (all.some((m) => m.sessionId === manager.sessionId) ? all.map((m) => (m.sessionId === manager.sessionId ? manager : m)) : [...all, manager]));
  }

  private patchSession(id: string, patch: Partial<Session>): void {
    this.sessions.update((all) => all.map((s) => (s.id === id ? { ...s, ...patch } : s)));
  }
}
