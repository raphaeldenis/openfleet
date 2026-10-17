import { describe, expect, it } from 'vitest';
import { isLegacyMission, isMissionWritable, MANAGER_ROLE, ManagerRecordBoundsSchema, ManagerSpecSchema, MAX_MISSION_DELTA_BYTES } from './managers.js';

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

  it('accepts a spec without pulseSeconds and leaves it undefined for the daemon to default', () => {
    expect(ManagerSpecSchema.parse({ childrenCap: 1, mission: 'x' }).pulseSeconds).toBeUndefined();
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

describe('ManagerRecordBoundsSchema', () => {
  const validRecord = { pulseSeconds: 60, childrenCap: 1, mission: 'x' };

  it('keeps a legacy mission of 30 KB within the bounds of a stored row', () => {
    expect(ManagerRecordBoundsSchema.safeParse({ ...validRecord, mission: 'x'.repeat(30 * 1024) }).success).toBe(true);
  });

  it('rejects a stored mission over 64 KiB', () => {
    expect(ManagerRecordBoundsSchema.safeParse({ ...validRecord, mission: 'x'.repeat(65 * 1024) }).success).toBe(false);
  });
});

describe('isMissionWritable', () => {
  const missionOfBytes = (bytes: number) => 'x'.repeat(bytes);

  it('accepts a mission of exactly 8192 bytes for a new manager', () => {
    expect(isMissionWritable({ mission: missionOfBytes(MAX_MISSION_DELTA_BYTES) })).toBe(true);
  });

  it('refuses a mission of 8193 bytes for a new manager', () => {
    expect(isMissionWritable({ mission: missionOfBytes(MAX_MISSION_DELTA_BYTES + 1) })).toBe(false);
  });

  it('counts bytes, not characters: 4097 two-byte letters are 8194 bytes', () => {
    expect(isMissionWritable({ mission: 'é'.repeat(4097) })).toBe(false);
    expect(isMissionWritable({ mission: 'é'.repeat(4096) })).toBe(true);
  });

  it('counts an emoji as four bytes', () => {
    expect(isMissionWritable({ mission: '😀'.repeat(2048) })).toBe(true);
    expect(isMissionWritable({ mission: '😀'.repeat(2049) })).toBe(false);
  });

  it('lets a stored mission above the limit shrink or stay the same size, never grow', () => {
    const storedMission = missionOfBytes(30_000);
    expect(isMissionWritable({ mission: missionOfBytes(20_000), storedMission })).toBe(true);
    expect(isMissionWritable({ mission: missionOfBytes(30_000), storedMission })).toBe(true);
    expect(isMissionWritable({ mission: missionOfBytes(30_001), storedMission })).toBe(false);
  });
});

describe('isLegacyMission', () => {
  it('flags a mission above 8192 bytes and only that', () => {
    expect(isLegacyMission('x'.repeat(MAX_MISSION_DELTA_BYTES))).toBe(false);
    expect(isLegacyMission('x'.repeat(MAX_MISSION_DELTA_BYTES + 1))).toBe(true);
  });
});
