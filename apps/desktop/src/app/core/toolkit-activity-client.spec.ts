import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ToolkitActivityClient } from './toolkit-activity-client';

const row = (overrides: Record<string, unknown> = {}) => ({
  id: 7,
  at: '2026-11-02T10:00:00.000Z',
  actorKind: 'agent',
  actorLabel: 'Gimli',
  source: 'mcp',
  action: 'create_note',
  outcome: 'ok',
  durationMs: 12,
  argsExcerpt: '{"title":"[text len=9]"}',
  resultExcerpt: '[result len=40]',
  ...overrides,
});

describe('ToolkitActivityClient', () => {
  let client: ToolkitActivityClient;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    client = TestBed.inject(ToolkitActivityClient);
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => vi.unstubAllGlobals());

  const answerWith = (body: unknown) => fetchMock.mockResolvedValue({ ok: true, status: 200, json: () => Promise.resolve(body) } as unknown as Response);
  const requestedUrl = () => new URL(String(fetchMock.mock.calls[0]![0]));

  it('reads the calls agents made, which are the MCP calls', async () => {
    answerWith({ items: [] });

    await client.readPage({});

    expect(requestedUrl().pathname).toBe('/api/activity');
    expect(requestedUrl().searchParams.get('actor')).toBe('agent');
  });

  it('asks for one outcome, one tool and the next page when given', async () => {
    answerWith({ items: [] });

    await client.readPage({ outcome: 'error', tool: 'create_note', cursor: '41' });

    expect(requestedUrl().searchParams.get('outcome')).toBe('error');
    expect(requestedUrl().searchParams.get('action')).toBe('create_note');
    expect(requestedUrl().searchParams.get('cursor')).toBe('41');
  });

  it('asks for no outcome, tool or cursor when none is given', async () => {
    answerWith({ items: [] });

    await client.readPage({});

    expect([...requestedUrl().searchParams.keys()]).toEqual(['actor']);
  });

  it('returns the rows and the cursor of the next page, marks included as sent', async () => {
    answerWith({ items: [row()], nextCursor: '7' });

    const page = await client.readPage({});

    expect(page).toEqual({ items: [row()], nextCursor: '7' });
  });

  it.each([
    ['no items field', {}],
    ['a text answer', 'nope'],
    ['an unknown outcome', { items: [row({ outcome: 'gated' })] }],
    ['a negative duration', { items: [row({ durationMs: -1 })] }],
    ['a row without an action', { items: [row({ action: undefined })] }],
  ])('rejects %s as unreadable rather than showing an empty log', async (_name, body) => {
    answerWith(body);

    await expect(client.readPage({})).rejects.toThrow(/unreadable/);
  });
});
