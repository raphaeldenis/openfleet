import { render, screen, waitFor } from '@testing-library/angular/zoneless';
import userEvent from '@testing-library/user-event';
import { inputBinding, signal } from '@angular/core';
import { describe, expect, it, vi } from 'vitest';
import type { Session } from '@openfleet/shared';
import { SessionViewComponent } from './session-view.component';
import { ApiError, FleetApiService } from '../core/fleet-api.service';
import { connectFakeDaemon, deferred, settleRequests, withoutRealTerminal } from '../testing/session-view.testing';

const CLOSED_AT = '2026-09-26T10:00:00.000Z';

function session(patch: Partial<Session> = {}): Session {
  return {
    id: 's1', name: 'Gimli', emoji: '⛏️', directory: '/repo', model: 'claude-sonnet-5',
    harness: 'claude-cli', state: 'idle', stateSince: 't', permissionMode: 'manual', createdAt: 't', ...patch,
  } as Session;
}

function fakeApi() {
  return {
    updateModel: vi.fn().mockResolvedValue({ status: 'deferred' }),
    updatePermissionMode: vi.fn().mockResolvedValue({ status: 'deferred' }),
    renameSession: vi.fn().mockResolvedValue({}),
    decide: vi.fn().mockResolvedValue({}),
    sendMessage: vi.fn().mockResolvedValue({ status: 'delivered', messageId: 'm1' }),
    closeSession: vi.fn().mockResolvedValue({}),
    sendInput: vi.fn().mockResolvedValue({}),
    reopenSession: vi.fn().mockResolvedValue({}),
  };
}

/** Renders the view against the REAL FleetEventsService reducer, fed the same events the daemon emits. */
async function renderAgainstDaemonEvents(api: ReturnType<typeof fakeApi>, initialSessions: Session[], sessionId = signal('s1')) {
  const { fixture } = await render(SessionViewComponent, {
    bindings: [inputBinding('sessionId', sessionId)],
    providers: [{ provide: FleetApiService, useValue: api }],
    ...withoutRealTerminal,
  });
  const daemon = connectFakeDaemon(fixture);
  await daemon.send({ type: 'snapshot', sessions: initialSessions, approvals: [], managers: [] });
  return { fixture, daemon, sessionId };
}

const lifecycleBanner = () => screen.queryByTestId('lifecycle-banner');

describe('SessionViewComponent lifecycle banners — real daemon event order', () => {
  it('reopen → state starting → session.reopened → REST 200 → state idle: Resuming from click to idle, then the composer', async () => {
    // Arrange
    const reopen = deferred<unknown>();
    const api = fakeApi();
    api.reopenSession = vi.fn(() => reopen.promise);
    const { fixture, daemon } = await renderAgainstDaemonEvents(api, [session({ state: 'closed', exitCode: 0, closedAt: CLOSED_AT })]);

    // Act / Assert — each daemon step keeps the banner up without a gap
    await userEvent.click(screen.getByTestId('resume-session'));
    expect(lifecycleBanner()).toHaveAttribute('data-variant', 'resuming');

    await daemon.send({ type: 'session.state', sessionId: 's1', state: 'starting', stateSince: 't2' });
    await daemon.send({ type: 'session.reopened', sessionId: 's1' });
    reopen.resolve({});
    await settleRequests(fixture);
    expect(lifecycleBanner()).toHaveAttribute('data-variant', 'resuming');

    await daemon.send({ type: 'session.state', sessionId: 's1', state: 'idle', stateSince: 't3' });
    expect(lifecycleBanner()).toBeNull();
    expect(screen.getByTestId('composer-input')).toBeTruthy();
  });

  it('reopen → starting → session.closed with exit -2: the Resuming banner gives way to Resume failed with a live Retry', async () => {
    // Arrange
    const reopen = deferred<unknown>();
    const api = fakeApi();
    api.reopenSession = vi.fn(() => reopen.promise);
    const { daemon } = await renderAgainstDaemonEvents(api, [session({ state: 'closed', exitCode: 0, closedAt: CLOSED_AT })]);
    await userEvent.click(screen.getByTestId('resume-session'));
    await daemon.send({ type: 'session.state', sessionId: 's1', state: 'starting', stateSince: 't2' });
    await daemon.send({ type: 'session.reopened', sessionId: 's1' });
    expect(lifecycleBanner()).toHaveAttribute('data-variant', 'resuming');

    // Act
    await daemon.send({ type: 'session.closed', sessionId: 's1', exitCode: -2 });
    reopen.resolve({});

    // Assert
    await waitFor(() => expect(lifecycleBanner()).toHaveAttribute('data-variant', 'error'));
    expect(screen.getByTestId('resume-error')).toHaveTextContent('failed to launch');
    expect((screen.getByTestId('resume-retry') as HTMLButtonElement).disabled).toBe(false);
  });

  it('a boot-resume (starting with closedAt, no reopen click) shows Resuming, and the banner leaves with the first non-starting state', async () => {
    // Arrange
    const { daemon } = await renderAgainstDaemonEvents(fakeApi(), [session({ state: 'starting', closedAt: CLOSED_AT })]);
    expect(lifecycleBanner()).toHaveAttribute('data-variant', 'resuming');

    // Act
    await daemon.send({ type: 'session.state', sessionId: 's1', state: 'idle', stateSince: 't2' });

    // Assert
    expect(lifecycleBanner()).toBeNull();
  });

  it('a Retry settling after the user navigated away leaves the other session clean, and the failed session still offers Retry on return', async () => {
    // Arrange
    const retry = deferred<unknown>();
    const api = fakeApi();
    api.reopenSession = vi.fn(() => retry.promise);
    const { fixture, sessionId } = await renderAgainstDaemonEvents(api, [
      session({ id: 's1', state: 'closed', exitCode: -1, closedAt: CLOSED_AT }),
      session({ id: 's2', name: 'Legolas', state: 'closed', exitCode: 0, closedAt: CLOSED_AT }),
    ]);
    await userEvent.click(screen.getByTestId('resume-retry'));
    sessionId.set('s2');
    await fixture.whenStable();

    // Act
    retry.reject(new ApiError(500, 'boom', 'launch_failed'));
    await settleRequests(fixture);

    // Assert
    expect(lifecycleBanner()).toBeNull();
    sessionId.set('s1');
    await fixture.whenStable();
    expect(lifecycleBanner()).toHaveAttribute('data-variant', 'error');
    expect((screen.getByTestId('resume-retry') as HTMLButtonElement).disabled).toBe(false);
  });
});

describe('SessionViewComponent lifecycle banners — accessibility', () => {
  it('puts the Resuming text inside a polite live region that is already in the page while nothing resumes', async () => {
    // Arrange
    const { daemon } = await renderAgainstDaemonEvents(fakeApi(), [session({ state: 'closed', exitCode: 0, closedAt: CLOSED_AT })]);
    const liveRegion = screen.getByTestId('lifecycle-live-region');
    expect(liveRegion).toHaveAttribute('aria-live', 'polite');
    expect(liveRegion).toBeEmptyDOMElement();

    // Act
    await daemon.send({ type: 'session.state', sessionId: 's1', state: 'starting', stateSince: 't2' });

    // Assert
    expect(liveRegion).toContainElement(lifecycleBanner());
    expect(lifecycleBanner()).toHaveTextContent('Resuming…');
    expect(lifecycleBanner()).not.toHaveAttribute('role');
  });

  it('announces Resume failed assertively (alert) when a resuming session dies', async () => {
    // Arrange
    const { daemon } = await renderAgainstDaemonEvents(fakeApi(), [session({ state: 'starting', closedAt: CLOSED_AT })]);

    // Act
    await daemon.send({ type: 'session.closed', sessionId: 's1', exitCode: -1 });

    // Assert
    expect(lifecycleBanner()).toHaveAttribute('role', 'alert');
  });

  it('raises no alert for a session that was already failed when the user opened it', async () => {
    await renderAgainstDaemonEvents(fakeApi(), [session({ state: 'closed', exitCode: 1 })]);

    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('raises one alert when the session the user is watching closes with an error', async () => {
    // Arrange
    const { daemon } = await renderAgainstDaemonEvents(fakeApi(), [session({ state: 'generating' })]);
    expect(screen.queryByRole('alert')).toBeNull();

    // Act
    await daemon.send({ type: 'session.closed', sessionId: 's1', exitCode: 1 });

    // Assert
    expect(screen.getAllByRole('alert')).toHaveLength(1);
    expect(screen.getByTestId('session-closed-footer')).toHaveAttribute('role', 'alert');
  });

  it('raises no alert when the user navigates to a session that failed while they were looking at another one', async () => {
    // Arrange
    const { daemon, sessionId } = await renderAgainstDaemonEvents(fakeApi(), [
      session({ id: 's1', state: 'generating' }),
      session({ id: 's2', name: 'Legolas', state: 'generating' }),
    ]);
    await daemon.send({ type: 'session.closed', sessionId: 's2', exitCode: 1 });

    // Act
    sessionId.set('s2');
    await daemon.send({ type: 'session.state', sessionId: 's1', state: 'idle', stateSince: 't2' });

    // Assert
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it.each([
    { scenario: 'the Resume failed banner', exitCode: -1, testId: 'resume-failed-reopen-fresh' },
    { scenario: 'the closed footer', exitCode: 0, testId: 'reopen-fresh-session' },
  ])('keeps the unavailable "Reopen fresh" of $scenario focusable and describes why it is unavailable', async ({ exitCode, testId }) => {
    // Arrange
    await renderAgainstDaemonEvents(fakeApi(), [session({ state: 'closed', exitCode, closedAt: CLOSED_AT })]);
    const reopenFresh = screen.getByTestId(testId);

    // Act
    reopenFresh.focus();

    // Assert
    expect(reopenFresh).toHaveAttribute('aria-disabled', 'true');
    expect(reopenFresh).not.toBeDisabled();
    expect(reopenFresh).toHaveFocus();
    expect(reopenFresh).toHaveAccessibleDescription(/not available yet/i);
  });

  it('does not reopen anything when the unavailable "Reopen fresh" is clicked', async () => {
    // Arrange
    const api = fakeApi();
    await renderAgainstDaemonEvents(api, [session({ state: 'closed', exitCode: 0, closedAt: CLOSED_AT })]);

    // Act
    await userEvent.click(screen.getByTestId('reopen-fresh-session'));

    // Assert
    expect(api.reopenSession).not.toHaveBeenCalled();
  });

  it('announces a failed resume once, not through two alerts', async () => {
    await renderAgainstDaemonEvents(fakeApi(), [session({ state: 'closed', exitCode: -2, closedAt: CLOSED_AT })]);

    expect(screen.getAllByRole('alert')).toHaveLength(1);
  });

  it('offers one "Reopen fresh" action on a failed resume, not one in the banner and one in the footer', async () => {
    await renderAgainstDaemonEvents(fakeApi(), [session({ state: 'closed', exitCode: -2, closedAt: CLOSED_AT })]);

    expect(screen.getAllByRole('button', { name: /reopen fresh/i })).toHaveLength(1);
  });
});

describe('SessionViewComponent lifecycle banners — sessions closed while the UI is connected', () => {
  it('live → session.closed → Resume → REST 200 → starting: Resuming stays up for the whole starting window, then leaves at idle', async () => {
    // Arrange — the snapshot holds a live session with no closedAt, as the daemon sends it
    const api = fakeApi();
    const { fixture, daemon } = await renderAgainstDaemonEvents(api, [session({ state: 'idle' })]);
    await daemon.send({ type: 'session.closed', sessionId: 's1', exitCode: 0 });

    // Act
    await userEvent.click(screen.getByTestId('resume-session'));
    await daemon.send({ type: 'session.state', sessionId: 's1', state: 'starting', stateSince: 't2' });
    await daemon.send({ type: 'session.reopened', sessionId: 's1' });
    await settleRequests(fixture);

    // Assert
    expect(lifecycleBanner()).toHaveAttribute('data-variant', 'resuming');

    await daemon.send({ type: 'session.state', sessionId: 's1', state: 'idle', stateSince: 't3' });
    expect(lifecycleBanner()).toBeNull();
  });

  it('shows Resuming for a session that another client reopens after it closed live, with no click here', async () => {
    // Arrange
    const { daemon } = await renderAgainstDaemonEvents(fakeApi(), [session({ state: 'idle' })]);
    await daemon.send({ type: 'session.closed', sessionId: 's1', exitCode: 0 });

    // Act
    await daemon.send({ type: 'session.reopened', sessionId: 's1' });

    // Assert
    expect(lifecycleBanner()).toHaveAttribute('data-variant', 'resuming');
  });

  it('shows no Resuming banner on a model relaunch from idle after a live close and resume', async () => {
    // Arrange — closed live, resumed, idle again
    const { daemon } = await renderAgainstDaemonEvents(fakeApi(), [session({ state: 'idle' })]);
    await daemon.send({ type: 'session.closed', sessionId: 's1', exitCode: 0 });
    await daemon.send({ type: 'session.reopened', sessionId: 's1' });
    await daemon.send({ type: 'session.state', sessionId: 's1', state: 'idle', stateSince: 't3' });

    // Act
    await daemon.send({ type: 'session.state', sessionId: 's1', state: 'starting', stateSince: 't4' });

    // Assert
    expect(lifecycleBanner()).toBeNull();
  });
});

describe('SessionViewComponent lifecycle banners — sessions that closed long ago', () => {
  it('shows no Resuming banner when an already-resumed session relaunches for a model switch', async () => {
    // Arrange — a session reopened long ago: idle again, closedAt still stamped
    const { daemon } = await renderAgainstDaemonEvents(fakeApi(), [session({ state: 'idle', closedAt: CLOSED_AT })]);

    // Act — the daemon relaunches it for a model switch: session.state starting, no closed state in between
    await daemon.send({ type: 'session.state', sessionId: 's1', state: 'starting', stateSince: 't2' });

    // Assert
    expect(lifecycleBanner()).toBeNull();
  });

  it('does not resurface an earlier failed reopen as Resume failed once the session resumed and later closed cleanly', async () => {
    // Arrange — the reopen reply is lost, yet the daemon relaunches the session
    const api = fakeApi();
    api.reopenSession = vi.fn().mockRejectedValue(new Error('network down'));
    const { fixture, daemon } = await renderAgainstDaemonEvents(api, [session({ state: 'closed', exitCode: 0, closedAt: CLOSED_AT })]);
    await userEvent.click(screen.getByTestId('resume-session'));
    await settleRequests(fixture);
    await daemon.send({ type: 'session.state', sessionId: 's1', state: 'starting', stateSince: 't2' });
    await daemon.send({ type: 'session.reopened', sessionId: 's1' });
    await daemon.send({ type: 'session.state', sessionId: 's1', state: 'idle', stateSince: 't3' });

    // Act — the user finishes and the session closes cleanly
    await daemon.send({ type: 'session.closed', sessionId: 's1', exitCode: 0 });

    // Assert
    expect(lifecycleBanner()).toBeNull();
  });

  it('shows no Resuming banner when the full row a model relaunch brings back still carries the old closedAt', async () => {
    // Arrange — a live session; the DB row of a session that closed once keeps its closed_at forever
    const { daemon } = await renderAgainstDaemonEvents(fakeApi(), [session({ state: 'idle' })]);
    await daemon.send({ type: 'session.state', sessionId: 's1', state: 'starting', stateSince: 't2' });

    // Act — the rename / update that follows carries the whole row, stale closedAt included
    await daemon.send({ type: 'session.updated', session: session({ state: 'starting', closedAt: CLOSED_AT }) });

    // Assert
    expect(lifecycleBanner()).toBeNull();
  });

  it('keeps Resuming up when a rename brings the full row while a closed session is coming back', async () => {
    // Arrange
    const { daemon } = await renderAgainstDaemonEvents(fakeApi(), [session({ state: 'closed', exitCode: 0, closedAt: CLOSED_AT })]);
    await daemon.send({ type: 'session.state', sessionId: 's1', state: 'starting', stateSince: 't2' });
    await daemon.send({ type: 'session.reopened', sessionId: 's1' });

    // Act
    await daemon.send({ type: 'session.updated', session: session({ state: 'starting', closedAt: CLOSED_AT }) });

    // Assert
    expect(lifecycleBanner()).toHaveAttribute('data-variant', 'resuming');
  });

  it('does not arm a Resume failed banner from a reopen rejection that lands after the session is already live', async () => {
    // Arrange — the reopen reply is slow: the daemon relaunches the session and it is idle before the REST answer fails
    const reopen = deferred<unknown>();
    const api = fakeApi();
    api.reopenSession = vi.fn(() => reopen.promise);
    const { fixture, daemon } = await renderAgainstDaemonEvents(api, [session({ state: 'closed', exitCode: 0, closedAt: CLOSED_AT })]);
    await userEvent.click(screen.getByTestId('resume-session'));
    await daemon.send({ type: 'session.state', sessionId: 's1', state: 'starting', stateSince: 't2' });
    await daemon.send({ type: 'session.reopened', sessionId: 's1' });
    await daemon.send({ type: 'session.state', sessionId: 's1', state: 'idle', stateSince: 't3' });
    reopen.reject(new Error('network down'));
    await settleRequests(fixture);

    // Act — the user finishes and the session closes cleanly
    await daemon.send({ type: 'session.closed', sessionId: 's1', exitCode: 0 });

    // Assert
    expect(lifecycleBanner()).toBeNull();
  });

  it('does not let a 409 that lands while the session is starting override the exit-code reason of a later failed resume', async () => {
    // Arrange — another client already reopened the session: the daemon answers this click with 409 not_closed
    const reopen = deferred<unknown>();
    const api = fakeApi();
    api.reopenSession = vi.fn(() => reopen.promise);
    const { fixture, daemon } = await renderAgainstDaemonEvents(api, [session({ state: 'closed', exitCode: 0, closedAt: CLOSED_AT })]);
    await userEvent.click(screen.getByTestId('resume-session'));
    await daemon.send({ type: 'session.state', sessionId: 's1', state: 'starting', stateSince: 't2' });
    await daemon.send({ type: 'session.reopened', sessionId: 's1' });
    reopen.reject(new ApiError(409, 'boom', 'not_closed'));
    await settleRequests(fixture);

    // Act — the relaunch then dies with the launch-failed exit code
    await daemon.send({ type: 'session.closed', sessionId: 's1', exitCode: -2 });

    // Assert
    expect(lifecycleBanner()).toHaveAttribute('data-variant', 'error');
    expect(screen.getByTestId('resume-error')).toHaveTextContent('failed to launch');
    expect(screen.getByTestId('resume-error')).not.toHaveTextContent('not closed');
  });
});

describe('SessionViewComponent reopen — a request that outlives a session switch', () => {
  const TWO_CLOSED_SESSIONS = [
    session({ id: 's1', state: 'closed', exitCode: 0, closedAt: CLOSED_AT }),
    session({ id: 's2', name: 'Legolas', state: 'closed', exitCode: 0, closedAt: CLOSED_AT }),
  ];

  async function renderOnBothSessions(reopenSession: (sessionId: string) => Promise<unknown>) {
    const api = fakeApi();
    api.reopenSession = vi.fn(reopenSession);
    const rendered = await renderAgainstDaemonEvents(api, TWO_CLOSED_SESSIONS);
    const goTo = async (id: string) => {
      rendered.sessionId.set(id);
      await rendered.fixture.whenStable();
    };
    return { ...rendered, api, goTo };
  }

  it('keeps Resume disabled with the Resuming banner after A → B → A while the first reopen is pending, then enables it once it settles', async () => {
    // Arrange
    const reopen = deferred<unknown>();
    const { fixture, api, goTo } = await renderOnBothSessions(() => reopen.promise);
    await userEvent.click(screen.getByTestId('resume-session'));
    await goTo('s2');
    await goTo('s1');
    expect(screen.getByTestId('resume-session')).toBeDisabled();
    expect(lifecycleBanner()).toHaveAttribute('data-variant', 'resuming');

    // Act
    reopen.resolve({});
    await settleRequests(fixture);

    // Assert
    expect(lifecycleBanner()).toBeNull();
    expect(screen.getByTestId('resume-session')).toBeEnabled();
    expect(api.reopenSession).toHaveBeenCalledTimes(1);
  });

  it('shows the failure of the first reopen on A when it fails after A → B → A', async () => {
    const reopen = deferred<unknown>();
    const { fixture, goTo } = await renderOnBothSessions(() => reopen.promise);
    await userEvent.click(screen.getByTestId('resume-session'));
    await goTo('s2');
    await goTo('s1');

    reopen.reject(new ApiError(500, 'boom', 'launch_failed'));
    await settleRequests(fixture);

    expect(lifecycleBanner()).toHaveAttribute('data-variant', 'error');
    expect(screen.getByTestId('resume-retry')).toBeEnabled();
  });

  it('leaves B clean when the reopen of A resolves while B is shown', async () => {
    const reopen = deferred<unknown>();
    const { fixture, goTo } = await renderOnBothSessions(() => reopen.promise);
    await userEvent.click(screen.getByTestId('resume-session'));
    await goTo('s2');

    reopen.resolve({});
    await settleRequests(fixture);

    expect(lifecycleBanner()).toBeNull();
    expect(screen.getByTestId('resume-session')).toBeEnabled();
  });

  it.each([
    { outcome: 'resolves', settle: (reopen: ReturnType<typeof deferred<unknown>>) => reopen.resolve({}) },
    { outcome: 'rejects', settle: (reopen: ReturnType<typeof deferred<unknown>>) => reopen.reject(new ApiError(500, 'boom', 'launch_failed')) },
  ])('keeps the reopen of B busy when the reopen of A $outcome while B is shown', async ({ settle }) => {
    const reopenOfA = deferred<unknown>();
    const reopenOfB = deferred<unknown>();
    const { fixture, goTo } = await renderOnBothSessions((sessionId) => (sessionId === 's1' ? reopenOfA.promise : reopenOfB.promise));
    await userEvent.click(screen.getByTestId('resume-session'));
    await goTo('s2');
    await userEvent.click(screen.getByTestId('resume-session'));

    settle(reopenOfA);
    await settleRequests(fixture);

    expect(lifecycleBanner()).toHaveAttribute('data-variant', 'resuming');
    expect(screen.getByTestId('resume-session')).toBeDisabled();
    reopenOfB.resolve({});
  });
});
