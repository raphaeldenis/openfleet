import { describe, expect, it } from 'vitest';
import { effortRefusalOf } from './effort.js';

const harnessWithoutEffortSupport = 'opencode';

describe('effortRefusalOf', () => {
  it.each(['low', 'medium', 'high', 'xhigh', 'max'])('accepts %s for the claude-cli harness', (effort) => {
    expect(effortRefusalOf('claude-cli', effort)).toBeUndefined();
  });

  it.each(['minimal', 'off', 'none', 'HIGH', '', '--x', 'high medium'])('refuses %j for the claude-cli harness and lists the valid values', (effort) => {
    const refusal = effortRefusalOf('claude-cli', effort);

    expect(refusal).toContain('low, medium, high, xhigh, max');
  });

  it('refuses any effort for a harness that has no effort levels', () => {
    const refusal = effortRefusalOf(harnessWithoutEffortSupport, 'high');

    expect(refusal).toContain('does not support effort');
    expect(refusal).toContain('opencode');
  });
});
