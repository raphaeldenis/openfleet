import { describe, expect, it } from 'vitest';
import { nextPulseAt } from './pulseTiming.js';

describe('nextPulseAt', () => {
  it('is createdAt + pulseSeconds when the manager has never pulsed', () => {
    const at = nextPulseAt({ pulseSeconds: 60, lastPulseAt: undefined, createdAt: '2026-01-01T00:00:00.000Z' });
    expect(at).toBe('2026-01-01T00:01:00.000Z');
  });

  it('is lastPulseAt + pulseSeconds once it has pulsed', () => {
    const at = nextPulseAt({ pulseSeconds: 60, lastPulseAt: '2026-01-01T00:05:00.000Z', createdAt: '2026-01-01T00:00:00.000Z' });
    expect(at).toBe('2026-01-01T00:06:00.000Z');
  });
});
