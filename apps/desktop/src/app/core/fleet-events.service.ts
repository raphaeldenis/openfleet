import { Injectable, signal } from '@angular/core';
import type { Approval, ServerEvent, Session } from '@openfleet/shared';
import { Subject } from 'rxjs';
import { environment } from '../../environments/environment';

@Injectable({ providedIn: 'root' })
export class FleetEventsService {
  readonly sessions = signal<Session[]>([]);
  readonly approvals = signal<Approval[]>([]);
  private readonly outputBySession = new Map<string, Subject<string>>();
  private socket?: WebSocket;

  connect(): void {
    const wsUrl = `${environment.apiUrl.replace(/^http/, 'ws')}/ws?token=${encodeURIComponent(environment.adminToken)}`;
    this.socket = new WebSocket(wsUrl);
    this.socket.addEventListener('message', (m) => this.reduce(JSON.parse(String(m.data)) as ServerEvent));
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
        return;
      case 'session.created': return this.upsertSession(event.session);
      case 'session.state': return this.patchSession(event.sessionId, { state: event.state, stateSince: event.stateSince });
      case 'session.closed': return this.patchSession(event.sessionId, { state: 'closed', exitCode: event.exitCode });
      case 'session.output': return this.output(event.sessionId).next(event.data);
      case 'session.replay': return this.output(event.sessionId).next(event.data);
      case 'approval.created': return this.upsertApproval(event.approval);
      case 'approval.resolved': return this.approvals.update((all) => all.filter((a) => a.id !== event.approval.id));
      default: return;
    }
  }

  private upsertSession(session: Session): void {
    this.sessions.update((all) => (all.some((s) => s.id === session.id) ? all.map((s) => (s.id === session.id ? session : s)) : [...all, session]));
  }

  private upsertApproval(approval: Approval): void {
    this.approvals.update((all) => (all.some((a) => a.id === approval.id) ? all.map((a) => (a.id === approval.id ? approval : a)) : [...all, approval]));
  }

  private patchSession(id: string, patch: Partial<Session>): void {
    this.sessions.update((all) => all.map((s) => (s.id === id ? { ...s, ...patch } : s)));
  }
}
