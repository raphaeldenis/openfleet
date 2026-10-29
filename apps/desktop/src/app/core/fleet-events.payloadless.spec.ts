import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Observable } from 'rxjs';
import { FleetEventsService } from './fleet-events.service';

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
];

const aSession = { id: 's1', name: 'Gimli', emoji: '⚔️', directory: '/tmp', harness: 'fake', state: 'idle', stateSince: 't', createdAt: 't' };

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

  it('does not warn on a valid frame', () => {
    socket().dispatchMessage({ type: 'session.updated', session: aSession });

    expect(consoleWarn).not.toHaveBeenCalled();
  });
});
