import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

  beforeEach(async () => {
    FakeWebSocket.instances = [];
    vi.stubGlobal('WebSocket', FakeWebSocket);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({ ticket: 't' }) }));
    consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    service = new FleetEventsService();
    await service.connect();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  const socket = () => FakeWebSocket.instances[0]!;

  it.each(TYPES_THAT_READ_A_PAYLOAD)('ignores a %s frame that carries no payload, and applies the valid event after it', (type) => {
    const deliverPayloadlessFrame = () => socket().dispatchMessage({ type });
    expect(deliverPayloadlessFrame).not.toThrow();

    socket().dispatchMessage({ type: 'session.created', session: aSession });

    expect(service.sessions().map((s) => s.id)).toEqual(['s1']);
    expect(consoleError).not.toHaveBeenCalled();
  });

  it('still applies a valid session.updated', () => {
    socket().dispatchMessage({ type: 'session.updated', session: aSession });

    expect(service.sessions().map((s) => s.id)).toEqual(['s1']);
  });
});
