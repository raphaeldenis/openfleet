import { render, screen, waitFor, fireEvent, within } from '@testing-library/angular/zoneless';
import userEvent from '@testing-library/user-event';
import { inputBinding, signal } from '@angular/core';
import { Subject } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { closeReasonOfExitCode, type Approval, type Session } from '@openfleet/shared';
import { SessionViewComponent } from './session-view.component';
import { ApiError, FleetApiService } from '../core/fleet-api.service';
import { FleetEventsService } from '../core/fleet-events.service';
import { settleRequests } from '../testing/session-view.testing';
import { silentWorkingStateSignals } from '../working-state/working-state-fixtures';

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
    sessions: signal(sessions.map((s) => ({ ...s, closeReason: s.closeReason ?? closeReasonOfExitCode(s.exitCode) }))), approvals: signal(approvals), managers: signal([]),
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

describe('SessionViewComponent chrome', () => {
  const renderViewOf = (sessionPatch: Partial<Session> = {}) =>
    render(SessionViewComponent, {
      bindings: [inputBinding('sessionId', () => 's1')],
      providers: [{ provide: FleetApiService, useValue: fakeApi() }, { provide: FleetEventsService, useValue: fakeEvents([session(sessionPatch)]) }],
    });

  it('user finds no session header above the terminal: no identity row, no Details toggle', async () => {
    await renderViewOf();

    expect(screen.queryByTestId('session-header')).toBeNull();
    expect(screen.queryByTestId('session-name-input')).toBeNull();
    expect(screen.queryByTestId('session-header-details-toggle')).toBeNull();
    expect(screen.queryByRole('button', { name: /details/i })).toBeNull();
  });

  it('user finds no State panel row in the session view, its state lives in the right panel', async () => {
    await renderViewOf();

    expect(screen.queryByTestId('state-panel')).toBeNull();
    expect(screen.queryByTestId('state-panel-toggle')).toBeNull();
  });

  it('user finds the terminal tab bar above the terminal', async () => {
    await renderViewOf();

    const tabBar = screen.getByTestId('terminal-tab-bar');
    expect(tabBar.compareDocumentPosition(screen.getByTestId('terminal')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('user finds Interrupt in the terminal tab bar while the session is generating', async () => {
    await renderViewOf({ state: 'generating' });

    expect(within(screen.getByTestId('terminal-tab-bar')).getByTestId('session-interrupt')).toBeTruthy();
  });

  it.each(['idle', 'waiting_permission', 'starting'] as const)('user finds no Interrupt while the session is %s', async (state) => {
    await renderViewOf({ state });

    expect(screen.queryByTestId('session-interrupt')).toBeNull();
  });

  it('user finds no Interrupt and no Close on a closed session, only the closed footer', async () => {
    await renderViewOf({ state: 'closed', exitCode: 0 });

    expect(screen.queryByTestId('session-interrupt')).toBeNull();
    expect(screen.queryByTestId('session-close')).toBeNull();
    expect(screen.getByTestId('session-closed-footer')).toBeTruthy();
  });

  it('user finds Interrupt leave the tab bar when the generating turn ends', async () => {
    const events = fakeEvents([session({ state: 'generating' })]);
    const { fixture } = await render(SessionViewComponent, {
      bindings: [inputBinding('sessionId', () => 's1')],
      providers: [{ provide: FleetApiService, useValue: fakeApi() }, { provide: FleetEventsService, useValue: events }],
    });
    expect(screen.getByTestId('session-interrupt')).toBeTruthy();

    events.sessions.set([{ ...session({ state: 'idle', stateSince: 't2' }), closeReason: undefined }]);
    await fixture.whenStable();

    expect(screen.queryByTestId('session-interrupt')).toBeNull();
  });

  it('user pressing Interrupt in the tab bar sends Escape to the session', async () => {
    const api = fakeApi();
    await render(SessionViewComponent, {
      bindings: [inputBinding('sessionId', () => 's1')],
      providers: [{ provide: FleetApiService, useValue: api }, { provide: FleetEventsService, useValue: fakeEvents([session({ state: 'generating' })]) }],
    });

    await userEvent.click(screen.getByTestId('session-interrupt'));

    expect(api.sendInput).toHaveBeenCalledWith('s1', '\x1b');
  });

  it('user sees a failed Interrupt once, in the tab bar', async () => {
    const api = fakeApi();
    api.sendInput = vi.fn().mockRejectedValue(new Error('network'));
    await render(SessionViewComponent, {
      bindings: [inputBinding('sessionId', () => 's1')],
      providers: [{ provide: FleetApiService, useValue: api }, { provide: FleetEventsService, useValue: fakeEvents([session({ state: 'generating' })]) }],
    });

    await userEvent.click(screen.getByTestId('session-interrupt'));

    expect(await within(screen.getByTestId('terminal-tab-bar')).findByTestId('session-action-error')).toBeTruthy();
    expect(screen.getAllByTestId('session-action-error')).toHaveLength(1);
  });
});


describe('SessionViewComponent right panel toggle', () => {
  it('user finds the right panel toggle on the bar above the terminal and presses it', async () => {
    vi.stubGlobal('localStorage', { getItem: () => 'false', setItem: () => undefined });
    await render(SessionViewComponent, {
      bindings: [inputBinding('sessionId', () => 's1')],
      providers: [{ provide: FleetApiService, useValue: fakeApi() }, { provide: FleetEventsService, useValue: fakeEvents([session()]) }],
    });
    const toggle = screen.getByRole('button', { name: 'Right panel' });
    expect(toggle.compareDocumentPosition(screen.getByTestId('terminal')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(toggle.getAttribute('aria-pressed')).toBe('false');

    await userEvent.click(toggle);

    expect(toggle.getAttribute('aria-pressed')).toBe('true');
    vi.unstubAllGlobals();
  });
});

describe('SessionViewComponent', () => {
  it('renders the terminal and no header for an open session', async () => {
    await render(SessionViewComponent, {
      bindings: [inputBinding('sessionId', () => 's1')],
      providers: [{ provide: FleetApiService, useValue: fakeApi() }, { provide: FleetEventsService, useValue: fakeEvents([session()]) }],
    });
    expect(screen.queryByTestId('session-header')).toBeNull();
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

  it('shows a neutral banner and an enabled Resume action when the session closed cleanly', async () => {
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
    await waitFor(() => expect(screen.getByTestId('lifecycle-message')).toBeTruthy());

    sessionId.set('s2');

    await waitFor(() => expect(screen.queryByTestId('lifecycle-message')).toBeNull());
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

    expect(screen.queryByTestId('lifecycle-message')).toBeNull();
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

    await waitFor(() => expect(screen.getByTestId('lifecycle-message')).toHaveTextContent(message));
  });

  it('shows a generic error for a reopen failure with no recognized code', async () => {
    const api = fakeApi();
    api.reopenSession = vi.fn().mockRejectedValue(new Error('network down'));
    await render(SessionViewComponent, {
      bindings: [inputBinding('sessionId', () => 's1')],
      providers: [{ provide: FleetApiService, useValue: api }, { provide: FleetEventsService, useValue: fakeEvents([session({ state: 'closed', exitCode: 0 })]) }],
    });

    await userEvent.click(screen.getByTestId('resume-session'));

    await waitFor(() => expect(screen.getByTestId('lifecycle-message')).toHaveTextContent('Could not resume the session — try again.'));
  });

  it('shows an error banner when the session closed with a non-zero exit code', async () => {
    await render(SessionViewComponent, {
      bindings: [inputBinding('sessionId', () => 's1')],
      providers: [{ provide: FleetApiService, useValue: fakeApi() }, { provide: FleetEventsService, useValue: fakeEvents([session({ state: 'closed', exitCode: 1 })]) }],
    });
    expect(screen.getByTestId('session-closed-footer')).toHaveAttribute('data-variant', 'error');
  });

  it('does not call a close with an undefined exit code an error', async () => {
    await render(SessionViewComponent, {
      bindings: [inputBinding('sessionId', () => 's1')],
      providers: [{ provide: FleetApiService, useValue: fakeApi() }, { provide: FleetEventsService, useValue: fakeEvents([session({ state: 'closed', exitCode: undefined })]) }],
    });

    expect(screen.getByTestId('session-closed-footer')).toHaveAttribute('data-variant', 'neutral');
  });

  it.each(['idle', 'generating'] as const)('offers the terminal as the only input of an open %s session', async (state) => {
    await render(SessionViewComponent, {
      bindings: [inputBinding('sessionId', () => 's1')],
      providers: [{ provide: FleetApiService, useValue: fakeApi() }, { provide: FleetEventsService, useValue: fakeEvents([session({ state })]) }],
    });
    expect(screen.getByTestId('terminal')).toBeTruthy();
    expect(screen.queryByTestId('composer-input')).toBeNull();
    expect(screen.queryByTestId('composer-send')).toBeNull();
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
      expect(screen.getByTestId('lifecycle-message')).toHaveTextContent("This session's directory no longer exists");
    });

    it.each([
      [-1, 'Resume timed out', 'The session did not come back in time — try again.'],
      [-2, 'Agent could not start', 'The agent could not start — check that the claude CLI is installed'],
    ] as const)('names the failure of a session the daemon closed with resume exit code %i', async (exitCode, title, message) => {
      await render(SessionViewComponent, {
        bindings: [inputBinding('sessionId', () => 's1')],
        providers: [{ provide: FleetApiService, useValue: fakeApi() }, { provide: FleetEventsService, useValue: fakeEvents([session({ state: 'closed', exitCode, closedAt: CLOSED_AT })]) }],
      });

      expect(screen.getByTestId('lifecycle-banner')).toHaveTextContent(title);
      expect(screen.getByTestId('lifecycle-message')).toHaveTextContent(message);
    });

    it('does not call an ordinary non-zero exit a failed resume', async () => {
      await render(SessionViewComponent, {
        bindings: [inputBinding('sessionId', () => 's1')],
        providers: [{ provide: FleetApiService, useValue: fakeApi() }, { provide: FleetEventsService, useValue: fakeEvents([session({ state: 'closed', exitCode: 1, closedAt: CLOSED_AT })]) }],
      });

      expect(screen.getByTestId('lifecycle-banner')).toHaveTextContent('Agent process exited');
      expect(screen.getByTestId('lifecycle-banner')).not.toHaveTextContent(/resume (failed|timed out)/i);
    });

    it('retries the reopen from the closed card after a Resume failed and swaps the strip for the Resuming banner', async () => {
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

      await userEvent.click(screen.getByTestId('resume-session'));

      expect(api.reopenSession).toHaveBeenCalledTimes(2);
      expect(screen.getByTestId('lifecycle-banner')).toHaveTextContent('Resuming…');
      resolveRetry({});
    });

  });

  describe('closed footer call-to-actions', () => {
    it.each([
      ['closed', 0],
      ['closed_error', 1],
    ] as const)('offers "Resume in worktree" and an enabled "Reopen fresh" for a %s session', async (_variant, exitCode) => {
      await render(SessionViewComponent, {
        bindings: [inputBinding('sessionId', () => 's1')],
        providers: [{ provide: FleetApiService, useValue: fakeApi() }, { provide: FleetEventsService, useValue: fakeEvents([session({ state: 'closed', exitCode })]) }],
      });

      expect(screen.getByTestId('resume-session')).toHaveTextContent('Resume in worktree');
      const reopenFresh = screen.getByTestId('reopen-fresh-session');
      expect(reopenFresh).toHaveTextContent('Reopen fresh');
      expect(reopenFresh).toBeEnabled();
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
