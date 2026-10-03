import { render, screen, waitFor, fireEvent } from '@testing-library/angular/zoneless';
import userEvent from '@testing-library/user-event';
import { ErrorHandler, inputBinding, signal } from '@angular/core';
import type { Provider } from '@angular/core';
import { afterAll, beforeAll, describe, expect, it, onTestFinished, vi } from 'vitest';
import type { SessionState } from '@openfleet/shared';
import { SessionActionsComponent } from './session-actions.component';
import { EarlyEscapeHintService } from '../core/early-escape-hint.service';
import { ApiError, FleetApiService } from '../core/fleet-api.service';
import { FleetEventsService } from '../core/fleet-events.service';
import { PendingSwitchesService } from '../core/pending-switches.service';
import { deferred, settleRequests } from '../testing/session-view.testing';

// jsdom lets focus() land inside an inert subtree, where a real browser drops it onto <body>; this
// shim reproduces the browser so a focus() fired before Angular removes `inert` fails here too.
const nativeFocus = HTMLElement.prototype.focus;
beforeAll(() => {
  HTMLElement.prototype.focus = function focusUnlessInert(this: HTMLElement, options?: FocusOptions): void {
    if (this.closest('[inert]')) return;
    nativeFocus.call(this, options);
  };
});
afterAll(() => {
  HTMLElement.prototype.focus = nativeFocus;
});

function bindingsFor(state: SessionState, options: { sessionName?: string; stateSince?: string } = {}) {
  const { sessionName = 'Gimli · T6', stateSince = 't1' } = options;
  return [
    inputBinding('sessionId', () => 's1'),
    inputBinding('state', () => state),
    inputBinding('stateSince', () => stateSince),
    inputBinding('sessionName', () => sessionName),
  ];
}

type Api = { closeSession: ReturnType<typeof vi.fn>; sendInput: ReturnType<typeof vi.fn> };

describe('SessionActionsComponent', () => {
  it('shows Close but not Interrupt for an idle session', async () => {
    await render(SessionActionsComponent, {
      bindings: bindingsFor('idle'),
      providers: [{ provide: FleetApiService, useValue: { closeSession: vi.fn(), sendInput: vi.fn() } }],
    });
    expect(screen.getByTestId('session-close')).toBeTruthy();
    expect(screen.queryByTestId('session-interrupt')).toBeNull();
  });

  it('shows Interrupt only while the session is generating', async () => {
    await render(SessionActionsComponent, {
      bindings: bindingsFor('generating'),
      providers: [{ provide: FleetApiService, useValue: { closeSession: vi.fn(), sendInput: vi.fn() } }],
    });
    expect(screen.getByTestId('session-interrupt')).toBeTruthy();
  });

  it('shows neither action once the session is closed', async () => {
    await render(SessionActionsComponent, {
      bindings: bindingsFor('closed'),
      providers: [{ provide: FleetApiService, useValue: { closeSession: vi.fn(), sendInput: vi.fn() } }],
    });
    expect(screen.queryByTestId('session-close')).toBeNull();
    expect(screen.queryByTestId('session-interrupt')).toBeNull();
  });

  describe('Close', () => {
    it('opens an in-app confirmation dialog naming the session, instead of window.confirm', async () => {
      const confirmSpy = vi.spyOn(window, 'confirm');
      const api = { closeSession: vi.fn(), sendInput: vi.fn() };
      await render(SessionActionsComponent, {
        bindings: bindingsFor('idle', { sessionName: 'Gimli · T6' }),
        providers: [{ provide: FleetApiService, useValue: api }],
      });

      await userEvent.click(screen.getByTestId('session-close'));

      expect(confirmSpy).not.toHaveBeenCalled();
      const dialog = screen.getByTestId('close-confirm-dialog');
      expect(dialog).toHaveAttribute('role', 'dialog');
      expect(dialog).toHaveAttribute('aria-modal', 'true');
      expect(dialog).toHaveTextContent('Close Gimli · T6?');
      confirmSpy.mockRestore();
    });

    it('labels the dialog by its title and focuses Cancel by default', async () => {
      const api = { closeSession: vi.fn(), sendInput: vi.fn() };
      await render(SessionActionsComponent, { bindings: bindingsFor('idle'), providers: [{ provide: FleetApiService, useValue: api }] });

      await userEvent.click(screen.getByTestId('session-close'));

      const dialog = screen.getByTestId('close-confirm-dialog');
      const labelId = dialog.getAttribute('aria-labelledby');
      expect(labelId).toBeTruthy();
      expect(document.getElementById(labelId!)).toHaveTextContent('Close Gimli · T6?');
      await waitFor(() => expect(screen.getByTestId('close-confirm-cancel')).toHaveFocus());
    });

    describe('the pending model-switch warning', () => {
      async function renderWithAModelSwitchAnswered(status: 'deferred' | 'relaunching') {
        const api = { closeSession: vi.fn(), sendInput: vi.fn(), updateModel: vi.fn().mockResolvedValue({ status }) };
        const fleet = { sessions: signal([{ id: 's1', name: 'Gimli', emoji: '⚔️', model: 'claude-sonnet-5', state: 'generating' }]), approvals: signal([]), managers: signal([]), connected: signal(true) };
        const { fixture } = await render(SessionActionsComponent, {
          bindings: bindingsFor('generating'),
          providers: [{ provide: FleetApiService, useValue: api }, { provide: FleetEventsService, useValue: fleet }],
        });
        await fixture.debugElement.injector.get(PendingSwitchesService).request({ sessionId: 's1', kind: 'model', value: 'opus' });
        return { fixture };
      }

      it('shows when a model switch waits for the turn to end', async () => {
        await renderWithAModelSwitchAnswered('deferred');

        await userEvent.click(screen.getByTestId('session-close'));

        expect(screen.getByTestId('close-confirm-pending-switch')).toHaveTextContent('Closing cancels the pending model switch.');
      });

      it('stays hidden when the model switch relaunches at once', async () => {
        await renderWithAModelSwitchAnswered('relaunching');

        await userEvent.click(screen.getByTestId('session-close'));

        expect(screen.queryByTestId('close-confirm-pending-switch')).toBeNull();
      });

      it('stays hidden when no switch is pending', async () => {
        const api = { closeSession: vi.fn(), sendInput: vi.fn() };
        await render(SessionActionsComponent, {
          bindings: bindingsFor('idle'),
          providers: [{ provide: FleetApiService, useValue: api }],
        });

        await userEvent.click(screen.getByTestId('session-close'));

        expect(screen.queryByTestId('close-confirm-pending-switch')).toBeNull();
      });
    });

    it('sends no request and returns focus to Close when Cancel is clicked', async () => {
      const api = { closeSession: vi.fn(), sendInput: vi.fn() };
      await render(SessionActionsComponent, { bindings: bindingsFor('idle'), providers: [{ provide: FleetApiService, useValue: api }] });
      const closeButton = screen.getByTestId('session-close');

      await userEvent.click(closeButton);
      await userEvent.click(screen.getByTestId('close-confirm-cancel'));

      expect(api.closeSession).not.toHaveBeenCalled();
      expect(screen.queryByTestId('close-confirm-dialog')).toBeNull();
      await waitFor(() => expect(closeButton).toHaveFocus());
    });

    it('states that the process stops while the worktree, branch and transcript are kept for later', async () => {
      const api = { closeSession: vi.fn(), sendInput: vi.fn() };
      await render(SessionActionsComponent, { bindings: bindingsFor('idle'), providers: [{ provide: FleetApiService, useValue: api }] });

      await userEvent.click(screen.getByTestId('session-close'));

      expect(screen.getByTestId('close-confirm-dialog')).toHaveTextContent(
        'The process stops. The worktree, branch and transcript are kept; you can reopen it later with its history.',
      );
    });

    it('traps Tab focus between Cancel and Close session while the dialog is open', async () => {
      const api = { closeSession: vi.fn(), sendInput: vi.fn() };
      await render(SessionActionsComponent, { bindings: bindingsFor('idle'), providers: [{ provide: FleetApiService, useValue: api }] });

      await userEvent.click(screen.getByTestId('session-close'));
      const cancel = screen.getByTestId('close-confirm-cancel');
      const submit = screen.getByTestId('close-confirm-submit');
      await waitFor(() => expect(cancel).toHaveFocus());

      await userEvent.tab();
      expect(submit).toHaveFocus();

      await userEvent.tab();
      expect(cancel).toHaveFocus();

      await userEvent.tab({ shift: true });
      expect(submit).toHaveFocus();
    });

    it('makes the trigger buttons inert while the confirm dialog is open, and interactive again once it closes', async () => {
      const api = { closeSession: vi.fn(), sendInput: vi.fn() };
      await render(SessionActionsComponent, { bindings: bindingsFor('idle'), providers: [{ provide: FleetApiService, useValue: api }] });
      const actions = screen.getByTestId('session-actions');
      expect(actions).not.toHaveAttribute('inert');

      await userEvent.click(screen.getByTestId('session-close'));
      expect(actions).toHaveAttribute('inert');

      await userEvent.click(screen.getByTestId('close-confirm-cancel'));
      expect(actions).not.toHaveAttribute('inert');
    });

    it('closes the confirm dialog automatically when sessionId changes while it is open', async () => {
      const sessionId = signal('s1');
      const api = { closeSession: vi.fn(), sendInput: vi.fn() };
      await render(SessionActionsComponent, {
        bindings: [
          inputBinding('sessionId', sessionId),
          inputBinding('state', () => 'idle' as const),
          inputBinding('stateSince', () => 't1'),
          inputBinding('sessionName', () => 'Gimli · T6'),
        ],
        providers: [{ provide: FleetApiService, useValue: api }],
      });

      await userEvent.click(screen.getByTestId('session-close'));
      expect(screen.getByTestId('close-confirm-dialog')).toBeTruthy();

      sessionId.set('s2');

      await waitFor(() => expect(screen.queryByTestId('close-confirm-dialog')).toBeNull());
      expect(api.closeSession).not.toHaveBeenCalled();
    });

    it('clears a previous close error when sessionId changes', async () => {
      const sessionId = signal('s1');
      const api = { closeSession: vi.fn().mockRejectedValue(new Error('boom')), sendInput: vi.fn() };
      await render(SessionActionsComponent, {
        bindings: [
          inputBinding('sessionId', sessionId),
          inputBinding('state', () => 'idle' as const),
          inputBinding('stateSince', () => 't1'),
          inputBinding('sessionName', () => 'Gimli · T6'),
        ],
        providers: [{ provide: FleetApiService, useValue: api }],
      });

      await userEvent.click(screen.getByTestId('session-close'));
      await userEvent.click(screen.getByTestId('close-confirm-submit'));
      await waitFor(() => expect(screen.getByTestId('session-action-error')).toBeTruthy());

      sessionId.set('s2');

      await waitFor(() => expect(screen.queryByTestId('session-action-error')).toBeNull());
    });


    it('sends no request and returns focus to Close when Escape is pressed', async () => {
      const api = { closeSession: vi.fn(), sendInput: vi.fn() };
      await render(SessionActionsComponent, { bindings: bindingsFor('idle'), providers: [{ provide: FleetApiService, useValue: api }] });
      const closeButton = screen.getByTestId('session-close');

      await userEvent.click(closeButton);
      await userEvent.keyboard('{Escape}');

      expect(api.closeSession).not.toHaveBeenCalled();
      expect(screen.queryByTestId('close-confirm-dialog')).toBeNull();
      await waitFor(() => expect(closeButton).toHaveFocus());
    });

    it('sends one close request when "Close session" is confirmed', async () => {
      const api = { closeSession: vi.fn().mockResolvedValue({}), sendInput: vi.fn() };
      await render(SessionActionsComponent, { bindings: bindingsFor('idle'), providers: [{ provide: FleetApiService, useValue: api }] });

      await userEvent.click(screen.getByTestId('session-close'));
      await userEvent.click(screen.getByTestId('close-confirm-submit'));

      expect(api.closeSession).toHaveBeenCalledWith('s1');
      expect(screen.queryByTestId('close-confirm-dialog')).toBeNull();
    });

    it('sends only one close request when the confirm button is clicked twice before the request resolves', async () => {
      let resolveClose: (value: unknown) => void = () => {};
      const api = { closeSession: vi.fn(() => new Promise((resolve) => { resolveClose = resolve; })), sendInput: vi.fn() };
      await render(SessionActionsComponent, { bindings: bindingsFor('idle'), providers: [{ provide: FleetApiService, useValue: api }] });
      await userEvent.click(screen.getByTestId('session-close'));
      const confirmButton = screen.getByTestId('close-confirm-submit') as HTMLButtonElement;

      fireEvent.click(confirmButton);
      fireEvent.click(confirmButton);
      resolveClose({});
      await waitFor(() => expect(api.closeSession).toHaveBeenCalled());

      expect(api.closeSession).toHaveBeenCalledTimes(1);
    });

    it('shows an inline error when closing fails', async () => {
      const api = { closeSession: vi.fn().mockRejectedValue(new Error('boom')), sendInput: vi.fn() };
      await render(SessionActionsComponent, { bindings: bindingsFor('idle'), providers: [{ provide: FleetApiService, useValue: api }] });

      await userEvent.click(screen.getByTestId('session-close'));
      await userEvent.click(screen.getByTestId('close-confirm-submit'));

      await waitFor(() => expect(screen.getByTestId('session-action-error')).toHaveTextContent(/could not close/i));
    });
  });

  it('tells the user a close of a vanished session cannot be retried', async () => {
    const sessionGone = new ApiError(404, 'DELETE /sessions/s1', 'session_not_found');
    const api = { closeSession: vi.fn().mockRejectedValue(sessionGone), sendInput: vi.fn() };
    await render(SessionActionsComponent, { bindings: bindingsFor('idle'), providers: [{ provide: FleetApiService, useValue: api }] });

    await userEvent.click(screen.getByTestId('session-close'));
    await userEvent.click(screen.getByTestId('close-confirm-submit'));

    await waitFor(() => expect(screen.getByTestId('session-action-error')).toHaveTextContent('That session no longer exists.'));
  });

  describe.each([
    {
      action: 'close',
      buttonTestId: 'session-close',
      startOnCurrentSession: async () => {
        await userEvent.click(screen.getByTestId('session-close'));
        await userEvent.click(screen.getByTestId('close-confirm-submit'));
      },
      apiAnswering: (answer: (sessionId: string) => Promise<unknown>): Api => ({ closeSession: vi.fn(answer), sendInput: vi.fn() }),
      requestOf: (api: Api) => api.closeSession,
      requestArgsFor: (sessionId: string) => [sessionId],
    },
    {
      action: 'interrupt',
      buttonTestId: 'session-interrupt',
      startOnCurrentSession: async () => {
        fireEvent.click(screen.getByTestId('session-interrupt'));
      },
      apiAnswering: (answer: (sessionId: string) => Promise<unknown>): Api => ({ closeSession: vi.fn(), sendInput: vi.fn(answer) }),
      requestOf: (api: Api) => api.sendInput,
      requestArgsFor: (sessionId: string) => [sessionId, '\x1b'],
    },
  ])('switching session while a $action request is pending', ({ buttonTestId, startOnCurrentSession, apiAnswering, requestOf, requestArgsFor }) => {
    async function renderSwitchable(api: Api) {
      const sessionId = signal('s1');
      const { fixture } = await render(SessionActionsComponent, {
        bindings: [
          inputBinding('sessionId', sessionId),
          inputBinding('state', () => 'generating' as const),
          inputBinding('stateSince', () => 't1'),
          inputBinding('sessionName', () => 'Gimli · T6'),
        ],
        providers: [{ provide: FleetApiService, useValue: api }],
      });
      const switchTo = async (id: string) => {
        sessionId.set(id);
        await fixture.whenStable();
      };
      const settle = async () => {
        await new Promise((resolve) => setTimeout(resolve));
        await fixture.whenStable();
      };
      return { fixture, switchTo, settle };
    }

    it('keeps the button disabled after A → B → A while the first request is pending, and sends no second request', async () => {
      const requestOnS1 = deferred();
      const api = apiAnswering(() => requestOnS1.promise);
      const { switchTo } = await renderSwitchable(api);
      await startOnCurrentSession();
      await switchTo('s2');
      await switchTo('s1');

      expect(screen.getByTestId(buttonTestId)).toHaveAttribute('disabled');
      fireEvent.click(screen.getByTestId(buttonTestId));
      expect(requestOf(api)).toHaveBeenCalledTimes(1);
      requestOnS1.resolve({});
    });

    it('enables the button again once the first request settles after A → B → A', async () => {
      const requestOnS1 = deferred();
      const api = apiAnswering(() => requestOnS1.promise);
      const { fixture, switchTo } = await renderSwitchable(api);
      await startOnCurrentSession();
      await switchTo('s2');
      await switchTo('s1');

      requestOnS1.resolve({});
      await settleRequests(fixture);

      expect(screen.getByTestId(buttonTestId)).not.toHaveAttribute('disabled');
    });

    it('shows the failure of the first request on A when it fails after A → B → A', async () => {
      const requestOnS1 = deferred();
      const api = apiAnswering(() => requestOnS1.promise);
      const { fixture, switchTo } = await renderSwitchable(api);
      await startOnCurrentSession();
      await switchTo('s2');
      await switchTo('s1');

      requestOnS1.reject(new Error('boom'));
      await settleRequests(fixture);

      expect(screen.getByTestId('session-action-error')).toBeTruthy();
      expect(screen.getByTestId(buttonTestId)).not.toHaveAttribute('disabled');
    });

    it.each([
      { outcome: 'resolves', settle: (request: ReturnType<typeof deferred>) => request.resolve({}) },
      { outcome: 'rejects', settle: (request: ReturnType<typeof deferred>) => request.reject(new Error('boom')) },
    ])('leaves the new session clean when the previous session request $outcome', async ({ settle }) => {
      const requestOnS1 = deferred();
      const api = apiAnswering(() => requestOnS1.promise);
      const { fixture, switchTo } = await renderSwitchable(api);
      await startOnCurrentSession();
      await switchTo('s2');

      settle(requestOnS1);
      await settleRequests(fixture);

      expect(screen.queryByTestId('session-action-error')).toBeNull();
      expect(screen.getByTestId(buttonTestId)).not.toHaveAttribute('disabled');
    });

    it.each([
      { outcome: 'resolves', settle: (request: ReturnType<typeof deferred>) => request.resolve({}) },
      { outcome: 'rejects', settle: (request: ReturnType<typeof deferred>) => request.reject(new Error('boom')) },
    ])('keeps the new session request busy, with no error, when the previous session request $outcome', async ({ settle }) => {
      const requestOnS1 = deferred();
      const requestOnS2 = deferred();
      const api = apiAnswering((sessionId) => (sessionId === 's1' ? requestOnS1.promise : requestOnS2.promise));
      const { fixture, switchTo } = await renderSwitchable(api);
      await startOnCurrentSession();
      await switchTo('s2');
      await startOnCurrentSession();

      settle(requestOnS1);
      await settleRequests(fixture);

      expect(screen.getByTestId(buttonTestId)).toHaveAttribute('disabled');
      expect(screen.queryByTestId('session-action-error')).toBeNull();
      requestOnS2.resolve({});
    });

    it('re-enables the button on the new session while the previous session request is still pending', async () => {
      const requestOnS1 = deferred();
      const api = apiAnswering(() => requestOnS1.promise);
      const { switchTo } = await renderSwitchable(api);
      await startOnCurrentSession();
      await waitFor(() => expect(screen.getByTestId(buttonTestId)).toHaveAttribute('disabled'));

      await switchTo('s2');

      expect(screen.getByTestId(buttonTestId)).not.toHaveAttribute('disabled');
    });

    it('does not show the previous session error on the new session', async () => {
      const requestOnS1 = deferred();
      const api = apiAnswering(() => requestOnS1.promise);
      const { switchTo, settle } = await renderSwitchable(api);
      await startOnCurrentSession();
      await switchTo('s2');

      requestOnS1.reject(new Error('boom'));
      await requestOnS1.promise.catch(() => {});
      await settle();

      expect(screen.queryByTestId('session-action-error')).toBeNull();
    });

    it('keeps the button disabled on the new session while its own request is pending, when the previous session request settles', async () => {
      const requestOnS1 = deferred();
      const requestOnS2 = deferred();
      const api = apiAnswering((sessionId) => (sessionId === 's1' ? requestOnS1.promise : requestOnS2.promise));
      const { switchTo, settle } = await renderSwitchable(api);
      await startOnCurrentSession();
      await switchTo('s2');
      await startOnCurrentSession();
      await waitFor(() => expect(requestOf(api)).toHaveBeenLastCalledWith(...requestArgsFor('s2')));

      requestOnS1.resolve({});
      await requestOnS1.promise;
      await settle();

      expect(screen.getByTestId(buttonTestId)).toHaveAttribute('disabled');
    });
  });

  describe('Interrupt', () => {
    it('sends the escape key through the REST input route', async () => {
      const api = { closeSession: vi.fn(), sendInput: vi.fn().mockResolvedValue({}) };
      await render(SessionActionsComponent, { bindings: bindingsFor('generating'), providers: [{ provide: FleetApiService, useValue: api }] });

      await userEvent.click(screen.getByTestId('session-interrupt'));

      expect(api.sendInput).toHaveBeenCalledWith('s1', '\x1b');
    });

    it('sends only one interrupt request when clicked twice before the request resolves', async () => {
      let resolveInterrupt: (value: unknown) => void = () => {};
      const api = { closeSession: vi.fn(), sendInput: vi.fn(() => new Promise((resolve) => { resolveInterrupt = resolve; })) };
      await render(SessionActionsComponent, { bindings: bindingsFor('generating'), providers: [{ provide: FleetApiService, useValue: api }] });
      const interruptButton = screen.getByTestId('session-interrupt') as HTMLButtonElement;

      fireEvent.click(interruptButton);
      fireEvent.click(interruptButton);
      resolveInterrupt({});
      await waitFor(() => expect(api.sendInput).toHaveBeenCalled());

      expect(api.sendInput).toHaveBeenCalledTimes(1);
    });

    it('shows an inline error when interrupting fails', async () => {
      const api = { closeSession: vi.fn(), sendInput: vi.fn().mockRejectedValue(new Error('boom')) };
      await render(SessionActionsComponent, { bindings: bindingsFor('generating'), providers: [{ provide: FleetApiService, useValue: api }] });

      await userEvent.click(screen.getByTestId('session-interrupt'));

      await waitFor(() => expect(screen.getByTestId('session-action-error')).toHaveTextContent(/could not interrupt/i));
    });

    it('blames the turn generating when Interrupt was pressed, not one that ends and restarts while sendInput is still pending', async () => {
      const sendInput = deferred();
      const api = { closeSession: vi.fn(), sendInput: vi.fn(() => sendInput.promise) };
      const escapeSent = vi.fn();
      const stateSince = signal('t1');
      await render(SessionActionsComponent, {
        bindings: [
          inputBinding('sessionId', () => 's1'),
          inputBinding('state', () => 'generating' as const),
          inputBinding('stateSince', stateSince),
          inputBinding('sessionName', () => 'Gimli · T6'),
        ],
        providers: [
          { provide: FleetApiService, useValue: api },
          { provide: EarlyEscapeHintService, useValue: { escapeSent, isHinting: () => false } },
        ],
      });

      fireEvent.click(screen.getByTestId('session-interrupt'));
      // The turn stateSince belonged to ends and a new one starts while sendInput is still awaited.
      stateSince.set('t2');
      sendInput.resolve({});
      await new Promise((resolve) => setTimeout(resolve));

      expect(escapeSent).toHaveBeenCalledWith('s1', 't1');
    });
  });

  describe('hostile interleavings', () => {
    type NodeProcessEvents = { on(event: string, listener: () => void): void; off(event: string, listener: () => void): void };

    async function renderControllable(api: Api, initialState: SessionState, extraProviders: Provider[] = []) {
      const sessionId = signal('s1');
      const state = signal<SessionState>(initialState);
      const { fixture } = await render(SessionActionsComponent, {
        bindings: [
          inputBinding('sessionId', sessionId),
          inputBinding('state', state),
          inputBinding('stateSince', () => 't1'),
          inputBinding('sessionName', () => 'Gimli · T6'),
        ],
        providers: [{ provide: FleetApiService, useValue: api }, ...extraProviders],
      });
      const flush = async () => {
        await new Promise((resolve) => setTimeout(resolve));
        await fixture.whenStable();
      };
      return { fixture, sessionId, state, flush };
    }

    async function confirmClose() {
      await userEvent.click(screen.getByTestId('session-close'));
      await userEvent.click(screen.getByTestId('close-confirm-submit'));
    }

    it('ignores a programmatic requestClose while a close is already pending', async () => {
      const close = deferred();
      const api = { closeSession: vi.fn(() => close.promise), sendInput: vi.fn() };
      const { fixture, flush } = await renderControllable(api, 'idle');
      await confirmClose();

      fixture.componentInstance.requestClose();
      await flush();

      expect(screen.queryByTestId('close-confirm-dialog')).toBeNull();
    });

    it('keeps Close disabled when returning to a session whose close is still pending (A→B→A round trip)', async () => {
      const closeOnS1 = deferred();
      const api = { closeSession: vi.fn(() => closeOnS1.promise), sendInput: vi.fn() };
      const { sessionId, flush } = await renderControllable(api, 'idle');
      await confirmClose();

      sessionId.set('s2');
      await flush();
      sessionId.set('s1');
      await flush();

      expect(screen.getByTestId('session-close')).toHaveAttribute('disabled');
    });

    it('dismisses the dialog on Escape after a click on its text moved focus off the buttons', async () => {
      const api = { closeSession: vi.fn(), sendInput: vi.fn() };
      await renderControllable(api, 'idle');
      await userEvent.click(screen.getByTestId('session-close'));
      await userEvent.click(screen.getByText(/The process stops/));
      expect(screen.getByTestId('close-confirm-cancel')).not.toHaveFocus();

      await userEvent.keyboard('{Escape}');

      expect(screen.queryByTestId('close-confirm-dialog')).toBeNull();
    });

    it('dismisses the dialog when the session is closed elsewhere while it is open', async () => {
      const api = { closeSession: vi.fn(), sendInput: vi.fn() };
      const { state, flush } = await renderControllable(api, 'idle');
      await userEvent.click(screen.getByTestId('session-close'));

      state.set('closed');
      await flush();

      expect(screen.queryByTestId('close-confirm-dialog')).toBeNull();
    });

    it('cancels cleanly, without focusing anything, when the Close button has vanished', async () => {
      const api = { closeSession: vi.fn(), sendInput: vi.fn() };
      const handleError = vi.fn();
      const { fixture, state, flush } = await renderControllable(api, 'idle', [{ provide: ErrorHandler, useValue: { handleError } }]);
      await userEvent.click(screen.getByTestId('session-close'));
      state.set('closed');
      await flush();

      fixture.componentInstance.cancelClose();
      await flush();

      expect(screen.queryByTestId('close-confirm-dialog')).toBeNull();
      expect(screen.queryByTestId('session-close')).toBeNull();
      expect(handleError).not.toHaveBeenCalled();
    });

    it('returns focus to Close when a confirmed close fails', async () => {
      const api = { closeSession: vi.fn().mockRejectedValue(new Error('boom')), sendInput: vi.fn() };
      const { flush } = await renderControllable(api, 'idle');
      const closeButton = screen.getByTestId('session-close');

      await confirmClose();
      await flush();

      expect(screen.getByTestId('session-action-error')).toBeTruthy();
      expect(closeButton).toHaveFocus();
    });

    it('does not throw when a confirmed close fails after the view is destroyed', async () => {
      const close = deferred();
      const api = { closeSession: vi.fn(() => close.promise), sendInput: vi.fn() };
      const handleError = vi.fn();
      const unhandledRejection = vi.fn();
      const { process: nodeProcess } = globalThis as unknown as { process: NodeProcessEvents };
      nodeProcess.on('unhandledRejection', unhandledRejection);
      onTestFinished(() => nodeProcess.off('unhandledRejection', unhandledRejection));
      const { fixture } = await renderControllable(api, 'idle', [{ provide: ErrorHandler, useValue: { handleError } }]);
      await confirmClose();
      fixture.destroy();

      close.reject(new Error('boom'));
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(unhandledRejection).not.toHaveBeenCalled();
      expect(handleError).not.toHaveBeenCalled();
    });

    it('does not refocus Close when the failed close belongs to a session the user has left, even if the new session has its own error', async () => {
      const closeOnS1 = deferred();
      const api = {
        closeSession: vi.fn(() => closeOnS1.promise),
        sendInput: vi.fn(() => Promise.reject(new Error('boom'))),
      };
      const { sessionId, flush } = await renderControllable(api, 'generating');
      await confirmClose();
      sessionId.set('s2');
      await flush();
      fireEvent.click(screen.getByTestId('session-interrupt'));
      await flush();
      expect(screen.getByTestId('session-action-error')).toHaveTextContent(/could not interrupt/i);
      expect(screen.getByTestId('session-close')).not.toHaveFocus();

      closeOnS1.reject(new Error('boom'));
      await flush();

      expect(screen.getByTestId('session-close')).not.toHaveFocus();
    });

    it('leaves focus where the user moved it while a confirmed close was pending and then failed', async () => {
      const close = deferred();
      const api = { closeSession: vi.fn(() => close.promise), sendInput: vi.fn() };
      const { flush } = await renderControllable(api, 'idle');
      const composer = document.body.appendChild(document.createElement('textarea'));
      onTestFinished(() => composer.remove());
      await confirmClose();
      composer.focus();

      close.reject(new Error('boom'));
      await flush();

      expect(screen.getByTestId('session-action-error')).toBeTruthy();
      expect(composer).toHaveFocus();
    });

    it('keeps focus on the dialog button when the scrim is pressed', async () => {
      const api = { closeSession: vi.fn(), sendInput: vi.fn() };
      await renderControllable(api, 'idle');
      await userEvent.click(screen.getByTestId('session-close'));
      const cancel = screen.getByTestId('close-confirm-cancel');
      await waitFor(() => expect(cancel).toHaveFocus());

      await userEvent.click(screen.getByTestId('close-confirm-overlay'));

      expect(cancel).toHaveFocus();
      expect(screen.getByTestId('close-confirm-dialog')).toBeTruthy();
    });

    it('keeps Close and Interrupt disabled when an interrupt settles while the close is still pending', async () => {
      const close = deferred();
      const interrupt = deferred();
      const api = { closeSession: vi.fn(() => close.promise), sendInput: vi.fn(() => interrupt.promise) };
      const { flush } = await renderControllable(api, 'generating');
      fireEvent.click(screen.getByTestId('session-interrupt'));
      await confirmClose();
      expect(api.sendInput).toHaveBeenCalledWith('s1', '\x1b');

      interrupt.resolve({});
      await flush();

      expect(screen.getByTestId('session-close')).toHaveAttribute('disabled');
      expect(screen.getByTestId('session-interrupt')).toHaveAttribute('disabled');
    });

    it('disables Interrupt while a close is pending, and enables it again when the close fails', async () => {
      const close = deferred();
      const api = { closeSession: vi.fn(() => close.promise), sendInput: vi.fn() };
      const { fixture } = await renderControllable(api, 'generating');

      await confirmClose();
      expect(screen.getByTestId('session-interrupt')).toHaveAttribute('disabled');

      close.reject(new Error('boom'));
      await settleRequests(fixture);

      expect(screen.getByTestId('session-action-error')).toHaveTextContent(/could not close/i);
      expect(screen.getByTestId('session-interrupt')).not.toHaveAttribute('disabled');
    });

    it('shows the failure of the interrupt that follows a failed close, not the older close failure', async () => {
      const api = { closeSession: vi.fn().mockRejectedValue(new Error('boom')), sendInput: vi.fn().mockRejectedValue(new Error('boom')) };
      const { flush } = await renderControllable(api, 'generating');
      await confirmClose();
      await flush();
      expect(screen.getByTestId('session-action-error')).toHaveTextContent(/could not close/i);

      await userEvent.click(screen.getByTestId('session-interrupt'));
      await flush();

      expect(screen.getByTestId('session-action-error')).toHaveTextContent(/could not interrupt/i);
    });

    it('shows the failure of the close that follows a failed interrupt, not the older interrupt failure', async () => {
      const api = { closeSession: vi.fn().mockRejectedValue(new Error('boom')), sendInput: vi.fn().mockRejectedValue(new Error('boom')) };
      const { flush } = await renderControllable(api, 'generating');
      await userEvent.click(screen.getByTestId('session-interrupt'));
      await flush();
      expect(screen.getByTestId('session-action-error')).toHaveTextContent(/could not interrupt/i);

      await confirmClose();
      await flush();

      expect(screen.getByTestId('session-action-error')).toHaveTextContent(/could not close/i);
    });

    it('sends no interrupt while a close is pending', async () => {
      const close = deferred();
      const api = { closeSession: vi.fn(() => close.promise), sendInput: vi.fn() };
      await renderControllable(api, 'generating');
      await confirmClose();

      await userEvent.click(screen.getByTestId('session-interrupt'));

      expect(api.sendInput).not.toHaveBeenCalled();
    });
  });
});
