import { fireEvent, render, screen, waitFor } from '@testing-library/angular/zoneless';
import userEvent from '@testing-library/user-event';
import { signal } from '@angular/core';
import { describe, expect, it, vi } from 'vitest';
import { InboxComponent } from './inbox.component';
import { ApiError, FleetApiService } from '../core/fleet-api.service';
import { FleetEventsService } from '../core/fleet-events.service';

function fakeEvents(approval: Record<string, unknown> = {}) {
  return {
    sessions: signal([{ id: 's1', name: 'Gimli', emoji: '⚔️', state: 'waiting_permission' }]),
    approvals: signal([{ id: 'a1', sessionId: 's1', toolName: 'Bash', toolInput: { command: 'rm -rf dist' }, status: 'pending', createdAt: 't', ...approval }]),
  };
}

describe('InboxComponent', () => {
  it('shows a pending approval and sends the decision', async () => {
    const api = { decide: vi.fn().mockResolvedValue({}) };
    await render(InboxComponent, { providers: [{ provide: FleetApiService, useValue: api }, { provide: FleetEventsService, useValue: fakeEvents() }] });
    expect(screen.getByText(/⚔️ Gimli/)).toBeTruthy();
    expect(screen.getByText(/rm -rf dist/)).toBeTruthy();
    expect(screen.getByTestId('inbox-item')).toBeTruthy();
    await userEvent.click(screen.getByTestId('inbox-allow'));
    expect(api.decide).toHaveBeenCalledWith('a1', 'allow');
  });

  it('denies an approval via the deny button', async () => {
    const api = { decide: vi.fn().mockResolvedValue({}) };
    await render(InboxComponent, { providers: [{ provide: FleetApiService, useValue: api }, { provide: FleetEventsService, useValue: fakeEvents() }] });
    await userEvent.click(screen.getByTestId('inbox-deny'));
    expect(api.decide).toHaveBeenCalledWith('a1', 'deny');
  });

  it('disables the buttons while the decision is in flight, and re-enables once it settles', async () => {
    let resolveDecide: (value: unknown) => void = () => {};
    const api = { decide: vi.fn(() => new Promise((resolve) => { resolveDecide = resolve; })) };
    await render(InboxComponent, { providers: [{ provide: FleetApiService, useValue: api }, { provide: FleetEventsService, useValue: fakeEvents() }] });
    const allowButton = screen.getByTestId('inbox-allow') as HTMLButtonElement;

    fireEvent.click(allowButton);
    await waitFor(() => expect(allowButton.disabled).toBe(true));

    resolveDecide({});
    await waitFor(() => expect(allowButton.disabled).toBe(false));
  });

  it('double-clicking Allow sends exactly one request', async () => {
    const api = { decide: vi.fn(() => new Promise(() => {})) };
    await render(InboxComponent, { providers: [{ provide: FleetApiService, useValue: api }, { provide: FleetEventsService, useValue: fakeEvents() }] });
    const allowButton = screen.getByTestId('inbox-allow');

    fireEvent.click(allowButton);
    fireEvent.click(allowButton);

    expect(api.decide).toHaveBeenCalledTimes(1);
  });

  it('shows an inline error when the decision request fails', async () => {
    const api = { decide: vi.fn().mockRejectedValue(new Error('network down')) };
    await render(InboxComponent, { providers: [{ provide: FleetApiService, useValue: api }, { provide: FleetEventsService, useValue: fakeEvents() }] });
    await userEvent.click(screen.getByTestId('inbox-allow'));
    expect(await screen.findByTestId('inbox-error')).toBeTruthy();
  });

  it('removes the item instead of erroring when the decision is already resolved (409)', async () => {
    const api = { decide: vi.fn().mockRejectedValue(new ApiError(409, 'already_resolved')) };
    await render(InboxComponent, { providers: [{ provide: FleetApiService, useValue: api }, { provide: FleetEventsService, useValue: fakeEvents() }] });
    await userEvent.click(screen.getByTestId('inbox-allow'));
    await waitFor(() => expect(screen.queryByTestId('inbox-item')).toBeNull());
  });
});
