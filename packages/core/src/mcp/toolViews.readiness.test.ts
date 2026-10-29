import type { Session } from '@openfleet/shared';
import { describe, expect, it } from 'vitest';
import { sessionView } from './toolViews.js';

const aSession = (overrides: Partial<Session> = {}): Session => ({
  id: 's1', name: 'worker', emoji: '🤖', directory: '/tmp/wt', harness: 'claude-cli', state: 'starting', stateSince: 't0', createdAt: 't0', ...overrides,
});

describe('sessionView readiness', () => {
  it('shows the readiness and the failure reason of a launch that produced no output', () => {
    const view = sessionView(aSession({ readiness: 'failed', readinessReason: 'no_output_at_launch' }));

    expect(view).toMatchObject({ readiness: 'failed', readinessReason: 'no_output_at_launch' });
  });

  it('shows a pending readiness without a reason', () => {
    const view = sessionView(aSession({ readiness: 'pending' }));

    expect(view).toMatchObject({ readiness: 'pending' });
    expect(view).not.toHaveProperty('readinessReason');
  });

  it('leaves both out for a session launched before readiness was tracked', () => {
    const view = sessionView(aSession());

    expect(view).not.toHaveProperty('readiness');
    expect(view).not.toHaveProperty('readinessReason');
  });
});
