import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FleetApiService } from './fleet-api.service';

const tool = (overrides: Record<string, unknown> = {}) => ({ name: 'list_notes', domain: 'notes', category: 'read_only', ...overrides });

describe('FleetApiService.listTools', () => {
  let api: FleetApiService;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    api = new FleetApiService();
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => vi.unstubAllGlobals());

  const answerWith = (body: unknown) => fetchMock.mockResolvedValue({ ok: true, status: 200, json: () => Promise.resolve(body) } as unknown as Response);

  it('reads the tools route and returns the tools the daemon lists', async () => {
    answerWith({ items: [tool(), tool({ name: 'delete_note', category: 'destructive' })] });

    const tools = await api.listTools();

    expect(new URL(String(fetchMock.mock.calls[0]![0])).pathname).toBe('/api/tools');
    expect(tools).toEqual([tool(), tool({ name: 'delete_note', category: 'destructive' })]);
  });

  it.each([
    ['no items field', {}],
    ['a text answer', 'nope'],
    ['a null answer', null],
    ['an unknown category', { items: [tool({ category: 'dangerous' })] }],
    ['a missing name', { items: [tool({ name: undefined })] }],
  ])('rejects %s as unreadable rather than showing an empty catalog', async (_name, body) => {
    answerWith(body);

    await expect(api.listTools()).rejects.toThrow(/unreadable/);
  });
});
