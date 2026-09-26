import { render, screen, waitFor, fireEvent } from '@testing-library/angular/zoneless';
import userEvent from '@testing-library/user-event';
import { inputBinding } from '@angular/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionState } from '@openfleet/shared';
import { SessionActionsComponent } from './session-actions.component';
import { FleetApiService } from '../core/fleet-api.service';

function bindingsFor(state: SessionState) {
  return [inputBinding('sessionId', () => 's1'), inputBinding('state', () => state)];
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
    beforeEach(() => vi.spyOn(window, 'confirm'));
    afterEach(() => vi.restoreAllMocks());

    it('asks for confirmation, then closes the session', async () => {
      vi.spyOn(window, 'confirm').mockReturnValue(true);
      const api = { closeSession: vi.fn().mockResolvedValue({}), sendInput: vi.fn() };
      await render(SessionActionsComponent, { bindings: bindingsFor('idle'), providers: [{ provide: FleetApiService, useValue: api }] });

      await userEvent.click(screen.getByTestId('session-close'));

      expect(window.confirm).toHaveBeenCalled();
      expect(api.closeSession).toHaveBeenCalledWith('s1');
    });

    it('does not close when the confirmation is declined', async () => {
      vi.spyOn(window, 'confirm').mockReturnValue(false);
      const api = { closeSession: vi.fn(), sendInput: vi.fn() };
      await render(SessionActionsComponent, { bindings: bindingsFor('idle'), providers: [{ provide: FleetApiService, useValue: api }] });

      await userEvent.click(screen.getByTestId('session-close'));

      expect(api.closeSession).not.toHaveBeenCalled();
    });

    it('sends only one close request when clicked twice before the request resolves', async () => {
      vi.spyOn(window, 'confirm').mockReturnValue(true);
      let resolveClose: (value: unknown) => void = () => {};
      const api = { closeSession: vi.fn(() => new Promise((resolve) => { resolveClose = resolve; })), sendInput: vi.fn() };
      await render(SessionActionsComponent, { bindings: bindingsFor('idle'), providers: [{ provide: FleetApiService, useValue: api }] });
      const closeButton = screen.getByTestId('session-close') as HTMLButtonElement;

      fireEvent.click(closeButton);
      fireEvent.click(closeButton);
      resolveClose({});
      await waitFor(() => expect(api.closeSession).toHaveBeenCalled());

      expect(api.closeSession).toHaveBeenCalledTimes(1);
    });

    it('shows an inline error when closing fails', async () => {
      vi.spyOn(window, 'confirm').mockReturnValue(true);
      const api = { closeSession: vi.fn().mockRejectedValue(new Error('boom')), sendInput: vi.fn() };
      await render(SessionActionsComponent, { bindings: bindingsFor('idle'), providers: [{ provide: FleetApiService, useValue: api }] });

      await userEvent.click(screen.getByTestId('session-close'));

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
