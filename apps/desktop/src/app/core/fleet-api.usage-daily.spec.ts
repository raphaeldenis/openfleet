import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FleetApiService } from './fleet-api.service';

const bucket = (overrides: Record<string, unknown> = {}) => ({
  dayUtc: '2026-10-30',
  model: 'claude-opus-5-5',
  sessionId: 's1',
  billingCode: 'general',
  biller: 'api',
  costStatus: 'reported',
  messageCount: 3,
  inputTokens: 1_200,
  outputTokens: 340,
  cacheReadInputTokens: 9_000,
  cacheCreationInputTokens: 500,
  costUsd: 0.42,
  ...overrides,
});

describe('FleetApiService.getDailyUsage', () => {
  let api: FleetApiService;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    api = new FleetApiService();
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => vi.unstubAllGlobals());

  const answerWith = (body: unknown) => fetchMock.mockResolvedValue({ ok: true, status: 200, json: () => Promise.resolve(body) } as unknown as Response);

  it('reads the daily usage route with the requested days', async () => {
    answerWith({ items: [] });

    await api.getDailyUsage({ fromDayUtc: '2026-10-25', toDayUtc: '2026-10-31' });

    const url = new URL(String(fetchMock.mock.calls[0]![0]));
    expect(url.pathname).toBe('/api/usage/daily');
    expect(url.searchParams.get('from')).toBe('2026-10-25');
    expect(url.searchParams.get('to')).toBe('2026-10-31');
  });

  it('asks for no filter when none is given', async () => {
    answerWith({ items: [] });

    await api.getDailyUsage({});

    expect(new URL(String(fetchMock.mock.calls[0]![0])).search).toBe('');
  });

  it('returns the buckets the daemon sends', async () => {
    answerWith({ items: [bucket(), bucket({ model: 'claude-haiku-5-5', costStatus: 'unpriced', costUsd: null })] });

    const rows = await api.getDailyUsage({});

    expect(rows).toEqual([bucket(), bucket({ model: 'claude-haiku-5-5', costStatus: 'unpriced', costUsd: null })]);
  });

  it('returns an empty list when the ledger holds nothing', async () => {
    answerWith({ items: [] });

    await expect(api.getDailyUsage({})).resolves.toEqual([]);
  });

  it.each([
    ['no items field', {}],
    ['a text answer', 'nope'],
    ['a null answer', null],
    ['items that are not a list', { items: 'x' }],
    ['a negative token count', { items: [bucket({ inputTokens: -1 })] }],
    ['a fractional token count', { items: [bucket({ outputTokens: 1.5 })] }],
    ['a text day', { items: [bucket({ dayUtc: 'yesterday' })] }],
    ['a text cost', { items: [bucket({ costUsd: '0.4' })] }],
    ['a missing model', { items: [bucket({ model: undefined })] }],
  ])('rejects %s as unreadable rather than showing zeros', async (_name, body) => {
    answerWith(body);

    await expect(api.getDailyUsage({})).rejects.toThrow(/unreadable/);
  });
});
