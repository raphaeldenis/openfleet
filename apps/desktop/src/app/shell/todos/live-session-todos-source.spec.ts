import { TestBed } from '@angular/core/testing';
import type { ErrorEnvelope, SessionTodos } from '@openfleet/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, FleetApiService } from '../../core/fleet-api.service';
import { FleetEventsService } from '../../core/fleet-events.service';
import { LiveSessionTodosSource } from './live-session-todos-source';

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

  dispatchOpen(): void {
    this.readyState = FakeWebSocket.OPEN;
    for (const listener of this.listeners['open'] ?? []) listener({} as { data: string });
  }

  dispatchClose(): void {
    this.readyState = FakeWebSocket.CLOSED;
    for (const listener of this.listeners['close'] ?? []) listener({} as { data: string });
  }
}

function todosOf(sessionId: string, completed: number, total: number, extra: Partial<SessionTodos> = {}): SessionTodos {
  const items = Array.from({ length: total }, (_, index) => ({ id: String(index + 1), content: `Task ${index + 1}`, status: index < completed ? ('completed' as const) : ('pending' as const) }));
  return { sessionId, items, counts: { total, completed, inProgress: 0, pending: total - completed }, omitted: 0, source: 'task_tools', updatedAt: '2026-10-01T10:00:00.000Z', ...extra };
}

const NOTHING_RECORDED: Omit<SessionTodos, 'sessionId'> = { items: [], counts: { total: 0, completed: 0, inProgress: 0, pending: 0 }, omitted: 0, source: null, updatedAt: null };
const SUPPORTED_SNAPSHOT = { type: 'snapshot', sessions: [], approvals: [], todoSummaries: [] };

function envelopeOf(patch: Partial<ErrorEnvelope>): ErrorEnvelope {
  return { error: 'internal_error', kind: 'internal', retry: 'later', message: 'raw daemon message', ...patch };
}

describe('LiveSessionTodosSource', () => {
  let getSessionTodos: ReturnType<typeof vi.fn>;
  let events: FleetEventsService;
  let source: LiveSessionTodosSource;

  const socket = () => FakeWebSocket.instances.at(-1)!;
  const loadOf = (sessionId: string) => source.loadOf(sessionId)();
  const settle = async () => {
    TestBed.tick();
    await vi.advanceTimersByTimeAsync(0);
    TestBed.tick();
  };

  beforeEach(async () => {
    FakeWebSocket.instances = [];
    vi.useFakeTimers();
    vi.stubGlobal('WebSocket', FakeWebSocket);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({ ticket: 'fake-ticket' }) }));
    getSessionTodos = vi.fn().mockResolvedValue(todosOf('s1', 1, 3));
    TestBed.configureTestingModule({ providers: [{ provide: FleetApiService, useValue: { getSessionTodos } }] });
    events = TestBed.inject(FleetEventsService);
    source = TestBed.inject(LiveSessionTodosSource);
    await events.connect();
    socket().dispatchOpen();
    socket().dispatchMessage(SUPPORTED_SNAPSHOT);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('reads as loading until the daemon has sent its first snapshot', () => {
    events.snapshotReceived.set(false);
    events.todosReported.set(false);

    expect(loadOf('s1')).toEqual({ kind: 'loading' });
  });

  it('reads as unsupported when the daemon snapshot carries no todo summaries', () => {
    socket().dispatchMessage({ type: 'snapshot', sessions: [], approvals: [] });

    expect(loadOf('s1')).toEqual({ kind: 'unsupported' });
  });

  it('loads the list of the watched session over REST, once', async () => {
    source.watch('s1');
    await settle();

    expect(getSessionTodos).toHaveBeenCalledTimes(1);
    expect(getSessionTodos).toHaveBeenCalledWith('s1');
    expect(loadOf('s1')).toMatchObject({ kind: 'ready', todos: { sessionId: 's1', counts: { total: 3 } } });
  });

  it('asks nothing for a session nobody watches', async () => {
    source.watch('s1');
    await settle();

    expect(getSessionTodos).not.toHaveBeenCalledWith('s2');
    expect(loadOf('s2')).toEqual({ kind: 'loading' });
  });

  it('reads a session with nothing recorded as no list yet', async () => {
    getSessionTodos.mockResolvedValue({ sessionId: 's1', ...NOTHING_RECORDED });
    source.watch('s1');
    await settle();

    expect(loadOf('s1')).toEqual({ kind: 'ready', todos: null });
  });

  it('shows a list pushed by a session.todos event without asking over REST', async () => {
    socket().dispatchMessage({ type: 'session.todos', todos: todosOf('s1', 2, 3) });
    source.watch('s1');
    await settle();

    expect(getSessionTodos).not.toHaveBeenCalled();
    expect(loadOf('s1')).toMatchObject({ kind: 'ready', todos: { counts: { completed: 2 } } });
  });

  it('follows the session.todos events after the first load', async () => {
    source.watch('s1');
    await settle();

    socket().dispatchMessage({ type: 'session.todos', todos: todosOf('s1', 3, 3) });

    expect(loadOf('s1')).toMatchObject({ kind: 'ready', todos: { counts: { completed: 3 } } });
  });

  it('keeps the newer event when it overtakes the answer of the request', async () => {
    let answer!: (todos: SessionTodos) => void;
    getSessionTodos.mockReturnValue(new Promise<SessionTodos>((resolve) => { answer = resolve; }));
    source.watch('s1');
    await settle();

    socket().dispatchMessage({ type: 'session.todos', todos: todosOf('s1', 3, 3) });
    answer(todosOf('s1', 1, 3));
    await settle();

    expect(loadOf('s1')).toMatchObject({ kind: 'ready', todos: { counts: { completed: 3 } } });
  });

  describe('when the request fails', () => {
    it('says it cannot load the todos and offers to try again for a failure that can pass', async () => {
      getSessionTodos.mockRejectedValue(new ApiError(500, 'GET', 'internal_error', envelopeOf({ id: '3f9a1c2e' })));
      source.watch('s1');
      await settle();

      expect(loadOf('s1')).toEqual({ kind: 'error', text: 'The daemon hit an unexpected error — try again in a moment. (ref 3f9a1c2e)', retryable: true });
    });

    it('offers no retry for a failure that cannot pass', async () => {
      getSessionTodos.mockRejectedValue(new ApiError(404, 'GET', 'not_found', envelopeOf({ error: 'not_found', kind: 'not_found', retry: 'never' })));
      source.watch('s1');
      await settle();

      expect(loadOf('s1')).toEqual({ kind: 'error', text: 'That item no longer exists.', retryable: false });
    });

    it('offers no retry when the code alone says it cannot pass, even without a well-formed envelope', async () => {
      getSessionTodos.mockRejectedValue(new ApiError(404, 'GET', 'not_found'));
      source.watch('s1');
      await settle();

      expect(loadOf('s1')).toEqual({ kind: 'error', text: 'That item no longer exists.', retryable: false });
    });

    it('says it cannot load the todos when the daemon sends nothing more specific', async () => {
      getSessionTodos.mockRejectedValue(new ApiError(502, 'GET'));
      source.watch('s1');
      await settle();

      expect(loadOf('s1')).toEqual({ kind: 'error', text: "Can't load the todos — try again.", retryable: true });
    });

    it('says the daemon cannot be reached when the request never got an answer', async () => {
      getSessionTodos.mockRejectedValue(new TypeError('fetch failed'));
      source.watch('s1');
      await settle();

      expect(loadOf('s1')).toMatchObject({ kind: 'error', retryable: true, text: expect.stringContaining('Can’t reach the OpenFleet daemon') });
    });

    it('asks again on retry and shows the list once the daemon answers', async () => {
      getSessionTodos.mockRejectedValueOnce(new TypeError('fetch failed'));
      source.watch('s1');
      await settle();

      source.retry('s1');
      expect(loadOf('s1')).toEqual({ kind: 'loading' });
      await settle();

      expect(getSessionTodos).toHaveBeenCalledTimes(2);
      expect(loadOf('s1')).toMatchObject({ kind: 'ready', todos: { counts: { total: 3 } } });
    });
  });

  describe('after the socket reconnects', () => {
    async function reconnect() {
      socket().dispatchClose();
      await vi.advanceTimersByTimeAsync(1000);
      socket().dispatchOpen();
      await settle();
    }

    it('reloads the watched session, since events were missed while offline', async () => {
      source.watch('s1');
      await settle();
      getSessionTodos.mockResolvedValue(todosOf('s1', 3, 3));

      await reconnect();

      expect(getSessionTodos).toHaveBeenCalledTimes(2);
      expect(loadOf('s1')).toMatchObject({ kind: 'ready', todos: { counts: { completed: 3 } } });
    });

    it('asks nothing once the panel stopped watching', async () => {
      source.watch('s1');
      await settle();
      source.watch(undefined);

      await reconnect();

      expect(getSessionTodos).toHaveBeenCalledTimes(1);
    });

    it('reloads even when events were seen before the reconnect', async () => {
      socket().dispatchMessage({ type: 'session.todos', todos: todosOf('s1', 1, 3) });
      source.watch('s1');
      await settle();
      expect(getSessionTodos).not.toHaveBeenCalled();

      await reconnect();

      expect(getSessionTodos).toHaveBeenCalledTimes(1);
    });

    it('exposes the cached list as ready and stale when the reload after a reconnect fails', async () => {
      source.watch('s1');
      await settle();
      getSessionTodos.mockRejectedValue(new TypeError('fetch failed'));

      await reconnect();

      expect(loadOf('s1')).toMatchObject({ kind: 'ready', todos: { sessionId: 's1', counts: { total: 3 }, stale: true } });
    });

    it('shows the empty copy instead of the cached list when the reload says the session is gone', async () => {
      source.watch('s1');
      await settle();
      getSessionTodos.mockRejectedValue(new ApiError(404, 'GET', 'not_found', envelopeOf({ error: 'not_found', kind: 'not_found', retry: 'never' })));

      await reconnect();

      expect(loadOf('s1')).toEqual({ kind: 'ready', todos: null });
    });

    describe('while the answer of the request sent before the reconnect is still on its way', () => {
      let answerBeforeReconnect!: { resolve: (todos: SessionTodos) => void; reject: (error: unknown) => void };
      let answerAfterReconnect!: (todos: SessionTodos) => void;

      beforeEach(async () => {
        getSessionTodos
          .mockReturnValueOnce(new Promise<SessionTodos>((resolve, reject) => { answerBeforeReconnect = { resolve, reject }; }))
          .mockReturnValueOnce(new Promise<SessionTodos>((resolve) => { answerAfterReconnect = resolve; }));
        source.watch('s1');
        await settle();
        await reconnect();
        answerAfterReconnect(todosOf('s1', 3, 3));
        await settle();
      });

      it('ignores the older answer when it arrives after the newer one was stored', async () => {
        answerBeforeReconnect.resolve(todosOf('s1', 1, 3));
        await settle();

        expect(loadOf('s1')).toMatchObject({ kind: 'ready', todos: { counts: { completed: 3 } } });
      });

      it('ignores the older failure when it arrives after the newer answer was stored', async () => {
        answerBeforeReconnect.reject(new TypeError('fetch failed'));
        await settle();

        const load = loadOf('s1');
        expect(load).toMatchObject({ kind: 'ready', todos: { counts: { completed: 3 } } });
        expect(load.kind === 'ready' && load.todos?.stale).toBeUndefined();
      });
    });

    it('does not mark the list stale when the failure belongs to a request a newer one has replaced', async () => {
      source.watch('s1');
      await settle();
      let failBeforeRetry!: (error: unknown) => void;
      getSessionTodos
        .mockReturnValueOnce(new Promise<SessionTodos>((_, reject) => { failBeforeRetry = reject; }))
        .mockReturnValueOnce(new Promise<SessionTodos>(() => {}));
      await reconnect();
      source.retry('s1');

      failBeforeRetry(new TypeError('fetch failed'));
      await settle();

      const load = loadOf('s1');
      expect(load).toMatchObject({ kind: 'ready', todos: { counts: { total: 3 } } });
      expect(load.kind === 'ready' && load.todos?.stale).toBeUndefined();
    });

    it('reads the list as fresh again once a later event replaces the stale one', async () => {
      source.watch('s1');
      await settle();
      getSessionTodos.mockRejectedValue(new TypeError('fetch failed'));
      await reconnect();

      socket().dispatchMessage({ type: 'session.todos', todos: todosOf('s1', 2, 3) });

      const load = loadOf('s1');
      expect(load).toMatchObject({ kind: 'ready', todos: { counts: { completed: 2 } } });
      expect(load.kind === 'ready' && load.todos?.stale).toBeUndefined();
    });
  });

  it('asks once for a session shown again on the same connection', async () => {
    source.watch('s1');
    await settle();
    source.watch(undefined);
    await settle();

    source.watch('s1');
    await settle();

    expect(getSessionTodos).toHaveBeenCalledTimes(1);
  });

  describe('when a snapshot stops reporting a closed session', () => {
    const summaryOf = (sessionId: string) => ({ sessionId, counts: { total: 3, completed: 1, inProgress: 0, pending: 2 }, updatedAt: '2026-10-01T10:00:00.000Z' });

    it('reads the evicted closed list over REST again instead of showing the old one as fresh', async () => {
      socket().dispatchMessage({ type: 'session.todos', todos: todosOf('old', 1, 3) });
      socket().dispatchMessage({ type: 'snapshot', sessions: [], approvals: [], todoSummaries: [summaryOf('other')] });
      getSessionTodos.mockResolvedValue(todosOf('old', 3, 3));

      source.watch('old');
      expect(loadOf('old')).toEqual({ kind: 'loading' });
      await settle();

      expect(getSessionTodos).toHaveBeenCalledWith('old');
      expect(loadOf('old')).toMatchObject({ kind: 'ready', todos: { counts: { completed: 3 } } });
    });

    it('reads a session again over REST when it comes back on the same connection after the snapshot forgot it', async () => {
      source.watch('old');
      await settle();
      source.watch(undefined);
      await settle();
      socket().dispatchMessage({ type: 'snapshot', sessions: [], approvals: [], todoSummaries: [] });
      await settle();

      source.watch('old');
      await settle();

      expect(getSessionTodos).toHaveBeenCalledTimes(2);
    });

    it('keeps the list of the session on screen', async () => {
      source.watch('s1');
      await settle();

      socket().dispatchMessage({ type: 'snapshot', sessions: [], approvals: [], todoSummaries: [] });
      await settle();

      expect(getSessionTodos).toHaveBeenCalledTimes(1);
      expect(loadOf('s1')).toMatchObject({ kind: 'ready', todos: { counts: { total: 3 } } });
    });
  });

  describe('children progress of a manager', () => {
    const sessionOf = (id: string, patch: Record<string, unknown> = {}) => ({ id, name: id.toUpperCase(), emoji: '⛏️', state: 'idle', createdAt: '2026-10-01T09:00:00.000Z', parentId: 'm1', ...patch });
    const summaryOf = (sessionId: string, completed: number, total: number) => ({ sessionId, counts: { total, completed, inProgress: 0, pending: total - completed }, updatedAt: '2026-10-01T10:00:00.000Z' });
    const childrenOf = (managerId = 'm1') => source.childrenOf(managerId)();
    const readyChildren = () => {
      const load = childrenOf();
      return load.kind === 'ready' ? load.children : [];
    };

    it('lists the direct children only, open ones first then closed ones, each group in creation order', () => {
      socket().dispatchMessage({
        type: 'snapshot',
        sessions: [
          sessionOf('late-open', { createdAt: '2026-10-01T11:00:00.000Z' }),
          sessionOf('closed-early', { state: 'closed', createdAt: '2026-10-01T08:00:00.000Z' }),
          sessionOf('early-open', { createdAt: '2026-10-01T09:00:00.000Z' }),
          sessionOf('stranger-child', { parentId: 'other-manager' }),
          sessionOf('grandchild', { parentId: 'early-open' }),
        ],
        approvals: [],
        todoSummaries: [],
      });

      expect(readyChildren().map((child) => child.id)).toEqual(['early-open', 'late-open', 'closed-early']);
    });

    it('gives each child its own counts, and no counts to a child without a list', () => {
      socket().dispatchMessage({ type: 'snapshot', sessions: [sessionOf('a'), sessionOf('b'), sessionOf('c')], approvals: [], todoSummaries: [summaryOf('a', 2, 5), summaryOf('c', 0, 0)] });

      expect(readyChildren().map((child) => child.counts?.completed ?? null)).toEqual([2, null, null]);
      expect(readyChildren().map((child) => child.counts?.total ?? null)).toEqual([5, null, null]);
    });

    it('keeps the counts of a closed child', () => {
      socket().dispatchMessage({ type: 'snapshot', sessions: [sessionOf('a', { state: 'closed' })], approvals: [], todoSummaries: [summaryOf('a', 3, 4)] });

      expect(readyChildren()).toMatchObject([{ id: 'a', state: 'closed', counts: { completed: 3, total: 4 } }]);
    });

    it('follows a session.todos event of a child live', () => {
      socket().dispatchMessage({ type: 'snapshot', sessions: [sessionOf('a')], approvals: [], todoSummaries: [summaryOf('a', 1, 5)] });

      socket().dispatchMessage({ type: 'session.todos', todos: todosOf('a', 4, 5) });

      expect(readyChildren()[0]?.counts?.completed).toBe(4);
    });

    it('says a child is a manager so the row can open its dashboard', () => {
      socket().dispatchMessage({ type: 'snapshot', sessions: [sessionOf('sub', { role: 'manager' }), sessionOf('worker')], approvals: [], todoSummaries: [] });

      expect(readyChildren().map((child) => child.isManager)).toEqual([true, false]);
    });

    it('sorts a child whose creation date cannot be read after the others, whatever the order they arrive in', () => {
      socket().dispatchMessage({
        type: 'snapshot',
        sessions: [sessionOf('undated', { createdAt: 'not a date' }), sessionOf('late', { createdAt: '2026-10-01T11:00:00.000Z' }), sessionOf('early', { createdAt: '2026-10-01T08:00:00.000Z' })],
        approvals: [],
        todoSummaries: [],
      });

      expect(readyChildren().map((child) => child.id)).toEqual(['early', 'late', 'undated']);
    });

    it('reads a manager as unsupported when the daemon reports no todo summaries', () => {
      socket().dispatchMessage({ type: 'snapshot', sessions: [sessionOf('m1', { role: 'manager', parentId: undefined }), sessionOf('a')], approvals: [] });

      expect(childrenOf()).toEqual({ kind: 'unsupported' });
    });

    it('reads a worker as having no children, not as unsupported, when the daemon reports no todo summaries', () => {
      socket().dispatchMessage({ type: 'snapshot', sessions: [sessionOf('worker-1', { parentId: undefined })], approvals: [] });

      expect(childrenOf('worker-1')).toEqual({ kind: 'ready', children: [] });
    });

    it('reads as no children for a manager nobody parents', () => {
      expect(readyChildren()).toEqual([]);
    });
  });
});
