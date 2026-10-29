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
      expertise: '', pulseActions: [], profileRev: 1,
      sessionId: 'session-1',
      pulseSeconds: 60,
      pulseEnabled: true,
      childAutoRestart: false,
      childrenCap: 4,
      missionText: 'Ship it',
      legacyMission: false,
      lastPulseAt: '2026-01-01T00:05:00.000Z',
      nextPulseAt: '2026-01-01T00:06:00.000Z',
      childrenCount: 3,
      childrenHeadroom: 1,
      pinMissionNote: false,
      deniedCommandCount: 0,
      deniedCommandTotal: 0,
      noteNotReadWarningCount: 0,
    });
  });

  it('carries the linked mission note, its pin and the log table into the view', () => {
    const record = {
      sessionId: 'session-3', pulseSeconds: 30, childrenCap: 1, missionText: 'x', createdAt: '2026-01-01T00:00:00.000Z',
      missionNoteId: 'note-9', pinMissionNote: true, logStoreId: 'store-7',
    };

    const view = toManagerView(record, 0);

    expect(view).toMatchObject({ missionNoteId: 'note-9', pinMissionNote: true, logStoreId: 'store-7' });
  });

  it('reports a record without a pause flag as enabled and a paused record as disabled', () => {
    const base = { sessionId: 'session-4', pulseSeconds: 30, childrenCap: 1, missionText: 'x', createdAt: '2026-01-01T00:00:00.000Z' };

    const newManagerView = toManagerView(base, 0);
    const pausedManagerView = toManagerView({ ...base, pulseEnabled: false }, 0);

    expect(newManagerView.pulseEnabled).toBe(true);
    expect(pausedManagerView.pulseEnabled).toBe(false);
  });

  it('reports a childrenHeadroom of 0, never a negative one, when more children live than the cap allows', () => {
    const record = { sessionId: 'session-5', pulseSeconds: 30, childrenCap: 2, missionText: 'x', createdAt: '2026-01-01T00:00:00.000Z' };

    const view = toManagerView(record, 3);

    expect(view.childrenHeadroom).toBe(0);
  });

  it('reports childrenCount 0 for a manager with no live children, without inventing a floor or omitting the field', () => {
    const record = { sessionId: 'session-2', pulseSeconds: 30, childrenCap: 1, missionText: 'x', createdAt: '2026-01-01T00:00:00.000Z' };

    const view = toManagerView(record, 0);

    expect(view.childrenCount).toBe(0);
    expect(view.lastPulseAt).toBeUndefined();
  });
});
