import { render, screen, waitFor, fireEvent } from '@testing-library/angular/zoneless';
import userEvent from '@testing-library/user-event';
import { inputBinding, signal } from '@angular/core';
import { describe, expect, it, vi } from 'vitest';
import type { SessionState } from '@openfleet/shared';
import { SessionActionsComponent } from './session-actions.component';
import { FleetApiService } from '../core/fleet-api.service';

function bindingsFor(state: SessionState, options: { sessionName?: string; modelSwitchPending?: boolean } = {}) {
  const { sessionName = 'Gimli · T6', modelSwitchPending = false } = options;
  return [
    inputBinding('sessionId', () => 's1'),
    inputBinding('state', () => state),
    inputBinding('sessionName', () => sessionName),
    inputBinding('modelSwitchPending', () => modelSwitchPending),
  ];
}

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

    it('shows the pending model-switch warning only when a switch is pending', async () => {
      const api = { closeSession: vi.fn(), sendInput: vi.fn() };
      await render(SessionActionsComponent, {
        bindings: bindingsFor('idle', { modelSwitchPending: true }),
        providers: [{ provide: FleetApiService, useValue: api }],
      });

      await userEvent.click(screen.getByTestId('session-close'));

      expect(screen.getByTestId('close-confirm-pending-switch')).toHaveTextContent('Closing cancels the pending model switch.');
    });

    it('hides the pending model-switch warning when no switch is pending', async () => {
      const api = { closeSession: vi.fn(), sendInput: vi.fn() };
      await render(SessionActionsComponent, {
        bindings: bindingsFor('idle', { modelSwitchPending: false }),
        providers: [{ provide: FleetApiService, useValue: api }],
      });

      await userEvent.click(screen.getByTestId('session-close'));

      expect(screen.queryByTestId('close-confirm-pending-switch')).toBeNull();
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
          inputBinding('sessionName', () => 'Gimli · T6'),
          inputBinding('modelSwitchPending', () => false),
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
          inputBinding('sessionName', () => 'Gimli · T6'),
          inputBinding('modelSwitchPending', () => false),
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
  });
});
