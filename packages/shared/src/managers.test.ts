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
