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
    localStorage.clear();
  });
  afterEach(() => {
    localStorage.clear();
  });

  it('builds a ws URL with a single slash before "ws" even when apiUrl was stored with a trailing slash', () => {
    localStorage.setItem('openfleet.apiUrl', 'http://127.0.0.1:7331/');
    const service = new FleetEventsService();

    service.connect();

    expect(FakeWebSocket.instances[0]!.url).toMatch(/[^/]\/ws\?/);
  });

  it('builds a wss:// URL when apiUrl is stored as https', () => {
    localStorage.setItem('openfleet.apiUrl', 'https://h:1');
    const service = new FleetEventsService();

    service.connect();

    expect(FakeWebSocket.instances[0]!.url).toMatch(/^wss:\/\/h:1\/ws\?/);
  });

  it('keeps a path prefix from apiUrl ahead of the /ws segment', () => {
    localStorage.setItem('openfleet.apiUrl', 'http://h:1/openfleet/');
    const service = new FleetEventsService();

    service.connect();

    expect(FakeWebSocket.instances[0]!.url).toMatch(/^ws:\/\/h:1\/openfleet\/ws\?/);
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

  it('has not received a snapshot yet right after connecting, so a direct route load can show a loading state', () => {
    const service = new FleetEventsService();
    service.connect();

    expect(service.snapshotReceived()).toBe(false);
  });

  it('marks the snapshot as received once the first snapshot event arrives', () => {
    const service = new FleetEventsService();
    service.connect();
    const socket = FakeWebSocket.instances[0]!;

    socket.dispatchMessage({ type: 'snapshot', sessions: [], approvals: [] });

    expect(service.snapshotReceived()).toBe(true);
  });

  it('applies a session.updated event (a PATCH rename) to the live session list instead of dropping it as an unknown event', () => {
    const service = new FleetEventsService();
    service.connect();
    const socket = FakeWebSocket.instances[0]!;
    socket.dispatchMessage({ type: 'snapshot', sessions: [session('s1', { name: 'Gimli' })], approvals: [] });

    socket.dispatchMessage({ type: 'session.updated', session: session('s1', { name: 'Legolas' }) });

    expect(service.sessions()).toEqual([session('s1', { name: 'Legolas' })]);
  });

  it('patches a session\'s model on session.model_changed, so the model selector reflects an applied switch', () => {
    const service = new FleetEventsService();
    service.connect();
    const socket = FakeWebSocket.instances[0]!;
    socket.dispatchMessage({ type: 'snapshot', sessions: [session('s1')], approvals: [] });

    socket.dispatchMessage({ type: 'session.model_changed', sessionId: 's1', model: 'claude-opus-5-5' });

    expect(service.sessions()[0]!.model).toBe('claude-opus-5-5');
  });

  it('patches a session\'s permission mode on session.permission_mode_changed, so the label reflects an applied switch without waiting for the relaunch', () => {
    const service = new FleetEventsService();
    service.connect();
    const socket = FakeWebSocket.instances[0]!;
    socket.dispatchMessage({ type: 'snapshot', sessions: [session('s1')], approvals: [] });

    socket.dispatchMessage({ type: 'session.permission_mode_changed', sessionId: 's1', mode: 'bypassPermissions' });

    expect(service.sessions()[0]!.permissionMode).toBe('bypassPermissions');
  });

  it('moves a closed session to starting and clears its exit code on session.reopened, so Resume reflects the relaunch live', () => {
    const service = new FleetEventsService();
    service.connect();
    const socket = FakeWebSocket.instances[0]!;
    socket.dispatchMessage({ type: 'snapshot', sessions: [{ ...session('s1', { state: 'closed' }), exitCode: 1 }], approvals: [] });

    socket.dispatchMessage({ type: 'session.reopened', sessionId: 's1' });

    expect(service.sessions()[0]!.state).toBe('starting');
    expect(service.sessions()[0]!.exitCode).toBeUndefined();
  });
});

describe('FleetEventsService message delivery', () => {
  beforeEach(() => {
    FakeWebSocket.instances = [];
    vi.stubGlobal('WebSocket', FakeWebSocket);
  });

  it('has not delivered a message before its message.delivered event arrives', () => {
    const service = new FleetEventsService();
    expect(service.deliveredMessageIds().has('m1')).toBe(false);
  });

  it('marks a message delivered on message.delivered, so the composer can flip queued to sent', () => {
    const service = new FleetEventsService();
    service.connect();
    const socket = FakeWebSocket.instances[0]!;
    socket.dispatchMessage({ type: 'snapshot', sessions: [], approvals: [] });

    socket.dispatchMessage({ type: 'message.delivered', sessionId: 's1', messageId: 'm1' });

    expect(service.deliveredMessageIds().has('m1')).toBe(true);
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

  it('adds a manager announced by manager.pulsed that the client has not seen before, instead of dropping the event', () => {
    const service = new FleetEventsService();
    service.connect();
    const socket = FakeWebSocket.instances[0]!;
    socket.dispatchMessage({ type: 'snapshot', sessions: [], approvals: [], managers: [] });
    socket.dispatchMessage({ type: 'manager.pulsed', manager: manager('unseen') });
    expect(service.managers()).toEqual([manager('unseen')]);
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
