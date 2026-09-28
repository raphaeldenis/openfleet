import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, FleetApiService } from './fleet-api.service';

function fakeResponse(init: { ok: boolean; status: number; json: () => Promise<unknown> }) {
  return init as unknown as Response;
}

describe('FleetApiService', () => {
  let api: FleetApiService;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    api = new FleetApiService();
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('extracts the error code from a JSON error body', async () => {
    fetchMock.mockResolvedValue(fakeResponse({ ok: false, status: 409, json: () => Promise.resolve({ error: 'not_closed' }) }));

    await expect(api.reopenSession('s1')).rejects.toMatchObject({ status: 409, code: 'not_closed' });
  });

  it('leaves the error code undefined for a non-JSON error body', async () => {
    fetchMock.mockResolvedValue(fakeResponse({ ok: false, status: 500, json: () => Promise.reject(new SyntaxError('Unexpected end of input')) }));

    await expect(api.reopenSession('s1')).rejects.toMatchObject({ status: 500, code: undefined });
  });

  it('leaves the error code undefined when the JSON body has no "error" field', async () => {
    fetchMock.mockResolvedValue(fakeResponse({ ok: false, status: 500, json: () => Promise.resolve({ message: 'internal error' }) }));

    await expect(api.reopenSession('s1')).rejects.toMatchObject({ status: 500, code: undefined });
  });

  it('leaves the error code undefined when the "error" field is not a string', async () => {
    fetchMock.mockResolvedValue(fakeResponse({ ok: false, status: 500, json: () => Promise.resolve({ error: 42 }) }));

    await expect(api.reopenSession('s1')).rejects.toMatchObject({ status: 500, code: undefined });
  });

  it('throws a plain ApiError instance so callers can narrow with instanceof', async () => {
    fetchMock.mockResolvedValue(fakeResponse({ ok: false, status: 500, json: () => Promise.reject(new Error('boom')) }));

    await expect(api.reopenSession('s1')).rejects.toBeInstanceOf(ApiError);
  });

  it('resolves with the parsed JSON body on a successful response', async () => {
    const session = { id: 's1', state: 'starting' };
    fetchMock.mockResolvedValue(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve(session) }));

    await expect(api.reopenSession('s1')).resolves.toEqual(session);
  });

  it('reads the resolved model table from GET /api/models', async () => {
    const modelTable = { haiku: 'h', sonnet: 's', opus: 'o', fable: 'f' };
    fetchMock.mockResolvedValue(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve(modelTable) }));

    await expect(api.models()).resolves.toEqual(modelTable);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toMatch(/\/api\/models$/);
    expect(init.method).toBeUndefined();
  });

  it('reads the selectable model ids from GET /api/models/available', async () => {
    fetchMock.mockResolvedValue(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve({ models: ['a', 'b'] }) }));

    await expect(api.availableModels()).resolves.toEqual({ models: ['a', 'b'] });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toMatch(/\/api\/models\/available$/);
    expect(init.method).toBeUndefined();
  });

  it('saves a model patch with PUT /api/models and returns the daemon answer', async () => {
    const answer = { models: { haiku: 'h', sonnet: 's', opus: 'new', fable: 'f' } };
    fetchMock.mockResolvedValue(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve(answer) }));

    await expect(api.saveModels({ opus: 'new' })).resolves.toEqual(answer);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toMatch(/\/api\/models$/);
    expect(init.method).toBe('PUT');
    expect(JSON.parse(init.body as string)).toEqual({ opus: 'new' });
  });

  it('sends the admin bearer token and JSON content type on every request', async () => {
    fetchMock.mockResolvedValue(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve({}) }));

    await api.closeSession('s1');

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.headers).toMatchObject({ 'content-type': 'application/json' });
    expect((init.headers as Record<string, string>)['authorization']).toMatch(/^Bearer /);
  });

  describe('where the admin token goes', () => {
    beforeEach(() => {
      localStorage.clear();
      localStorage.setItem('openfleet.adminToken', 'secret-token');
      fetchMock.mockResolvedValue(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve({}) }));
    });
    afterEach(() => {
      localStorage.clear();
    });

    it.each([
      ['a remote host', 'http://evil:1'],
      ['a host that starts with localhost', 'http://localhost.evil.com'],
      ['userinfo hiding the real host', 'http://x@evil.com'],
      ['a wildcard-DNS host embedding the loopback address', 'http://127.0.0.1.nip.io'],
      ['the IPv4-mapped IPv6 loopback', 'http://[::ffff:7f00:1]:7331'],
    ])('sends the request to the default daemon, not to %s (%s)', async (_label, storedApiUrl) => {
      localStorage.setItem('openfleet.apiUrl', storedApiUrl);

      await api.closeSession('s1');

      const [requestedUrl] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(requestedUrl).toBe('http://127.0.0.1:7331/api/sessions/s1/close');
    });

    it('sends the request to the stored loopback daemon with the bearer token', async () => {
      localStorage.setItem('openfleet.apiUrl', 'http://localhost:9999');

      await api.closeSession('s1');

      const [requestedUrl, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(requestedUrl).toBe('http://localhost:9999/api/sessions/s1/close');
      expect((init.headers as Record<string, string>)['authorization']).toBe('Bearer secret-token');
    });

    it('sends a whitespace-only stored token as no token', async () => {
      localStorage.setItem('openfleet.adminToken', '   ');

      await api.closeSession('s1');

      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect((init.headers as Record<string, string>)['authorization']).toBe('Bearer ');
    });
  });

  describe('createManagerSession', () => {
    function postedBody(): unknown {
      const [, init] = fetchMock.mock.calls[0]!;
      return JSON.parse(init.body as string);
    }

    it('posts the harness and permission mode next to the nested manager spec', async () => {
      fetchMock.mockResolvedValue(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve({ id: 'm-1' }) }));

      await api.createManagerSession({
        directory: '/tmp/wt', name: 'Lead', emoji: '🧭', model: 'opus', harness: 'claude-cli', permissionMode: 'plan',
        pulseSeconds: 900, childrenCap: 4, mission: 'Ship it',
      });

      expect(postedBody()).toEqual({
        directory: '/tmp/wt', name: 'Lead', emoji: '🧭', model: 'opus', harness: 'claude-cli', permissionMode: 'plan',
        manager: { pulseSeconds: 900, childrenCap: 4, mission: 'Ship it' },
      });
    });

    it('posts no permission mode when none is chosen', async () => {
      fetchMock.mockResolvedValue(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve({ id: 'm-1' }) }));

      await api.createManagerSession({
        directory: '/tmp/wt', name: 'Lead', pulseSeconds: 900, childrenCap: 4, mission: 'Ship it',
      });

      expect(postedBody()).not.toHaveProperty('permissionMode');
    });
  });
});
