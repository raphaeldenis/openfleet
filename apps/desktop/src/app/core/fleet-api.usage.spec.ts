import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FleetApiService } from './fleet-api.service';

describe('FleetApiService.getSessionUsage', () => {
  let api: FleetApiService;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    api = new FleetApiService();
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => vi.unstubAllGlobals());

  const answerWith = (body: unknown) => fetchMock.mockResolvedValue({ ok: true, status: 200, json: () => Promise.resolve(body) } as unknown as Response);

  it('reads the usage route of the session, not the hook token route', async () => {
    answerWith({ inputTokens: 12_300, outputTokens: 4_100 });

    await expect(api.getSessionUsage('a/b')).resolves.toEqual({ inputTokens: 12_300, outputTokens: 4_100 });

    expect(String(fetchMock.mock.calls[0]![0])).toMatch(/\/api\/sessions\/a%2Fb\/usage$/);
  });

  it('reads a null answer as no data', async () => {
    answerWith(null);

    await expect(api.getSessionUsage('s1')).resolves.toBeNull();
  });

  it.each([
    ['a negative count', { inputTokens: -1, outputTokens: 2 }],
    ['a fractional count', { inputTokens: 1.5, outputTokens: 2 }],
    ['a missing count', { inputTokens: 1 }],
    ['a text count', { inputTokens: '1', outputTokens: 2 }],
  ])('reads %s as no data, never as zero', async (_name, body) => {
    answerWith(body);

    await expect(api.getSessionUsage('s1')).resolves.toBeNull();
  });
});

describe('FleetApiService.getProjectUsageToday', () => {
  let api: FleetApiService;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    api = new FleetApiService();
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => vi.unstubAllGlobals());

  const answerWith = (body: unknown) => fetchMock.mockResolvedValue({ ok: true, status: 200, json: () => Promise.resolve(body) } as unknown as Response);

  it('reads the usage-today route of the project and keeps the two token counts', async () => {
    answerWith({ dayUtc: '2026-10-30', inputTokens: 107, outputTokens: 23 });

    await expect(api.getProjectUsageToday('p/1')).resolves.toEqual({ inputTokens: 107, outputTokens: 23 });

    expect(String(fetchMock.mock.calls[0]![0])).toMatch(/\/api\/projects\/p%2F1\/usage\/today$/);
  });

  it('reads a null answer as no data', async () => {
    answerWith(null);

    await expect(api.getProjectUsageToday('p1')).resolves.toBeNull();
  });

  it('reads an unreadable count as no data, never as zero', async () => {
    answerWith({ dayUtc: '2026-10-30', inputTokens: -4, outputTokens: 2 });

    await expect(api.getProjectUsageToday('p1')).resolves.toBeNull();
  });
});
