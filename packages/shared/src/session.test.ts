import { describe, expect, it } from 'vitest';
import { MANAGER_ROLE } from './managers.js';
import { PERMISSION_MODES, SessionSpecSchema } from './session.js';

describe('SessionSpecSchema', () => {
  it('defaults harness to claude-cli and emoji to a robot', () => {
    const spec = SessionSpecSchema.parse({ directory: '/tmp/x', name: 'Gimli' });
    expect(spec.harness).toBe('claude-cli');
    expect(spec.emoji).toBe('🤖');
  });

  it('rejects an empty name', () => {
    expect(() => SessionSpecSchema.parse({ directory: '/tmp/x', name: '' })).toThrow();
  });

  it('leaves permissionMode and manager unset by default', () => {
    const spec = SessionSpecSchema.parse({ directory: '/tmp/x', name: 'Gimli' });
    expect(spec.permissionMode).toBeUndefined();
    expect(spec.manager).toBeUndefined();
  });

  it('accepts a manager block with pulseSeconds, childrenCap and mission', () => {
    const spec = SessionSpecSchema.parse({ directory: '/tmp/x', name: 'Lead', manager: { pulseSeconds: 1800, childrenCap: 2, mission: 'Ship it' } });
    expect(spec.manager).toEqual({ pulseSeconds: 1800, childrenCap: 2, mission: 'Ship it' });
  });

  it('rejects an unknown permission mode', () => {
    expect(() => SessionSpecSchema.parse({ directory: '/tmp/x', name: 'G', permissionMode: 'yolo' })).toThrow();
  });

  it('exposes the five permission modes in the order the CLI accepts them', () => {
    expect(PERMISSION_MODES).toEqual(['default', 'acceptEdits', 'plan', 'auto', 'bypassPermissions']);
  });

  it.each(PERMISSION_MODES)('accepts %s as a permission mode', (permissionMode) => {
    const spec = SessionSpecSchema.parse({ directory: '/tmp/x', name: 'G', permissionMode });
    expect(spec.permissionMode).toBe(permissionMode);
  });

  it('rejects an empty-string permission mode', () => {
    expect(() => SessionSpecSchema.parse({ directory: '/tmp/x', name: 'G', permissionMode: '' })).toThrow();
  });

  it('rejects a manager block missing childrenCap', () => {
    expect(() =>
      SessionSpecSchema.parse({ directory: '/tmp/x', name: 'Lead', manager: { pulseSeconds: 1800, mission: 'Ship it' } }),
    ).toThrow();
  });

  it('accepts MANAGER_ROLE as the role of a session', () => {
    const spec = SessionSpecSchema.parse({ directory: '/tmp/x', name: 'Lead', role: MANAGER_ROLE });
    expect(spec.role).toBe(MANAGER_ROLE);
  });
});
