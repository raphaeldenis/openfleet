import { describe, expect, it } from 'vitest';
import { parseActivityPage } from './activity-page-parser';

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

describe('parseActivityPage', () => {
  it('returns the rows and the cursor of the next page', () => {
    const page = parseActivityPage({ items: [row(), row({ id: 6 })], nextCursor: '6' });

    expect(page?.items.map((item) => item.id)).toEqual([7, 6]);
    expect(page?.nextCursor).toBe('6');
  });

  it('returns a last page without a cursor', () => {
    expect(parseActivityPage({ items: [row()] })?.nextCursor).toBeUndefined();
  });

  it('keeps the redaction marks exactly as the daemon wrote them', () => {
    const page = parseActivityPage({ items: [row({ entityLabel: '[text len=12]', argsExcerpt: 'title=[text len=9] token=[secret]' })] });

    expect(page?.items[0]).toMatchObject({ entityLabel: '[text len=12]', argsExcerpt: 'title=[text len=9] token=[secret]' });
  });

  it('returns an empty page', () => {
    expect(parseActivityPage({ items: [] })).toEqual({ items: [] });
  });

  it.each([
    ['a text answer', 'nope'],
    ['a null answer', null],
    ['no items', {}],
    ['items that are not a list', { items: 'x' }],
    ['an unknown outcome', { items: [row({ outcome: 'gated' })] }],
    ['an unknown actor kind', { items: [row({ actorKind: 'robot' })] }],
    ['a missing action', { items: [row({ action: undefined })] }],
    ['a field the schema does not know', { items: [row({ command: 'rm -rf /' })] }],
  ])('rejects %s as unreadable rather than showing a partial list', (_name, body) => {
    expect(parseActivityPage(body)).toBeNull();
  });
});
