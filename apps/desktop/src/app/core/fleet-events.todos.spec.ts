import type { SessionTodos } from '@openfleet/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FleetEventsService } from './fleet-events.service';

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 3;
  private readonly listeners: Record<string, ((event: { data: string }) => void)[]> = {};
  readyState = FakeWebSocket.CONNECTING;

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
  }

  addEventListener(type: string, listener: (event: { data: string }) => void): void {
    (this.listeners[type] ??= []).push(listener);
  }

  send(): void {}

  dispatchMessage(payload: unknown): void {
    for (const listener of this.listeners['message'] ?? []) listener({ data: JSON.stringify(payload) });
  }
}

function todosOf(sessionId: string, completed: number, total: number, extra: Partial<SessionTodos> = {}): SessionTodos {
  const items = Array.from({ length: total }, (_, index) => ({ id: String(index + 1), content: `Task ${index + 1}`, status: index < completed ? ('completed' as const) : ('pending' as const) }));
  return { sessionId, items, counts: { total, completed, inProgress: 0, pending: total - completed }, omitted: 0, source: 'task_tools', updatedAt: '2026-10-01T10:00:00.000Z', ...extra };
}

describe('FleetEventsService todos', () => {
  let socket: FakeWebSocket;
  let service: FleetEventsService;

  beforeEach(async () => {
    FakeWebSocket.instances = [];
    vi.stubGlobal('WebSocket', FakeWebSocket);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({ ticket: 'fake-ticket' }) }));
    service = new FleetEventsService();
    await service.connect();
    socket = FakeWebSocket.instances[0]!;
  });

  it('reports todos as supported when the snapshot carries todo summaries', () => {
    socket.dispatchMessage({ type: 'snapshot', sessions: [], approvals: [], todoSummaries: [{ sessionId: 's1', counts: { total: 3, completed: 1, inProgress: 0, pending: 2 }, updatedAt: 't' }] });

    expect(service.todosReported()).toBe(true);
    expect(service.todoSummaries().get('s1')?.counts.total).toBe(3);
  });

  it('reports todos as not supported when the snapshot of an older daemon carries none', () => {
    socket.dispatchMessage({ type: 'snapshot', sessions: [], approvals: [] });

    expect(service.todosReported()).toBe(false);
  });

  it('keeps the list of a session.todos event, and replaces it with the next one', () => {
    socket.dispatchMessage({ type: 'session.todos', todos: todosOf('s1', 1, 3) });
    socket.dispatchMessage({ type: 'session.todos', todos: todosOf('s1', 2, 3) });

    expect(service.todos().get('s1')?.counts.completed).toBe(2);
  });

  it('keeps the lists of two sessions apart', () => {
    socket.dispatchMessage({ type: 'session.todos', todos: todosOf('s1', 1, 3) });
    socket.dispatchMessage({ type: 'session.todos', todos: todosOf('s2', 0, 1) });

    expect(service.todos().get('s1')?.counts.total).toBe(3);
    expect(service.todos().get('s2')?.counts.total).toBe(1);
  });

  it('refreshes the summary of a session from its session.todos event', () => {
    socket.dispatchMessage({ type: 'session.todos', todos: todosOf('s1', 2, 4) });

    expect(service.todoSummaries().get('s1')).toEqual({ sessionId: 's1', counts: { total: 4, completed: 2, inProgress: 0, pending: 2 }, updatedAt: '2026-10-01T10:00:00.000Z' });
  });

  it('counts the session.todos events of a session, so a late answer to a request can tell it was overtaken', () => {
    const before = service.todoEventCount('s1');

    socket.dispatchMessage({ type: 'session.todos', todos: todosOf('s1', 1, 3) });

    expect(service.todoEventCount('s1')).toBe(before + 1);
    expect(service.todoEventCount('s2')).toBe(0);
  });

  it('stores a list fetched over REST for a session', () => {
    service.storeFetchedTodos(todosOf('s1', 1, 3));

    expect(service.todos().get('s1')?.counts.total).toBe(3);
  });
});
