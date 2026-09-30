import { render, screen, waitFor, fireEvent } from '@testing-library/angular/zoneless';
import userEvent from '@testing-library/user-event';
import { inputBinding, signal } from '@angular/core';
import { Subject } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import type { Approval, Session } from '@openfleet/shared';
import { SessionViewComponent } from './session-view.component';
import { ApiError, FleetApiService } from '../core/fleet-api.service';
import { FleetEventsService } from '../core/fleet-events.service';
import { settleRequests } from '../testing/session-view.testing';
import { fakeWorkingStateEvents, silentWorkingStateSignals, stateOf } from '../working-state/working-state-fixtures';

function session(patch: Partial<Session> = {}): Session {
  return {
    id: 's1', name: 'Gimli', emoji: '⛏️', directory: '/repo', model: 'claude-sonnet-5',
    harness: 'claude-cli', state: 'idle', stateSince: 't', permissionMode: 'manual', createdAt: 't', ...patch,
  } as Session;
}

function approval(patch: Partial<Approval> = {}): Approval {
  return { id: 'a1', sessionId: 's1', toolName: 'Bash', toolInput: { command: 'ls' }, status: 'pending', createdAt: 't', ...patch };
}

function fakeEvents(sessions: Session[], approvals: Approval[] = []) {
  return {
    ...silentWorkingStateSignals(),
    sessions: signal(sessions), approvals: signal(approvals), managers: signal([]),
    connected: signal(true), reconnectCount: signal(0), deliveredMessageIds: signal(new Set<string>()),
    output: () => new Subject<string>(), sendInput: vi.fn(), sendResize: vi.fn(), sendAttach: vi.fn(), dropQueuedSendsFor: vi.fn(),
  };
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

describe('SessionViewComponent State panel', () => {
  const eventsWithStates = (sessions: Session[], states: ReturnType<typeof stateOf>[]) => ({ ...fakeEvents(sessions), ...fakeWorkingStateEvents({ sessions, states }) });

  it('user finds the State panel between the header and the terminal, collapsed', async () => {
    await render(SessionViewComponent, {
      bindings: [inputBinding('sessionId', () => 's1')],
      providers: [{ provide: FleetApiService, useValue: fakeApi() }, { provide: FleetEventsService, useValue: eventsWithStates([session()], [stateOf({ plan: ['ship it'] })]) }],
    });

    const panel = screen.getByTestId('state-panel');
    expect(screen.getByTestId('session-header').compareDocumentPosition(panel) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(panel.compareDocumentPosition(screen.getByTestId('terminal')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.queryByTestId('state-panel-body')).toBeNull();
  });

  it('user can read the session state without leaving the session view', async () => {
    await render(SessionViewComponent, {
      bindings: [inputBinding('sessionId', () => 's1')],
      providers: [{ provide: FleetApiService, useValue: fakeApi() }, { provide: FleetEventsService, useValue: eventsWithStates([session()], [stateOf({ plan: ['ship it'] })]) }],
    });

    await userEvent.click(screen.getByTestId('state-panel-toggle'));

    expect(screen.getByTestId('state-section-plan')).toHaveTextContent('ship it');
  });

  it('user picking another session finds its State panel closed and showing its own state', async () => {
    const shownSessionId = signal('s1');
    const sessions = [session({ id: 's1' }), session({ id: 's2', name: 'Legolas' })];
    const events = eventsWithStates(sessions, [stateOf({ sessionId: 's1', plan: ['first plan'] }), stateOf({ sessionId: 's2', plan: ['second plan'] })]);
    const { fixture } = await render(SessionViewComponent, {
      bindings: [inputBinding('sessionId', shownSessionId)],
      providers: [{ provide: FleetApiService, useValue: fakeApi() }, { provide: FleetEventsService, useValue: events }],
    });
    await userEvent.click(screen.getByTestId('state-panel-toggle'));
    expect(screen.getByTestId('state-section-plan')).toHaveTextContent('first plan');

    shownSessionId.set('s2');
    await fixture.whenStable();

    expect(screen.queryByTestId('state-panel-body')).toBeNull();
    await userEvent.click(screen.getByTestId('state-panel-toggle'));
    expect(screen.getByTestId('state-section-plan')).toHaveTextContent('second plan');
  });

  it('user keeps the State panel open while the same session goes from idle to generating', async () => {
    const events = eventsWithStates([session({ state: 'idle' })], [stateOf({ plan: ['ship it'] })]);
    const { fixture } = await render(SessionViewComponent, {
      bindings: [inputBinding('sessionId', () => 's1')],
      providers: [{ provide: FleetApiService, useValue: fakeApi() }, { provide: FleetEventsService, useValue: events }],
    });
    await userEvent.click(screen.getByTestId('state-panel-toggle'));

    events.sessions.set([session({ state: 'generating', stateSince: 't2' })]);
    await fixture.whenStable();

    expect(screen.getByTestId('state-panel-toggle')).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByTestId('state-section-plan')).toHaveTextContent('ship it');
  });

  it('user still finds the State panel on a closed session', async () => {
    await render(SessionViewComponent, {
      bindings: [inputBinding('sessionId', () => 's1')],
      providers: [{ provide: FleetApiService, useValue: fakeApi() }, { provide: FleetEventsService, useValue: eventsWithStates([session({ state: 'closed', exitCode: 0 })], []) }],
    });

    expect(screen.getByTestId('state-panel')).toBeTruthy();
  });
});

describe('SessionViewComponent', () => {
  it('renders the header and terminal for an open session', async () => {
    await render(SessionViewComponent, {
      bindings: [inputBinding('sessionId', () => 's1')],
      providers: [{ provide: FleetApiService, useValue: fakeApi() }, { provide: FleetEventsService, useValue: fakeEvents([session()]) }],
    });
    expect(screen.getByTestId('session-header')).toBeTruthy();
    expect(screen.getByTestId('terminal')).toBeTruthy();
  });

  it('renders the permission gate card inline while waiting on a permission', async () => {
    await render(SessionViewComponent, {
      bindings: [inputBinding('sessionId', () => 's1')],
      providers: [
        { provide: FleetApiService, useValue: fakeApi() },
        { provide: FleetEventsService, useValue: fakeEvents([session({ state: 'waiting_permission' })], [approval()]) },
      ],
    });
    expect(screen.getByTestId('permission-gate-card')).toBeTruthy();
  });

  it('replaces the composer with a neutral banner and an enabled Resume action when the session closed cleanly', async () => {
    await render(SessionViewComponent, {
      bindings: [inputBinding('sessionId', () => 's1')],
      providers: [{ provide: FleetApiService, useValue: fakeApi() }, { provide: FleetEventsService, useValue: fakeEvents([session({ state: 'closed', exitCode: 0 })]) }],
    });
    expect(screen.getByTestId('session-closed-footer')).toHaveAttribute('data-variant', 'neutral');
    expect(screen.queryByTestId('composer-input')).toBeNull();
    const resume = screen.getByTestId('resume-session') as HTMLButtonElement;
    expect(resume.disabled).toBe(false);
  });

  it('resumes a closed session by calling reopenSession', async () => {
    const api = fakeApi();
    await render(SessionViewComponent, {
      bindings: [inputBinding('sessionId', () => 's1')],
      providers: [{ provide: FleetApiService, useValue: api }, { provide: FleetEventsService, useValue: fakeEvents([session({ state: 'closed', exitCode: 0 })]) }],
    });

    await userEvent.click(screen.getByTestId('resume-session'));

    expect(api.reopenSession).toHaveBeenCalledWith('s1');
  });

  it('sends only one reopen request when Resume is double-clicked before the request resolves', async () => {
    let resolveReopen: (value: unknown) => void = () => {};
    const api = fakeApi();
    api.reopenSession = vi.fn(() => new Promise((resolve) => { resolveReopen = resolve; }));
    await render(SessionViewComponent, {
      bindings: [inputBinding('sessionId', () => 's1')],
      providers: [{ provide: FleetApiService, useValue: api }, { provide: FleetEventsService, useValue: fakeEvents([session({ state: 'closed', exitCode: 0 })]) }],
    });
    const resumeButton = screen.getByTestId('resume-session') as HTMLButtonElement;

    fireEvent.click(resumeButton);
    fireEvent.click(resumeButton);
    resolveReopen({});
    await waitFor(() => expect(resumeButton.disabled).toBe(false));

    expect(api.reopenSession).toHaveBeenCalledTimes(1);
  });

  it('clears a previous session\'s resume error when navigating to a different session', async () => {
    const sessionId = signal('s1');
    const api = fakeApi();
    api.reopenSession = vi.fn().mockRejectedValue(new ApiError(409, 'boom', 'not_closed'));
    await render(SessionViewComponent, {
      bindings: [inputBinding('sessionId', sessionId)],
      providers: [
        { provide: FleetApiService, useValue: api },
        {
          provide: FleetEventsService,
          useValue: fakeEvents([session({ id: 's1', state: 'closed', exitCode: 0 }), session({ id: 's2', name: 'Legolas', state: 'closed', exitCode: 0 })]),
        },
      ],
    });

    await userEvent.click(screen.getByTestId('resume-session'));
    await waitFor(() => expect(screen.getByTestId('resume-error')).toBeTruthy());

    sessionId.set('s2');

    await waitFor(() => expect(screen.queryByTestId('resume-error')).toBeNull());
  });

  it('a resume request for a previous session settling late does not surface its error on the new session, nor release the new session\'s own busy flag', async () => {
    const sessionId = signal('s1');
    let rejectA: (reason?: unknown) => void = () => {};
    let resolveB: (value: unknown) => void = () => {};
    const api = fakeApi();
    api.reopenSession = vi.fn()
      .mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectA = reject; }))
      .mockImplementationOnce(() => new Promise((resolve) => { resolveB = resolve; }));
    const { fixture } = await render(SessionViewComponent, {
      bindings: [inputBinding('sessionId', sessionId)],
      providers: [
        { provide: FleetApiService, useValue: api },
        {
          provide: FleetEventsService,
          useValue: fakeEvents([session({ id: 's1', state: 'closed', exitCode: 0 }), session({ id: 's2', name: 'Legolas', state: 'closed', exitCode: 0 })]),
        },
      ],
    });

    await userEvent.click(screen.getByTestId('resume-session')); // session A's resume is now in flight, unresolved

    sessionId.set('s2');
    await fixture.whenStable();
    const resumeButton = screen.getByTestId('resume-session') as HTMLButtonElement;
    expect(resumeButton.disabled).toBe(false);

    await userEvent.click(resumeButton); // session B's own resume, also in flight
    expect(resumeButton.disabled).toBe(true);

    rejectA(new ApiError(409, 'boom', 'not_closed'));
    await settleRequests(fixture);

    expect(screen.queryByTestId('resume-error')).toBeNull();
    expect(resumeButton.disabled).toBe(true); // B's own in-flight request must still be tracked as busy

    resolveB({});
    await waitFor(() => expect(resumeButton.disabled).toBe(false));
  });

  it.each([
    ['not_closed', 'This session is not closed — nothing to resume.'],
    ['directory_missing', "This session's directory no longer exists — nothing to resume into."],
    ['directory_changed', "This session's directory changed since it closed — resume refused for safety."],
    ['directory_unreadable', "This session's directory can't be read — check its permissions."],
    ['launch_failed', 'The harness failed to relaunch — try again.'],
  ] as const)('shows a readable error for a %s reopen failure', async (code, message) => {
    const api = fakeApi();
    api.reopenSession = vi.fn().mockRejectedValue(new ApiError(code === 'launch_failed' ? 500 : 409, 'boom', code));
    await render(SessionViewComponent, {
      bindings: [inputBinding('sessionId', () => 's1')],
      providers: [{ provide: FleetApiService, useValue: api }, { provide: FleetEventsService, useValue: fakeEvents([session({ state: 'closed', exitCode: 0 })]) }],
    });

    await userEvent.click(screen.getByTestId('resume-session'));

    await waitFor(() => expect(screen.getByTestId('resume-error')).toHaveTextContent(message));
  });

  it('shows a generic error for a reopen failure with no recognized code', async () => {
    const api = fakeApi();
    api.reopenSession = vi.fn().mockRejectedValue(new Error('network down'));
    await render(SessionViewComponent, {
      bindings: [inputBinding('sessionId', () => 's1')],
      providers: [{ provide: FleetApiService, useValue: api }, { provide: FleetEventsService, useValue: fakeEvents([session({ state: 'closed', exitCode: 0 })]) }],
    });

    await userEvent.click(screen.getByTestId('resume-session'));

    await waitFor(() => expect(screen.getByTestId('resume-error')).toHaveTextContent('Could not resume the session — try again.'));
  });

  it('shows an error banner when the session closed with a non-zero exit code', async () => {
    await render(SessionViewComponent, {
      bindings: [inputBinding('sessionId', () => 's1')],
      providers: [{ provide: FleetApiService, useValue: fakeApi() }, { provide: FleetEventsService, useValue: fakeEvents([session({ state: 'closed', exitCode: 1 })]) }],
    });
    expect(screen.getByTestId('session-closed-footer')).toHaveAttribute('data-variant', 'error');
  });

  it('agrees with the header about an undefined exit code instead of showing it as both a clean and a failed close', async () => {
    // Arrange — an undefined exitCode is neither known-clean nor known-failed, so the header
    // (session-header.component.ts) shows a bare "closed" and the banner must not call it an error.
    await render(SessionViewComponent, {
      bindings: [inputBinding('sessionId', () => 's1')],
      providers: [{ provide: FleetApiService, useValue: fakeApi() }, { provide: FleetEventsService, useValue: fakeEvents([session({ state: 'closed', exitCode: undefined })]) }],
    });

    // Assert — neither a clean nor a failed close: the header shows no exit number, the banner stays non-error
    expect(screen.getByTestId('session-exit-code')).toHaveTextContent('closed');
    expect(screen.getByTestId('session-exit-code')).not.toHaveTextContent('exit');
    expect(screen.getByTestId('session-closed-footer')).toHaveAttribute('data-variant', 'neutral');
  });

  it('shows the composer for an open, non-gated session', async () => {
    await render(SessionViewComponent, {
      bindings: [inputBinding('sessionId', () => 's1')],
      providers: [{ provide: FleetApiService, useValue: fakeApi() }, { provide: FleetEventsService, useValue: fakeEvents([session()]) }],
    });
    expect(screen.getByTestId('composer-input')).toBeTruthy();
  });

  it('tells the composer the session is busy while it is generating, so it queues instead of sending', async () => {
    await render(SessionViewComponent, {
      bindings: [inputBinding('sessionId', () => 's1')],
      providers: [{ provide: FleetApiService, useValue: fakeApi() }, { provide: FleetEventsService, useValue: fakeEvents([session({ state: 'generating' })]) }],
    });
    expect(screen.getByTestId('composer-send')).toHaveTextContent('Queue');
  });

  it('offers Interrupt in the header while the session is generating', async () => {
    await render(SessionViewComponent, {
      bindings: [inputBinding('sessionId', () => 's1')],
      providers: [{ provide: FleetApiService, useValue: fakeApi() }, { provide: FleetEventsService, useValue: fakeEvents([session({ state: 'generating' })]) }],
    });
    expect(screen.getByTestId('session-interrupt')).toBeTruthy();
  });

  describe('resume lifecycle banners', () => {
    const CLOSED_AT = '2026-09-26T10:00:00.000Z';

    it('shows a Resuming banner while the daemon relaunches a session that had closed', async () => {
      await render(SessionViewComponent, {
        bindings: [inputBinding('sessionId', () => 's1')],
        providers: [{ provide: FleetApiService, useValue: fakeApi() }, { provide: FleetEventsService, useValue: fakeEvents([session({ state: 'starting', closedAt: CLOSED_AT })]) }],
      });

      const banner = screen.getByTestId('lifecycle-banner');
      expect(banner).toHaveAttribute('data-variant', 'resuming');
      expect(banner).toHaveTextContent('Resuming…');
    });

    it('shows no lifecycle banner for a brand-new session that is starting for the first time', async () => {
      await render(SessionViewComponent, {
        bindings: [inputBinding('sessionId', () => 's1')],
        providers: [{ provide: FleetApiService, useValue: fakeApi() }, { provide: FleetEventsService, useValue: fakeEvents([session({ state: 'starting' })]) }],
      });

      expect(screen.queryByTestId('lifecycle-banner')).toBeNull();
    });

    it('shows a Resume failed banner with the reason when the reopen request is rejected', async () => {
      const api = fakeApi();
      api.reopenSession = vi.fn().mockRejectedValue(new ApiError(409, 'boom', 'directory_missing'));
      await render(SessionViewComponent, {
        bindings: [inputBinding('sessionId', () => 's1')],
        providers: [{ provide: FleetApiService, useValue: api }, { provide: FleetEventsService, useValue: fakeEvents([session({ state: 'closed', exitCode: 0, closedAt: CLOSED_AT })]) }],
      });

      await userEvent.click(screen.getByTestId('resume-session'));

      await waitFor(() => expect(screen.getByTestId('lifecycle-banner')).toHaveAttribute('data-variant', 'error'));
      expect(screen.getByTestId('lifecycle-banner')).toHaveTextContent('Resume failed');
      expect(screen.getByTestId('resume-error')).toHaveTextContent("This session's directory no longer exists");
    });

    it.each([
      [-1, 'timed out'],
      [-2, 'failed to launch'],
    ] as const)('shows a Resume failed banner for a session the daemon closed with resume exit code %i', async (exitCode, reason) => {
      await render(SessionViewComponent, {
        bindings: [inputBinding('sessionId', () => 's1')],
        providers: [{ provide: FleetApiService, useValue: fakeApi() }, { provide: FleetEventsService, useValue: fakeEvents([session({ state: 'closed', exitCode, closedAt: CLOSED_AT })]) }],
      });

      expect(screen.getByTestId('lifecycle-banner')).toHaveTextContent('Resume failed');
      expect(screen.getByTestId('resume-error')).toHaveTextContent(reason);
    });

    it('does not call an ordinary non-zero exit a failed resume', async () => {
      await render(SessionViewComponent, {
        bindings: [inputBinding('sessionId', () => 's1')],
        providers: [{ provide: FleetApiService, useValue: fakeApi() }, { provide: FleetEventsService, useValue: fakeEvents([session({ state: 'closed', exitCode: 1, closedAt: CLOSED_AT })]) }],
      });

      expect(screen.queryByTestId('lifecycle-banner')).toBeNull();
    });

    it('retries the reopen from the Resume failed banner and swaps it for the Resuming banner', async () => {
      let resolveRetry: (value: unknown) => void = () => {};
      const api = fakeApi();
      api.reopenSession = vi.fn()
        .mockRejectedValueOnce(new ApiError(500, 'boom', 'launch_failed'))
        .mockImplementationOnce(() => new Promise((resolve) => { resolveRetry = resolve; }));
      await render(SessionViewComponent, {
        bindings: [inputBinding('sessionId', () => 's1')],
        providers: [{ provide: FleetApiService, useValue: api }, { provide: FleetEventsService, useValue: fakeEvents([session({ state: 'closed', exitCode: 0, closedAt: CLOSED_AT })]) }],
      });
      await userEvent.click(screen.getByTestId('resume-session'));
      await waitFor(() => expect(screen.getByTestId('lifecycle-banner')).toHaveTextContent('Resume failed'));

      await userEvent.click(screen.getByTestId('resume-retry'));

      expect(api.reopenSession).toHaveBeenCalledTimes(2);
      expect(screen.getByTestId('lifecycle-banner')).toHaveTextContent('Resuming…');
      resolveRetry({});
    });

  });

  describe('closed footer call-to-actions', () => {
    it.each([
      ['closed', 0],
      ['closed_error', 1],
    ] as const)('offers "Resume in worktree" and an unavailable "Reopen fresh" for a %s session', async (_variant, exitCode) => {
      await render(SessionViewComponent, {
        bindings: [inputBinding('sessionId', () => 's1')],
        providers: [{ provide: FleetApiService, useValue: fakeApi() }, { provide: FleetEventsService, useValue: fakeEvents([session({ state: 'closed', exitCode })]) }],
      });

      expect(screen.getByTestId('resume-session')).toHaveTextContent('Resume in worktree');
      const reopenFresh = screen.getByTestId('reopen-fresh-session');
      expect(reopenFresh).toHaveTextContent('Reopen fresh');
      expect(reopenFresh).toHaveAttribute('aria-disabled', 'true');
      expect(reopenFresh).toHaveAccessibleDescription(/not available yet/i);
    });
  });

  it('shows a not-found message when the session id matches nothing in the snapshot', async () => {
    await render(SessionViewComponent, {
      bindings: [inputBinding('sessionId', () => 'missing')],
      providers: [{ provide: FleetApiService, useValue: fakeApi() }, { provide: FleetEventsService, useValue: fakeEvents([session()]) }],
    });
    expect(screen.getByTestId('session-view-not-found')).toBeTruthy();
  });
});
