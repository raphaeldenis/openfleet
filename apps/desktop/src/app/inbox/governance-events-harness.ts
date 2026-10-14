import type { GovernanceProposalView, ManagerView, Session } from '@openfleet/shared';
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

  dispatchMessage(payload: unknown): void {
    for (const listener of this.listeners['message'] ?? []) listener({ data: JSON.stringify(payload) });
  }
}

export interface DaemonSnapshot {
  readonly sessions?: readonly Session[];
  readonly managers?: readonly ManagerView[];
  readonly proposals?: readonly GovernanceProposalView[];
}

/** The real FleetEventsService fed by a scripted daemon: specs drive it with the events the daemon sends, never by writing its signals. */
export async function connectToScriptedDaemon(initial: DaemonSnapshot = {}) {
  vi.stubGlobal('WebSocket', FakeWebSocket);
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({ ticket: 'fake-ticket' }) }));
  const events = new FleetEventsService();
  await events.connect();
  const dispatch = (event: unknown) => FakeWebSocket.current!.dispatchMessage(event);
  const sendSnapshot = ({ sessions = [], managers = [], proposals = [] }: DaemonSnapshot) =>
    dispatch({ type: 'snapshot', sessions, approvals: [], managers, proposals });
  sendSnapshot(initial);
  return {
    events,
    sendSnapshot,
    proposeOnDaemon: (proposal: GovernanceProposalView) => dispatch({ type: 'governance.proposed', proposal }),
    resolveOnDaemon: (proposal: GovernanceProposalView, status: 'approved' | 'denied' | 'withdrawn' = 'approved') =>
      dispatch({ type: 'governance.resolved', proposal: { ...proposal, status, decidedAt: new Date().toISOString() } }),
  };
}
