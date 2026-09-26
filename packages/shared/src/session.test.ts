import { describe, expect, it } from 'vitest';
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

  it('rejects the undocumented "default" alias', () => {
    expect(() => SessionSpecSchema.parse({ directory: '/tmp/x', name: 'G', permissionMode: 'default' })).toThrow();
  });

  it.each(PERMISSION_MODES)('accepts the documented permission mode "%s" and preserves it', (mode) => {
    const spec = SessionSpecSchema.parse({ directory: '/tmp/x', name: 'Gimli', permissionMode: mode });
    expect(spec.permissionMode).toBe(mode);
  });

  it('exposes the six permission modes the CLI documents, manual first as the ask-before-acting default', () => {
    expect(PERMISSION_MODES).toEqual(['manual', 'acceptEdits', 'plan', 'auto', 'bypassPermissions', 'dontAsk']);
  });

  it('rejects a manager block missing childrenCap', () => {
    expect(() =>
      SessionSpecSchema.parse({ directory: '/tmp/x', name: 'Lead', manager: { pulseSeconds: 1800, mission: 'Ship it' } }),
    ).toThrow();
  });
});
