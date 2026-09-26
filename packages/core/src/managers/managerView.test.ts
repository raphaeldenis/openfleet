import { describe, expect, it } from 'vitest';
import { toManagerView } from './managerView.js';

describe('toManagerView', () => {
  it('carries the given childrenCount through untouched, alongside the record fields and a computed nextPulseAt', () => {
    const record = {
      sessionId: 'session-1',
      pulseSeconds: 60,
      childrenCap: 4,
      missionText: 'Ship it',
      lastPulseAt: '2026-01-01T00:05:00.000Z',
      createdAt: '2026-01-01T00:00:00.000Z',
    };

    const view = toManagerView(record, 3);

    expect(view).toEqual({
      sessionId: 'session-1',
      pulseSeconds: 60,
      childrenCap: 4,
      missionText: 'Ship it',
      lastPulseAt: '2026-01-01T00:05:00.000Z',
      nextPulseAt: '2026-01-01T00:06:00.000Z',
      childrenCount: 3,
    });
  });

  it('reports childrenCount 0 for a manager with no live children, without inventing a floor or omitting the field', () => {
    const record = { sessionId: 'session-2', pulseSeconds: 30, childrenCap: 1, missionText: 'x', createdAt: '2026-01-01T00:00:00.000Z' };

    const view = toManagerView(record, 0);

    expect(view.childrenCount).toBe(0);
    expect(view.lastPulseAt).toBeUndefined();
  });
});
