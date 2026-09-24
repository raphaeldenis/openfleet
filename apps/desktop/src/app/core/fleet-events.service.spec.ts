import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FleetEventsService } from './fleet-events.service';

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  private readonly listeners: Record<string, ((event: { data: string }) => void)[]> = {};
  readonly sent: string[] = [];

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
  }

  addEventListener(type: string, listener: (event: { data: string }) => void): void {
    (this.listeners[type] ??= []).push(listener);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  dispatchMessage(payload: unknown): void {
    for (const listener of this.listeners['message'] ?? []) listener({ data: JSON.stringify(payload) });
  }

  dispatchOpen(): void {
    for (const listener of this.listeners['open'] ?? []) listener({} as { data: string });
  }

  dispatchClose(): void {
    for (const listener of this.listeners['close'] ?? []) listener({} as { data: string });
  }
}

function session(id: string, patch: Partial<{ name: string; state: string }> = {}) {
  return { id, name: patch.name ?? 'Gimli', emoji: '⚔️', directory: '/tmp', harness: 'fake', state: patch.state ?? 'idle', stateSince: 't', createdAt: 't' };
}

describe('FleetEventsService', () => {
  beforeEach(() => {
    FakeWebSocket.instances = [];
    vi.stubGlobal('WebSocket', FakeWebSocket);
  });

  it('seeds sessions and approvals from the snapshot event instead of a REST call', () => {
    const service = new FleetEventsService();
    service.connect();
    const socket = FakeWebSocket.instances[0]!;

    socket.dispatchMessage({ type: 'snapshot', sessions: [session('s1')], approvals: [] });

    expect(service.sessions()).toEqual([session('s1')]);
  });

  it('upserts a session.created event instead of duplicating a session already in the snapshot', () => {
    const service = new FleetEventsService();
    service.connect();
    const socket = FakeWebSocket.instances[0]!;
    socket.dispatchMessage({ type: 'snapshot', sessions: [session('s1', { name: 'Gimli' })], approvals: [] });

    socket.dispatchMessage({ type: 'session.created', session: session('s1', { name: 'Gimli' }) });

    expect(service.sessions()).toHaveLength(1);
  });

  it('appends a session.created event for a session not already known', () => {
    const service = new FleetEventsService();
    service.connect();
    const socket = FakeWebSocket.instances[0]!;
    socket.dispatchMessage({ type: 'snapshot', sessions: [session('s1')], approvals: [] });

    socket.dispatchMessage({ type: 'session.created', session: session('s2') });

    expect(service.sessions().map((s) => s.id)).toEqual(['s1', 's2']);
  });
});

describe('FleetEventsService reconnect', () => {
  beforeEach(() => {
    FakeWebSocket.instances = [];
    vi.stubGlobal('WebSocket', FakeWebSocket);
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('marks disconnected on close and reconnects after a 1s backoff', () => {
    const service = new FleetEventsService();
    service.connect();
    FakeWebSocket.instances[0]!.dispatchOpen();
    expect(service.connected()).toBe(true);

    FakeWebSocket.instances[0]!.dispatchClose();
    expect(service.connected()).toBe(false);
    expect(FakeWebSocket.instances).toHaveLength(1);

    vi.advanceTimersByTime(999);
    expect(FakeWebSocket.instances).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(FakeWebSocket.instances).toHaveLength(2);
  });

  it('caps the backoff delay at 10s after repeated failures', () => {
    const service = new FleetEventsService();
    service.connect();

    FakeWebSocket.instances[0]!.dispatchClose();
    vi.advanceTimersByTime(1000);
    FakeWebSocket.instances[1]!.dispatchClose();
    vi.advanceTimersByTime(2000);
    FakeWebSocket.instances[2]!.dispatchClose();
    vi.advanceTimersByTime(4000);
    FakeWebSocket.instances[3]!.dispatchClose();
    vi.advanceTimersByTime(8000);
    FakeWebSocket.instances[4]!.dispatchClose();

    vi.advanceTimersByTime(9999);
    expect(FakeWebSocket.instances).toHaveLength(5);
    vi.advanceTimersByTime(1);
    expect(FakeWebSocket.instances).toHaveLength(6);
  });

  it('resets the backoff to 1s after a successful reconnect', () => {
    const service = new FleetEventsService();
    service.connect();

    FakeWebSocket.instances[0]!.dispatchClose();
    vi.advanceTimersByTime(1000);
    FakeWebSocket.instances[1]!.dispatchOpen();
    FakeWebSocket.instances[1]!.dispatchClose();

    vi.advanceTimersByTime(999);
    expect(FakeWebSocket.instances).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(FakeWebSocket.instances).toHaveLength(3);
  });

  it('resyncs sessions from a fresh snapshot on reconnect', () => {
    const service = new FleetEventsService();
    service.connect();
    FakeWebSocket.instances[0]!.dispatchOpen();
    FakeWebSocket.instances[0]!.dispatchMessage({ type: 'snapshot', sessions: [session('s1')], approvals: [] });
    expect(service.sessions()).toEqual([session('s1')]);

    FakeWebSocket.instances[0]!.dispatchClose();
    vi.advanceTimersByTime(1000);
    FakeWebSocket.instances[1]!.dispatchOpen();
    FakeWebSocket.instances[1]!.dispatchMessage({ type: 'snapshot', sessions: [session('s2')], approvals: [] });

    expect(service.sessions()).toEqual([session('s2')]);
  });

  it('increments reconnectCount only on a reconnect, not the first connect', () => {
    const service = new FleetEventsService();
    service.connect();
    FakeWebSocket.instances[0]!.dispatchOpen();
    expect(service.reconnectCount()).toBe(0);

    FakeWebSocket.instances[0]!.dispatchClose();
    vi.advanceTimersByTime(1000);
    FakeWebSocket.instances[1]!.dispatchOpen();
    expect(service.reconnectCount()).toBe(1);
  });
});
