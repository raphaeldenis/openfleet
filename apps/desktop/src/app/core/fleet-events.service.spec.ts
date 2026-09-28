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
    // Mirrors the real WebSocket: it throws InvalidStateError for a send while CONNECTING or CLOSED,
    // so a test here catches a guard the service forgot exactly like a real socket would.
    if (this.readyState !== FakeWebSocket.OPEN) throw new DOMException('WebSocket is not open', 'InvalidStateError');
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
    localStorage.setItem('openfleet.apiUrl', 'https://127.0.0.1:1');
    const service = new FleetEventsService();

    service.connect();

    expect(FakeWebSocket.instances[0]!.url).toMatch(/^wss:\/\/127\.0\.0\.1:1\/ws\?/);
  });

  it('keeps a path prefix from apiUrl ahead of the /ws segment', () => {
    localStorage.setItem('openfleet.apiUrl', 'http://127.0.0.1:1/openfleet/');
    const service = new FleetEventsService();

    service.connect();

    expect(FakeWebSocket.instances[0]!.url).toMatch(/^ws:\/\/127\.0\.0\.1:1\/openfleet\/ws\?/);
  });

  describe('where the admin token goes', () => {
    it.each([
      ['a remote host', 'http://evil:1'],
      ['a host that starts with localhost', 'http://localhost.evil.com'],
      ['userinfo hiding the real host', 'http://x@evil.com'],
      ['a wildcard-DNS host embedding the loopback address', 'http://127.0.0.1.nip.io'],
      ['the IPv4-mapped IPv6 loopback', 'http://[::ffff:7f00:1]:7331'],
    ])('opens the socket on the default daemon, not on %s (%s)', (_label, storedApiUrl) => {
      localStorage.setItem('openfleet.adminToken', 'secret-token');
      localStorage.setItem('openfleet.apiUrl', storedApiUrl);
      const service = new FleetEventsService();

      service.connect();

      expect(FakeWebSocket.instances[0]!.url).toBe('ws://127.0.0.1:7331/ws?token=secret-token');
    });

    it('opens the socket on the stored loopback daemon with the token', () => {
      localStorage.setItem('openfleet.adminToken', 'secret-token');
      localStorage.setItem('openfleet.apiUrl', 'http://localhost:9999');
      const service = new FleetEventsService();

      service.connect();

      expect(FakeWebSocket.instances[0]!.url).toBe('ws://localhost:9999/ws?token=secret-token');
    });

    it('sends a whitespace-only stored token as no token', () => {
      localStorage.setItem('openfleet.adminToken', '   ');
      const service = new FleetEventsService();

      service.connect();

      expect(FakeWebSocket.instances[0]!.url).toBe('ws://127.0.0.1:7331/ws?token=');
    });
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

describe('FleetEventsService offline sends (AUD-14)', () => {
  beforeEach(() => {
    FakeWebSocket.instances = [];
    vi.stubGlobal('WebSocket', FakeWebSocket);
  });

  function sentTypes(socket: FakeWebSocket) {
    return socket.sent.map((raw) => (JSON.parse(raw) as { type: string }).type);
  }

  it('sends nothing and throws nothing while the socket is still connecting', () => {
    const service = new FleetEventsService();
    service.connect();
    const socket = FakeWebSocket.instances[0]!;

    expect(() => service.sendInput('s1', 'y')).not.toThrow();
    expect(() => service.sendResize('s1', 80, 24)).not.toThrow();
    expect(() => service.sendAttach('s1')).not.toThrow();

    expect(socket.sent).toEqual([]);
  });

  it('sends nothing and throws nothing once the socket has closed', () => {
    const service = new FleetEventsService();
    service.connect();
    const socket = FakeWebSocket.instances[0]!;
    socket.dispatchOpen();
    socket.dispatchClose();

    expect(() => service.sendInput('s1', 'y')).not.toThrow();
    expect(() => service.sendResize('s1', 80, 24)).not.toThrow();
    expect(() => service.sendAttach('s1')).not.toThrow();

    expect(socket.sent).toEqual([]);
  });

  it('sends normally once the socket is open', () => {
    const service = new FleetEventsService();
    service.connect();
    const socket = FakeWebSocket.instances[0]!;
    socket.dispatchOpen();

    service.sendInput('s1', 'y');
    service.sendResize('s1', 80, 24);
    service.sendAttach('s1');

    expect(sentTypes(socket)).toEqual(['input', 'resize', 'attach']);
  });

  it('drops a keystroke sent while offline for good — it never replays once the socket opens', () => {
    const service = new FleetEventsService();
    service.connect();
    const socket = FakeWebSocket.instances[0]!;

    service.sendInput('s1', 'y');
    socket.dispatchOpen();

    expect(sentTypes(socket)).not.toContain('input');
  });

  it('queues an attach requested while connecting, deduplicated per session, and flushes it once on open', () => {
    const service = new FleetEventsService();
    service.connect();
    const socket = FakeWebSocket.instances[0]!;

    service.sendAttach('s1');
    service.sendAttach('s1'); // repeat request for the same session while still offline
    service.sendAttach('s2');
    socket.dispatchOpen();

    const attaches = socket.sent.map((raw) => JSON.parse(raw) as { type: string; sessionId: string }).filter((m) => m.type === 'attach');
    expect(attaches).toEqual([{ type: 'attach', sessionId: 's1' }, { type: 'attach', sessionId: 's2' }]);
  });

  it('keeps only the latest resize per session while offline, and flushes that one on open', () => {
    const service = new FleetEventsService();
    service.connect();
    const socket = FakeWebSocket.instances[0]!;

    service.sendResize('s1', 80, 24);
    service.sendResize('s1', 100, 40);
    socket.dispatchOpen();

    const resizes = socket.sent.map((raw) => JSON.parse(raw)).filter((m) => m.type === 'resize');
    expect(resizes).toEqual([{ type: 'resize', sessionId: 's1', cols: 100, rows: 40 }]);
  });
});

describe('FleetEventsService closedAt', () => {
  const CLOSED_AT = '2026-09-26T10:00:00.000Z';

  function sessionWithClosedAt(id: string, state: string, closedAt: string | undefined = CLOSED_AT) {
    return { ...session(id, { state }), closedAt };
  }

  function connectedServiceWith(sessions: unknown[]) {
    const service = new FleetEventsService();
    service.connect();
    const socket = FakeWebSocket.instances[0]!;
    socket.dispatchMessage({ type: 'snapshot', sessions, approvals: [] });
    return { service, socket };
  }

  beforeEach(() => {
    FakeWebSocket.instances = [];
    vi.stubGlobal('WebSocket', FakeWebSocket);
    localStorage.clear();
  });

  describe('snapshot', () => {
    it.each([
      ['closed', CLOSED_AT],
      ['starting', CLOSED_AT],
      ['idle', undefined],
      ['generating', undefined],
    ])('a %s session comes out of the snapshot with closedAt %s', (state, expectedClosedAt) => {
      const { service } = connectedServiceWith([sessionWithClosedAt('s1', state)]);

      expect(service.sessions()[0]!.closedAt).toBe(expectedClosedAt);
    });
  });

  describe('session.updated and session.created', () => {
    it('drops the stale closedAt a model relaunch brings back on the full row of a session that was live', () => {
      const { service, socket } = connectedServiceWith([session('s1', { state: 'idle' })]);
      socket.dispatchMessage({ type: 'session.state', sessionId: 's1', state: 'starting', stateSince: 't2' });

      socket.dispatchMessage({ type: 'session.updated', session: sessionWithClosedAt('s1', 'starting') });

      expect(service.sessions()[0]!.closedAt).toBeUndefined();
    });

    it('drops the stale closedAt a rename of a live session brings back', () => {
      const { service, socket } = connectedServiceWith([session('s1', { state: 'idle' })]);

      socket.dispatchMessage({ type: 'session.updated', session: sessionWithClosedAt('s1', 'idle') });

      expect(service.sessions()[0]!.closedAt).toBeUndefined();
    });

    it('keeps the closedAt of a full row that arrives while the session is coming back from a close', () => {
      const { service, socket } = connectedServiceWith([sessionWithClosedAt('s1', 'closed')]);
      socket.dispatchMessage({ type: 'session.state', sessionId: 's1', state: 'starting', stateSince: 't2' });

      socket.dispatchMessage({ type: 'session.updated', session: sessionWithClosedAt('s1', 'starting') });

      expect(service.sessions()[0]!.closedAt).toBe(CLOSED_AT);
    });

    it('keeps the closedAt of a full row of a session that is closed', () => {
      const { service, socket } = connectedServiceWith([session('s1', { state: 'idle' })]);
      socket.dispatchMessage({ type: 'session.closed', sessionId: 's1', exitCode: 0 });

      socket.dispatchMessage({ type: 'session.updated', session: sessionWithClosedAt('s1', 'closed') });

      expect(service.sessions()[0]!.closedAt).toBe(CLOSED_AT);
    });
  });

  describe('patches', () => {
    it('keeps the closedAt of a closed session while it starts again, and drops it once it is live', () => {
      const { service, socket } = connectedServiceWith([sessionWithClosedAt('s1', 'closed')]);

      socket.dispatchMessage({ type: 'session.state', sessionId: 's1', state: 'starting', stateSince: 't2' });
      expect(service.sessions()[0]!.closedAt).toBe(CLOSED_AT);

      socket.dispatchMessage({ type: 'session.state', sessionId: 's1', state: 'idle', stateSince: 't3' });
      expect(service.sessions()[0]!.closedAt).toBeUndefined();
    });

    it('stamps a closedAt on a session closed live once it is reopened, and drops it once it is live', () => {
      const { service, socket } = connectedServiceWith([session('s1', { state: 'idle' })]);
      socket.dispatchMessage({ type: 'session.closed', sessionId: 's1', exitCode: 0 });

      socket.dispatchMessage({ type: 'session.reopened', sessionId: 's1' });
      expect(service.sessions()[0]!.closedAt).toBeDefined();

      socket.dispatchMessage({ type: 'session.state', sessionId: 's1', state: 'idle', stateSince: 't3' });
      expect(service.sessions()[0]!.closedAt).toBeUndefined();
    });

    it('gives a live session that relaunches no closedAt', () => {
      const { service, socket } = connectedServiceWith([sessionWithClosedAt('s1', 'idle')]);

      socket.dispatchMessage({ type: 'session.state', sessionId: 's1', state: 'starting', stateSince: 't2' });

      expect(service.sessions()[0]!.closedAt).toBeUndefined();
    });
  });
});
