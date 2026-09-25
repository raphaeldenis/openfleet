import { describe, expect, it } from 'vitest';
import { MANAGER_ROLE, ManagerSpecSchema } from './managers.js';

describe('ManagerSpecSchema', () => {
  it('requires a positive pulseSeconds, a positive childrenCap and a non-empty mission', () => {
    expect(() => ManagerSpecSchema.parse({ pulseSeconds: 0, childrenCap: 1, mission: 'x' })).toThrow();
    expect(() => ManagerSpecSchema.parse({ pulseSeconds: 60, childrenCap: 0, mission: 'x' })).toThrow();
    expect(() => ManagerSpecSchema.parse({ pulseSeconds: 60, childrenCap: 1, mission: '' })).toThrow();
  });

  it('accepts a valid spec', () => {
    const spec = ManagerSpecSchema.parse({ pulseSeconds: 1800, childrenCap: 2, mission: 'Ship it' });
    expect(spec).toEqual({ pulseSeconds: 1800, childrenCap: 2, mission: 'Ship it' });
  });
});

describe('MANAGER_ROLE', () => {
  it('is the literal string sessions use as role to mark a manager', () => {
    expect(MANAGER_ROLE).toBe('manager');
  });
});

describe('ManagerSpecSchema hostile inputs', () => {
  it('rejects a fractional pulseSeconds', () => {
    expect(() => ManagerSpecSchema.parse({ pulseSeconds: 1.5, childrenCap: 1, mission: 'x' })).toThrow();
  });

  it('rejects a fractional childrenCap', () => {
    expect(() => ManagerSpecSchema.parse({ pulseSeconds: 60, childrenCap: 1.5, mission: 'x' })).toThrow();
  });

  it('rejects a spec missing pulseSeconds', () => {
    expect(() => ManagerSpecSchema.parse({ childrenCap: 1, mission: 'x' })).toThrow();
  });

  it('accepts a whitespace-only mission — min(1) counts characters, not trimmed length', () => {
    const spec = ManagerSpecSchema.parse({ pulseSeconds: 60, childrenCap: 1, mission: '   ' });
    expect(spec.mission).toBe('   ');
  });
});

describe('ManagerSpecSchema trust-boundary bounds', () => {
  const validSpec = { pulseSeconds: 60, childrenCap: 1, mission: 'x' };

  it('rejects a pulseSeconds one second past the one-day cap', () => {
    expect(() => ManagerSpecSchema.parse({ ...validSpec, pulseSeconds: 86401 })).toThrow();
  });

  it('accepts a pulseSeconds of exactly one day', () => {
    expect(ManagerSpecSchema.parse({ ...validSpec, pulseSeconds: 86400 }).pulseSeconds).toBe(86400);
  });

  it('rejects a pulseSeconds so large that setTimeout would clamp it to a tight pulse loop', () => {
    expect(() => ManagerSpecSchema.parse({ ...validSpec, pulseSeconds: 2147484 })).toThrow();
  });

  it('rejects a pulseSeconds so large it turns nextPulseAt into an Invalid Date', () => {
    expect(() => ManagerSpecSchema.parse({ ...validSpec, pulseSeconds: 9000000000000 })).toThrow();
  });

  it('rejects a childrenCap past the 64 cap', () => {
    expect(() => ManagerSpecSchema.parse({ ...validSpec, childrenCap: 65 })).toThrow();
  });

  it('rejects a mission over 64 KiB', () => {
    const oversizedMission = 'x'.repeat(65 * 1024);
    expect(() => ManagerSpecSchema.parse({ ...validSpec, mission: oversizedMission })).toThrow();
  });
});
