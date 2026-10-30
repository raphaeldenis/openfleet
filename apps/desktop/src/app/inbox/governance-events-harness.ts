import type { EscalationView, GovernanceProposalView, LawView, ManagerView, Session, WorkingState } from '@openfleet/shared';
import { vi } from 'vitest';
import { FleetEventsService } from '../core/fleet-events.service';

class FakeWebSocket {
  static current: FakeWebSocket | undefined;
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 3;
  private readonly listeners: Record<string, ((event: { data: string }) => void)[]> = {};
  readyState = FakeWebSocket.OPEN;

  constructor(readonly url: string) {
    FakeWebSocket.current = this;
  }

  addEventListener(type: string, listener: (event: { data: string }) => void): void {
    (this.listeners[type] ??= []).push(listener);
  }

  send(): void {}

  close(): void {}

  open(): void {
    for (const listener of this.listeners['open'] ?? []) listener({ data: '' });
  }

  dispatchMessage(payload: unknown): void {
    for (const listener of this.listeners['message'] ?? []) listener({ data: JSON.stringify(payload) });
  }
}

export interface DaemonSnapshot {
  readonly sessions?: readonly Session[];
  readonly managers?: readonly ManagerView[];
  readonly proposals?: readonly GovernanceProposalView[];
  readonly escalations?: readonly EscalationView[];
  readonly workingStates?: readonly WorkingState[];
  readonly queuedCounts?: Readonly<Record<string, number>>;
}

/** The real FleetEventsService fed by a scripted daemon: specs drive it with the events the daemon sends, never by writing its signals. */
export async function connectToScriptedDaemon(initial: DaemonSnapshot = {}) {
  vi.stubGlobal('WebSocket', FakeWebSocket);
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({ ticket: 'fake-ticket' }) }));
  const events = new FleetEventsService();
  await events.connect();
  const dispatch = (event: unknown) => FakeWebSocket.current!.dispatchMessage(event);
  const sendSnapshot = ({ sessions = [], managers = [], proposals = [], escalations = [], workingStates, queuedCounts }: DaemonSnapshot) =>
    dispatch({ type: 'snapshot', sessions, approvals: [], managers, proposals, escalations, workingStates, queuedCounts });
  FakeWebSocket.current!.open();
  sendSnapshot(initial);
  return {
    reconnectOnDaemon: (snapshot: DaemonSnapshot = {}) => {
      FakeWebSocket.current!.open();
      sendSnapshot(snapshot);
    },
    events,
    sendSnapshot,
    proposeOnDaemon: (proposal: GovernanceProposalView) => dispatch({ type: 'governance.proposed', proposal }),
    raiseEscalationOnDaemon: (escalation: EscalationView) => dispatch({ type: 'escalation.raised', escalation }),
    resolveEscalationOnDaemon: (escalation: EscalationView) =>
      dispatch({ type: 'escalation.resolved', escalation: { ...escalation, status: 'answered', resolvedAt: new Date().toISOString() } }),
    queueChangedOnDaemon: (managerId: string, queuedCount: number) => dispatch({ type: 'governance.queue_changed', managerId, queuedCount }),
    lawEventOnDaemon: (type: 'law.created' | 'law.updated' | 'law.withdrawn', law: LawView) => dispatch({ type, law }),
    resolveOnDaemon: (proposal: GovernanceProposalView, status: 'approved' | 'denied' | 'withdrawn' = 'approved') =>
      dispatch({ type: 'governance.resolved', proposal: { ...proposal, status, decidedAt: new Date().toISOString() } }),
  };
}
