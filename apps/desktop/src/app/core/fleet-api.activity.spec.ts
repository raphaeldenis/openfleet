import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FleetApiService } from './fleet-api.service';

const row = (overrides: Record<string, unknown> = {}) => ({
  id: 7,
  at: '2026-11-01T14:10:00.000Z',
  actorKind: 'agent',
  actorLabel: 'gimli',
  source: 'mcp',
  action: 'create_note',
  outcome: 'ok',
  ...overrides,
});

describe('FleetApiService.listActivity', () => {
  let api: FleetApiService;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    api = new FleetApiService();
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => vi.unstubAllGlobals());

  const answerWith = (body: unknown) => fetchMock.mockResolvedValue({ ok: true, status: 200, json: () => Promise.resolve(body) } as unknown as Response);
  const requestedUrl = () => new URL(String(fetchMock.mock.calls[0]![0]));

  it('reads the activity route with no filter when none is given', async () => {
    answerWith({ items: [] });

    await api.listActivity({});

    expect(requestedUrl().pathname).toBe('/api/activity');
    expect(requestedUrl().search).toBe('');
  });

  it('sends every filter, the page size and the cursor under the names the route reads', async () => {
    answerWith({ items: [] });

    await api.listActivity({
      actor: 'human', outcome: 'denied', action: 'gate.approve', session: 's1', manager: 'm1', entity: 'note',
      since: '2026-11-01T00:00:00.000Z', until: '2026-11-02T00:00:00.000Z', limit: 50, cursor: '120',
    });

    const params = Object.fromEntries(requestedUrl().searchParams);
    expect(params).toEqual({
      actor: 'human', outcome: 'denied', action: 'gate.approve', session: 's1', manager: 'm1', entity: 'note',
      since: '2026-11-01T00:00:00.000Z', until: '2026-11-02T00:00:00.000Z', limit: '50', cursor: '120',
    });
  });

  it('returns the page the daemon sends', async () => {
    answerWith({ items: [row()], nextCursor: '7' });

    await expect(api.listActivity({})).resolves.toEqual({ items: [row()], nextCursor: '7' });
  });

  it('rejects an unreadable answer rather than showing an empty log', async () => {
    answerWith({ items: [row({ outcome: 'weird' })] });

    await expect(api.listActivity({})).rejects.toThrow(/unreadable/);
  });
});
