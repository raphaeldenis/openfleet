import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, FleetApiService } from './fleet-api.service';

function fakeResponse(init: { ok: boolean; status: number; json: () => Promise<unknown> }) {
  return init as unknown as Response;
}

describe('FleetApiService.getSessionTodos', () => {
  let api: FleetApiService;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    api = new FleetApiService();
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => vi.unstubAllGlobals());

  it('reads the todos of one session', async () => {
    const body = { sessionId: 's1', items: [], counts: { total: 0, completed: 0, inProgress: 0, pending: 0 }, omitted: 0, source: null, updatedAt: null };
    fetchMock.mockResolvedValue(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve(body) }));

    await expect(api.getSessionTodos('s1')).resolves.toEqual(body);

    expect(String(fetchMock.mock.calls[0]![0])).toMatch(/\/api\/sessions\/s1\/todos$/);
  });

  it('escapes the session id in the path', async () => {
    const body = { sessionId: 'a/b', items: [], counts: { total: 0, completed: 0, inProgress: 0, pending: 0 }, omitted: 0, source: null, updatedAt: null };
    fetchMock.mockResolvedValue(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve(body) }));

    await api.getSessionTodos('a/b');

    expect(String(fetchMock.mock.calls[0]![0])).toContain('/api/sessions/a%2Fb/todos');
  });

  const countsOf = (total: number) => ({ total, completed: 0, inProgress: 0, pending: total });
  const answerWith = (body: unknown) => fetchMock.mockResolvedValue(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve(body) }));

  it('keeps an item whose status a newer daemon added, so the row can read as Other', async () => {
    const fromNewerDaemon = { sessionId: 's1', items: [{ id: '1', content: 'Wait', status: 'blocked' }], counts: countsOf(1), omitted: 0, source: 'task_tools', updatedAt: 't' };
    answerWith(fromNewerDaemon);

    await expect(api.getSessionTodos('s1')).resolves.toEqual(fromNewerDaemon);
  });

  it('keeps the valid and unknown-status items of a list and drops only the malformed one', async () => {
    const valid = { id: '1', content: 'Write', status: 'completed' };
    const unknownStatus = { id: '2', content: 'Wait', status: 'blocked' };
    const malformed = { id: '3', status: 'pending' };
    answerWith({ sessionId: 's1', items: [valid, malformed, unknownStatus], counts: countsOf(3), omitted: 0, source: 'task_tools', updatedAt: 't' });

    const todos = await api.getSessionTodos('s1');

    expect(todos.items).toEqual([valid, unknownStatus]);
  });

  it('rejects an answer that is not a todo list', async () => {
    answerWith({ sessionId: 's1', items: 'none' });

    await expect(api.getSessionTodos('s1')).rejects.toBeInstanceOf(ApiError);
  });

  it('rejects with the error envelope of the daemon when the session is unknown', async () => {
    const envelope = { error: 'not_found', kind: 'not_found', retry: 'never', message: 'No such session.' };
    fetchMock.mockResolvedValue(fakeResponse({ ok: false, status: 404, json: () => Promise.resolve(envelope) }));

    const failure = await api.getSessionTodos('nope').catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ApiError);
    expect(failure).toMatchObject({ status: 404, code: 'not_found', envelope });
  });
});
