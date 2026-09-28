import { render, screen, waitFor } from '@testing-library/angular/zoneless';
import userEvent from '@testing-library/user-event';
import { inputBinding, signal } from '@angular/core';
import { describe, expect, it, vi } from 'vitest';
import type { ServerEvent, Session } from '@openfleet/shared';
import { SessionViewComponent } from './session-view.component';
import { ApiError, FleetApiService } from '../core/fleet-api.service';
import { FleetEventsService } from '../core/fleet-events.service';

const CLOSED_AT = '2026-09-26T10:00:00.000Z';

function session(patch: Partial<Session> = {}): Session {
  return {
    id: 's1', name: 'Gimli', emoji: '⛏️', directory: '/repo', model: 'claude-sonnet-5',
    harness: 'claude-cli', state: 'idle', stateSince: 't', permissionMode: 'manual', createdAt: 't', ...patch,
  } as Session;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
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
  });
  const reducer = fixture.debugElement.injector.get(FleetEventsService) as unknown as { reduce(event: ServerEvent): void };
  const daemon = {
    async send(event: ServerEvent) {
      reducer.reduce(event);
      await fixture.whenStable();
    },
  };
  await daemon.send({ type: 'snapshot', sessions: initialSessions, approvals: [], managers: [] });
  return { fixture, daemon, sessionId };
}

const PROMISE_HOPS_OF_A_SETTLED_REQUEST = 10;

/** Runs the continuations chained on a settled request (action → runGuarded → caller), then renders. */
async function settleRequests(fixture: { whenStable(): Promise<unknown> }) {
  for (let hop = 0; hop < PROMISE_HOPS_OF_A_SETTLED_REQUEST; hop++) await Promise.resolve();
  await fixture.whenStable();
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
  it('announces Resuming politely (status) and Resume failed assertively (alert)', async () => {
    // Arrange
    const { daemon } = await renderAgainstDaemonEvents(fakeApi(), [session({ state: 'starting', closedAt: CLOSED_AT })]);
    expect(lifecycleBanner()).toHaveAttribute('role', 'status');

    // Act
    await daemon.send({ type: 'session.closed', sessionId: 's1', exitCode: -1 });

    // Assert
    expect(lifecycleBanner()).toHaveAttribute('role', 'alert');
  });

  it.each([
    { scenario: 'the Resume failed banner', exitCode: -1, testId: 'resume-failed-reopen-fresh' },
    { scenario: 'the closed footer', exitCode: 0, testId: 'reopen-fresh-session' },
  ])('describes the disabled "Reopen fresh" button of $scenario with why it is unavailable, since a disabled button cannot take focus', async ({ exitCode, testId }) => {
    // Arrange
    await renderAgainstDaemonEvents(fakeApi(), [session({ state: 'closed', exitCode, closedAt: CLOSED_AT })]);

    // Assert
    expect(screen.getByTestId(testId)).toHaveAccessibleDescription(/not available yet/i);
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

  // P2-U2e
  it.fails('does not send a second reopen for a session whose first reopen is still in flight after A → B → A', async () => {
    // Arrange
    const reopen = deferred<unknown>();
    const api = fakeApi();
    api.reopenSession = vi.fn(() => reopen.promise);
    const { fixture, sessionId } = await renderAgainstDaemonEvents(api, [
      session({ id: 's1', state: 'closed', exitCode: 0, closedAt: CLOSED_AT }),
      session({ id: 's2', name: 'Legolas', state: 'closed', exitCode: 0, closedAt: CLOSED_AT }),
    ]);
    await userEvent.click(screen.getByTestId('resume-session'));
    sessionId.set('s2');
    await fixture.whenStable();
    sessionId.set('s1');
    await fixture.whenStable();

    // Act
    await userEvent.click(screen.getByTestId('resume-session'));

    // Assert
    expect(api.reopenSession).toHaveBeenCalledTimes(1);
    reopen.resolve({});
  });
});
