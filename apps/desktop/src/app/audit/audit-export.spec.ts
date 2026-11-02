import type { ActivityRow } from '@openfleet/shared';
import { describe, expect, it } from 'vitest';
import { activityAsCsv, activityAsJson } from './audit-export';

const row = (overrides: Partial<ActivityRow> = {}): ActivityRow => ({
  id: 7,
  at: '2026-11-01T14:10:03.250Z',
  actorKind: 'agent',
  actorLabel: 'gimli',
  source: 'mcp',
  action: 'create_note',
  outcome: 'ok',
  ...overrides,
});

describe('activityAsJson', () => {
  it('writes the rows as a JSON list that reads back unchanged', () => {
    const rows = [row(), row({ id: 6, argsExcerpt: 'title=[text len=9]' })];

    expect(JSON.parse(activityAsJson(rows))).toEqual(rows);
  });
});

describe('activityAsCsv', () => {
  it('starts with a header naming every column of the log', () => {
    const [header] = activityAsCsv([]).split('\r\n');

    expect(header).toBe('id,at,actorKind,actorLabel,source,action,entityKind,entityId,entityLabel,outcome,durationMs,sessionId,managerId,detail,argsExcerpt,resultExcerpt');
  });

  it('writes one line per row with an empty cell for a field the row lacks', () => {
    const lines = activityAsCsv([row({ durationMs: 42, sessionId: 's1' })]).split('\r\n');

    expect(lines[1]).toBe('7,2026-11-01T14:10:03.250Z,agent,gimli,mcp,create_note,,,,ok,42,s1,,,,');
  });

  it('quotes a cell holding a comma, a quote or a line break', () => {
    const lines = activityAsCsv([row({ argsExcerpt: 'a,b "c"', detail: 'x\ny' })]).split('\r\n');

    expect(lines.join('\r\n')).toContain('"x\ny","a,b ""c"""');
  });

  it('keeps a cell that starts like a formula from running in a spreadsheet', () => {
    const csv = activityAsCsv([row({ actorLabel: '=HYPERLINK("http://x")', entityLabel: '@cmd' })]);

    expect(csv).not.toMatch(/(^|,)"?[=@+-]/m);
  });

  it('keeps the redaction marks as written', () => {
    expect(activityAsCsv([row({ entityLabel: '[text len=12]' })])).toContain('[text len=12]');
  });
});
