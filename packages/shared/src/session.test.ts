import { describe, expect, it } from 'vitest';
import { SessionSpecSchema } from './session.js';

describe('SessionSpecSchema', () => {
  it('defaults harness to claude-cli and emoji to a robot', () => {
    const spec = SessionSpecSchema.parse({ directory: '/tmp/x', name: 'Gimli' });
    expect(spec.harness).toBe('claude-cli');
    expect(spec.emoji).toBe('🤖');
  });

  it('rejects an empty name', () => {
    expect(() => SessionSpecSchema.parse({ directory: '/tmp/x', name: '' })).toThrow();
  });
});
