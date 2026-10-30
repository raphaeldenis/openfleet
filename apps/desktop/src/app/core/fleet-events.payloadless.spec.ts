import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import type { Observable } from 'rxjs';
import { EVENT_TYPES_WITHOUT_REQUIRED_PAYLOAD, FleetEventsService, type PayloadCarryingEventType } from './fleet-events.service';

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  private readonly listeners: Record<string, ((event: { data: string }) => void)[]> = {};
  readyState = FakeWebSocket.CONNECTING;

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
  }

  addEventListener(type: string, listener: (event: { data: string }) => void): void {
    (this.listeners[type] ??= []).push(listener);
  }

  open(): void {
    this.readyState = FakeWebSocket.OPEN;
    for (const listener of this.listeners['open'] ?? []) listener({ data: '' });
  }

  dispatchMessage(payload: unknown): void {
    for (const listener of this.listeners['message'] ?? []) listener({ data: JSON.stringify(payload) });
  }
}

const TYPES_THAT_READ_A_PAYLOAD = [
  'snapshot',
  'session.todos',
  'session.working_state',
  'session.created',
  'session.updated',
  'session.state',
  'session.closed',
  'session.output',
  'session.replay',
  'session.model_changed',
  'session.permission_mode_changed',
  'session.reopened',
  'message.delivered',
  'approval.created',
  'approval.resolved',
  'governance.proposed',
  'governance.resolved',
  'governance.queue_changed',
  'escalation.raised',
  'escalation.resolved',
  'law.created',
  'law.updated',
  'law.withdrawn',
  'manager.created',
  'manager.pulsed',
  'manager.updated',
  'error',
  'daemon.issues',
  'permission.silent_blocks',
  'notification.trigger',
  'note.created',
  'note.updated',
  'note.deleted',
] as const;

const aSession = { id: 's1', name: 'Gimli', emoji: '⚔️', directory: '/tmp', harness: 'fake', state: 'idle', stateSince: 't', createdAt: 't' };

const MINIMAL_VALID_FRAME_OF: Record<(typeof TYPES_THAT_READ_A_PAYLOAD)[number], Record<string, unknown>> = {
  'snapshot': { sessions: [], approvals: [] },
  'session.todos': { todos: {} },
  'session.working_state': { state: { sessionId: 's1' } },
  'session.created': { session: aSession },
  'session.updated': { session: aSession },
  'session.state': { sessionId: 's1', state: 'idle' },
  'session.closed': { sessionId: 's1' },
  'session.output': { sessionId: 's1', data: 'x' },
  'session.replay': { sessionId: 's1', data: 'x' },
  'session.model_changed': { sessionId: 's1', model: 'm' },
  'session.permission_mode_changed': { sessionId: 's1', mode: 'plan' },
  'session.reopened': { sessionId: 's1' },
  'message.delivered': { messageId: 'm1' },
  'approval.created': { approval: { id: 'a1' } },
  'approval.resolved': { approval: { id: 'a1' } },
  'governance.proposed': { proposal: { id: 'p1', status: 'pending' } },
  'governance.resolved': { proposal: { id: 'p1' } },
  'governance.queue_changed': { managerId: 'm1', queuedCount: 0 },
  'escalation.raised': { escalation: { id: 'e1', status: 'pending' } },
  'escalation.resolved': { escalation: { id: 'e1', status: 'answered' } },
  'law.created': { law: { id: 'l1' } },
  'law.updated': { law: { id: 'l1' } },
  'law.withdrawn': { law: { id: 'l1' } },
  'manager.created': { manager: { sessionId: 's1' } },
  'manager.pulsed': { manager: { sessionId: 's1' } },
  'manager.updated': { manager: { sessionId: 's1' } },
  'error': { error: { kind: 'internal', error: 'boom' } },
  'daemon.issues': { issues: [] },
  'permission.silent_blocks': { blocks: [] },
  'notification.trigger': { category: 'approval' },
  'note.created': { noteId: 'n1' },
  'note.updated': { noteId: 'n1' },
  'note.deleted': { noteId: 'n1' },
};

describe('FleetEventsService frames without their payload', () => {
  let service: FleetEventsService;
  let consoleError: ReturnType<typeof vi.spyOn>;
  let consoleWarn: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    FakeWebSocket.instances = [];
    vi.stubGlobal('WebSocket', FakeWebSocket);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({ ticket: 't' }) }));
    consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    service = new FleetEventsService();
    await service.connect();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  const socket = () => FakeWebSocket.instances[0]!;

  const observableStateOf = (fleet: FleetEventsService) => ({
    sessions: fleet.sessions(),
    approvals: fleet.approvals(),
    managers: fleet.managers(),
    proposals: fleet.proposals(),
    escalations: fleet.escalations(),
    knownEscalationIds: fleet.knownEscalationIds(),
    queuedCounts: (fleet as unknown as { queuedCounts: () => unknown }).queuedCounts(),
    queuedTotal: fleet.queuedTotal(),
    workingStates: fleet.workingStates(),
    workingStatesReported: fleet.workingStatesReported(),
    todos: fleet.todos(),
    todoSummaries: fleet.todoSummaries(),
    todosReported: fleet.todosReported(),
    sessionIdsWithRetainedTodos: fleet.sessionIdsWithRetainedTodos(),
    daemonIssues: fleet.daemonIssues(),
    backgroundFailures: fleet.backgroundFailures(),
    silentBlocks: fleet.silentBlocks(),
    snapshotReceived: fleet.snapshotReceived(),
    deliveredMessageIds: fleet.deliveredMessageIds(),
    reconnectCount: fleet.reconnectCount(),
    connected: fleet.connected(),
    workingStateMaxAgeMinutes: fleet.workingStateMaxAgeMinutes(),
    workingStateMaxBytes: fleet.workingStateMaxBytes(),
    dismissedSilentBlockKeys: (fleet as unknown as { dismissedSilentBlockKeys: () => unknown }).dismissedSilentBlockKeys(),
    todoEventCounts: new Map((fleet as unknown as { todoEventCounts: Map<string, number> }).todoEventCounts),
    sessionIdWhoseTodosAreKept: (fleet as unknown as { sessionIdWhoseTodosAreKept?: string }).sessionIdWhoseTodosAreKept,
  });

  const listenToEverySubject = (fleet: FleetEventsService) => {
    const subjects: Observable<unknown>[] = [
      fleet.liveOutputSessionIds,
      fleet.typedInSessionIds,
      fleet.notificationTriggers,
      fleet.noteChanges,
      fleet.lawChanges,
      fleet.output('s1'),
      fleet.output(undefined as unknown as string),
    ];
    const received = vi.fn();
    for (const subject of subjects) subject.subscribe(received);
    return received;
  };

  it.each(TYPES_THAT_READ_A_PAYLOAD)('leaves everything untouched on a %s frame that carries no payload, then applies the valid event after it', (type) => {
    socket().dispatchMessage({ type: 'session.created', session: aSession });
    const stateBefore = observableStateOf(service);
    const subscriberCalled = listenToEverySubject(service);

    socket().dispatchMessage({ type });

    expect(observableStateOf(service)).toStrictEqual(stateBefore);
    expect(subscriberCalled).not.toHaveBeenCalled();
    expect(consoleError).not.toHaveBeenCalled();
    socket().dispatchMessage({ type: 'session.updated', session: { ...aSession, name: 'Gandalf' } });
    expect(service.sessions().map((s) => s.name)).toEqual(['Gandalf']);
  });

  it('applies a valid daemon.issues after a payloadless one', () => {
    socket().dispatchMessage({ type: 'daemon.issues' });

    socket().dispatchMessage({ type: 'daemon.issues', issues: [] });

    expect(service.daemonIssues()).toStrictEqual([]);
  });

  it('applies a valid message.delivered after a payloadless one', () => {
    socket().dispatchMessage({ type: 'message.delivered' });

    socket().dispatchMessage({ type: 'message.delivered', sessionId: 's1', messageId: 'm1' });

    expect([...service.deliveredMessageIds()]).toEqual(['m1']);
  });

  it('applies a valid governance.queue_changed after a payloadless one', () => {
    socket().dispatchMessage({ type: 'governance.queue_changed' });

    socket().dispatchMessage({ type: 'governance.queue_changed', managerId: 'm1', queuedCount: 3 });

    expect(service.queuedTotal()).toBe(3);
  });

  it.each(TYPES_THAT_READ_A_PAYLOAD)('warns exactly once, naming the type, when it drops a %s frame, and reports no error', (type) => {
    socket().dispatchMessage({ type });

    expect(consoleWarn).toHaveBeenCalledTimes(1);
    expect(String(consoleWarn.mock.calls[0]![0])).toContain(type);
    expect(consoleError).not.toHaveBeenCalled();
  });

  it.each(['constructor', 'toString', '__proto__', 'hasOwnProperty'])('ignores a %s frame like any unknown type, without throwing or warning', (inheritedKey) => {
    const stateBefore = observableStateOf(service);

    expect(() => socket().dispatchMessage({ type: inheritedKey })).not.toThrow();

    expect(observableStateOf(service)).toStrictEqual(stateBefore);
    expect(consoleWarn).not.toHaveBeenCalled();
  });

  it('covers every ServerEvent type that carries a payload, and only those', () => {
    expectTypeOf<PayloadCarryingEventType>().toEqualTypeOf<(typeof TYPES_THAT_READ_A_PAYLOAD)[number]>();
  });

  it('does not warn on a valid frame', () => {
    socket().dispatchMessage({ type: 'session.updated', session: aSession });

    expect(consoleWarn).not.toHaveBeenCalled();
  });

  it.each(Object.entries(MINIMAL_VALID_FRAME_OF))('does not warn on a minimal valid %s frame', (type, payload) => {
    socket().dispatchMessage({ type, ...payload });

    expect(consoleWarn).not.toHaveBeenCalled();
    expect(consoleError).not.toHaveBeenCalled();
  });

  it.each([...EVENT_TYPES_WITHOUT_REQUIRED_PAYLOAD, 'a.type.from.the.future'])('does not warn on a bare %s frame', (type) => {
    socket().dispatchMessage({ type });

    expect(consoleWarn).not.toHaveBeenCalled();
  });

  it('warns once per type for a repeated bad frame, and again for a different type', () => {
    socket().dispatchMessage({ type: 'session.created' });
    socket().dispatchMessage({ type: 'session.created' });
    socket().dispatchMessage({ type: 'session.updated' });

    expect(consoleWarn).toHaveBeenCalledTimes(2);
  });

  it('warns again about a type after the socket reconnects', () => {
    socket().dispatchMessage({ type: 'session.created' });

    socket().open();
    socket().dispatchMessage({ type: 'session.created' });

    expect(consoleWarn).toHaveBeenCalledTimes(2);
  });
});
