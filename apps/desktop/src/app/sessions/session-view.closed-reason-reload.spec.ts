import { render, screen, waitFor } from '@testing-library/angular/zoneless';
import { inputBinding, signal } from '@angular/core';
import { describe, expect, it, vi } from 'vitest';
import type { Session, SessionCloseReason } from '@openfleet/shared';
import { SessionViewComponent } from './session-view.component';
import { FleetApiService } from '../core/fleet-api.service';
import { connectFakeDaemon, withoutRealTerminal } from '../testing/session-view.testing';

const SIGTERM_EXIT_CODE = 143;

const sessionNamed = (id: string, patch: Partial<Session> = {}): Session => ({
  id, name: id, emoji: '⛏️', directory: '/repo', model: 'claude-sonnet-5',
  harness: 'claude-cli', state: 'idle', stateSince: 't', permissionMode: 'manual', createdAt: 't', ...patch,
});

async function renderSessionView(initialSessionId = 's1') {
  const shownSessionId = signal(initialSessionId);
  const { fixture } = await render(SessionViewComponent, {
    bindings: [inputBinding('sessionId', shownSessionId)],
    providers: [{ provide: FleetApiService, useValue: { reopenSession: vi.fn().mockResolvedValue({}) } }],
    ...withoutRealTerminal,
  });
  const daemon = await connectFakeDaemon(fixture);
  return { daemon, shownSessionId, fixture };
}

const strip = () => screen.queryByTestId('lifecycle-banner');

interface ReasonScenario { reason: SessionCloseReason; exitCode?: number; stripText?: string }

const REASON_SCENARIOS: ReasonScenario[] = [
  { reason: 'closed_by_user', exitCode: SIGTERM_EXIT_CODE },
  { reason: 'harness_exit', exitCode: SIGTERM_EXIT_CODE, stripText: 'ended unexpectedly' },
  { reason: 'launch_failed', exitCode: -2, stripText: 'Agent could not start' },
  { reason: 'daemon_shutdown', exitCode: SIGTERM_EXIT_CODE, stripText: 'Daemon stopped' },
  { reason: 'resume_timeout', exitCode: -1, stripText: 'Resume timed out' },
  { reason: 'conversation_not_found', exitCode: 1, stripText: 'Conversation not found' },
];

const bannerTextOf = () => strip()?.textContent?.trim() ?? '';

describe('a closed session reloaded from a snapshot', () => {
  it.each(REASON_SCENARIOS)('shows the strip of $reason, the one the live close shows', async ({ reason, exitCode, stripText }) => {
    // Arrange: a client whose first and only knowledge is the snapshot
    const { daemon } = await renderSessionView();

    // Act
    await daemon.send({ type: 'snapshot', sessions: [sessionNamed('s1', { state: 'closed', exitCode, closeReason: reason })], approvals: [], managers: [] });

    // Assert
    await waitFor(() => expect(screen.getByTestId('session-closed-footer')).toBeTruthy());
    if (stripText) expect(strip()).toHaveTextContent(stripText);
    else expect(strip()).toBeNull();
  });

  it.each(REASON_SCENARIOS)('shows for $reason the same strip after a reload as right after the live close', async ({ reason, exitCode }) => {
    // Arrange
    const live = await renderSessionView();
    await live.daemon.send({ type: 'snapshot', sessions: [sessionNamed('s1')], approvals: [], managers: [] });
    await live.daemon.send({ type: 'session.closed', sessionId: 's1', exitCode, reason });
    await waitFor(() => expect(screen.getByTestId('session-closed-footer')).toBeTruthy());
    const stripShownLive = bannerTextOf();

    // Act: the same daemon announces the session again, as a reconnect snapshot does
    await live.daemon.send({ type: 'snapshot', sessions: [sessionNamed('s1', { state: 'closed', exitCode, closeReason: reason })], approvals: [], managers: [] });

    // Assert
    expect(bannerTextOf()).toBe(stripShownLive);
  });

  it('keeps the exit-code fallback for a close the daemon stored no reason for', async () => {
    const { daemon } = await renderSessionView();

    await daemon.send({ type: 'snapshot', sessions: [sessionNamed('s1', { state: 'closed', exitCode: 1 })], approvals: [], managers: [] });

    await waitFor(() => expect(strip()).toHaveTextContent('Agent process exited'));
  });

  it('shows the fallback strip, and does not break, for a reason a future daemon stored', async () => {
    const { daemon } = await renderSessionView();
    const closeReasonOfAFutureDaemon = 'quota_exhausted' as SessionCloseReason;

    await daemon.send({ type: 'snapshot', sessions: [sessionNamed('s1', { state: 'closed', exitCode: 1, closeReason: closeReasonOfAFutureDaemon })], approvals: [], managers: [] });

    await waitFor(() => expect(strip()).toHaveTextContent('Agent process exited'));
  });
});

describe('switching between two closed sessions with different reasons', () => {
  it('shows the strip of the session on screen, never the one of the session left', async () => {
    const { daemon, shownSessionId } = await renderSessionView('s1');
    await daemon.send({
      type: 'snapshot', approvals: [], managers: [],
      sessions: [
        sessionNamed('s1', { state: 'closed', exitCode: -1, closeReason: 'resume_timeout' }),
        sessionNamed('s2', { state: 'closed', exitCode: 1, closeReason: 'conversation_not_found' }),
      ],
    });
    await waitFor(() => expect(strip()).toHaveTextContent('Resume timed out'));

    shownSessionId.set('s2');
    await waitFor(() => expect(strip()).toHaveTextContent('Conversation not found'));
    expect(strip()).not.toHaveTextContent('Resume timed out');

    shownSessionId.set('s1');
    await waitFor(() => expect(strip()).toHaveTextContent('Resume timed out'));
    expect(strip()).not.toHaveTextContent('Conversation not found');
  });
});
