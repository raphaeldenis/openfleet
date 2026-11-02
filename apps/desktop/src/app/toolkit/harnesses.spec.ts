import { describe, expect, it } from 'vitest';
import { KNOWN_HARNESSES } from './harnesses';

describe('the known harnesses', () => {
  it('lists the eight harnesses the fleet may drive, Claude Code first', () => {
    expect(KNOWN_HARNESSES.map((harness) => harness.label)).toEqual(['Claude Code', 'Codex', 'opencode', 'pi', 'omp', 'Copilot', 'Cursor', 'Kimi']);
  });

  it('knows the daemon launches Claude Code and says nothing about the others', () => {
    const availability = Object.fromEntries(KNOWN_HARNESSES.map((harness) => [harness.label, harness.availability]));

    expect(availability['Claude Code']).toBe('supported');
    expect(Object.entries(availability).filter(([label]) => label !== 'Claude Code').every(([, state]) => state === 'unknown')).toBe(true);
  });
});
