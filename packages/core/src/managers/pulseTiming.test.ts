import { describe, expect, it } from 'vitest';
import { nextPulseAt } from './pulseTiming.js';

describe('nextPulseAt', () => {
  it('is createdAt + pulseSeconds when the manager has never pulsed', () => {
    const at = nextPulseAt({ pulseSeconds: 60, lastPulseAt: undefined, createdAt: '2026-01-01T00:00:00.000Z' });
    expect(at).toBe('2026-01-01T00:01:00.000Z');
  });

  it('is a full day later across a year end at the largest heartbeat of 86400 seconds', () => {
    const at = nextPulseAt({ pulseSeconds: 86_400, lastPulseAt: '2026-12-31T23:59:59.999Z', createdAt: '2026-01-01T00:00:00.000Z' });
    expect(at).toBe('2027-01-01T23:59:59.999Z');
  });

  it('is one second after createdAt at the smallest heartbeat, keeping the milliseconds', () => {
    const at = nextPulseAt({ pulseSeconds: 1, createdAt: '2026-01-01T00:00:00.250Z' });
    expect(at).toBe('2026-01-01T00:00:01.250Z');
  });

  it('is lastPulseAt + pulseSeconds once it has pulsed', () => {
    const at = nextPulseAt({ pulseSeconds: 60, lastPulseAt: '2026-01-01T00:05:00.000Z', createdAt: '2026-01-01T00:00:00.000Z' });
    expect(at).toBe('2026-01-01T00:06:00.000Z');
  });
});
