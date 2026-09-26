import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FleetEventsService } from './fleet-events.service';

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 3;
  private readonly listeners: Record<string, ((event: { data: string }) => void)[]> = {};
  readonly sent: string[] = [];
  readyState = FakeWebSocket.CONNECTING;

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
    this.readyState = FakeWebSocket.OPEN;
    for (const listener of this.listeners['open'] ?? []) listener({} as { data: string });
  }

  dispatchClose(): void {
    this.readyState = FakeWebSocket.CLOSED;
    for (const listener of this.listeners['close'] ?? []) listener({} as { data: string });
  }
}

function session(id: string, patch: Partial<{ name: string; state: string }> = {}) {
  return { id, name: patch.name ?? 'Gimli', emoji: '⚔️', directory: '/tmp', harness: 'fake', state: patch.state ?? 'idle', stateSince: 't', createdAt: 't' };
}

function manager(sessionId: string, patch: Partial<{ childrenCount: number; nextPulseAt: string }> = {}) {
  return { sessionId, pulseSeconds: 1800, childrenCap: 2, missionText: 'x', nextPulseAt: patch.nextPulseAt ?? 'later', childrenCount: patch.childrenCount ?? 0 };
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

  it('does not open a second socket when connect is called again while one is already open', () => {
    const service = new FleetEventsService();
    service.connect();
    FakeWebSocket.instances[0]!.dispatchOpen();

    service.connect();

    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it('does not open a second socket when connect is called again while one is still connecting', () => {
    const service = new FleetEventsService();
    service.connect();

    service.connect();

    expect(FakeWebSocket.instances).toHaveLength(1);
  });
});

describe('FleetEventsService managers', () => {
  beforeEach(() => {
    FakeWebSocket.instances = [];
    vi.stubGlobal('WebSocket', FakeWebSocket);
  });

  it('seeds managers from the snapshot event', () => {
    const service = new FleetEventsService();
    service.connect();
    const socket = FakeWebSocket.instances[0]!;
    socket.dispatchMessage({ type: 'snapshot', sessions: [], approvals: [], managers: [manager('m1')] });
    expect(service.managers()).toEqual([manager('m1')]);
  });

  it('defaults managers to empty when a snapshot omits the field, so older daemons do not crash the reducer', () => {
    const service = new FleetEventsService();
    service.connect();
    const socket = FakeWebSocket.instances[0]!;
    socket.dispatchMessage({ type: 'snapshot', sessions: [], approvals: [] });
    expect(service.managers()).toEqual([]);
  });

  it('upserts on manager.created', () => {
    const service = new FleetEventsService();
    service.connect();
    const socket = FakeWebSocket.instances[0]!;
    socket.dispatchMessage({ type: 'snapshot', sessions: [], approvals: [], managers: [] });
    socket.dispatchMessage({ type: 'manager.created', manager: manager('m1') });
    expect(service.managers()).toEqual([manager('m1')]);
  });

  it('upserts (not duplicates) on manager.pulsed, refreshing its nextPulseAt and childrenCount', () => {
    const service = new FleetEventsService();
    service.connect();
    const socket = FakeWebSocket.instances[0]!;
    socket.dispatchMessage({ type: 'snapshot', sessions: [], approvals: [], managers: [manager('m1', { nextPulseAt: 'soon' })] });
    socket.dispatchMessage({ type: 'manager.pulsed', manager: manager('m1', { nextPulseAt: 'later', childrenCount: 1 }) });
    expect(service.managers()).toEqual([manager('m1', { nextPulseAt: 'later', childrenCount: 1 })]);
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
