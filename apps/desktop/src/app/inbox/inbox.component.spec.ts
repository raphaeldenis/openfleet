import { fireEvent, render, screen, waitFor, within } from '@testing-library/angular/zoneless';
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
  it('shows a pending gate as a card with the session label, tool name and formatted arguments, and sends the decision', async () => {
    // Arrange
    const api = { decide: vi.fn().mockResolvedValue({}) };
    // Act
    await render(InboxComponent, { providers: [{ provide: FleetApiService, useValue: api }, { provide: FleetEventsService, useValue: fakeEvents() }] });
    const card = screen.getByTestId('inbox-gate-card');
    // Assert
    expect(within(card).getByTestId('inbox-gate-session')).toHaveTextContent('⚔️ Gimli');
    expect(within(card).getByTestId('inbox-gate-tool')).toHaveTextContent('Bash');
    expect(within(card).getByTestId('inbox-gate-args')).toHaveTextContent('"command": "rm -rf dist"');
    await userEvent.click(within(card).getByTestId('inbox-allow'));
    expect(api.decide).toHaveBeenCalledWith('a1', 'allow');
  });

  it('denies a gate via the Deny button', async () => {
    // Arrange
    const api = { decide: vi.fn().mockResolvedValue({}) };
    // Act
    await render(InboxComponent, { providers: [{ provide: FleetApiService, useValue: api }, { provide: FleetEventsService, useValue: fakeEvents() }] });
    await userEvent.click(screen.getByTestId('inbox-deny'));
    // Assert
    expect(api.decide).toHaveBeenCalledWith('a1', 'deny');
  });

  it('disables the buttons while the decision is in flight, and re-enables once it settles', async () => {
    // Arrange
    let resolveDecide: (value: unknown) => void = () => {};
    const api = { decide: vi.fn(() => new Promise((resolve) => { resolveDecide = resolve; })) };
    await render(InboxComponent, { providers: [{ provide: FleetApiService, useValue: api }, { provide: FleetEventsService, useValue: fakeEvents() }] });
    const allowButton = screen.getByTestId('inbox-allow') as HTMLButtonElement;

    // Act
    fireEvent.click(allowButton);
    await waitFor(() => expect(allowButton.disabled).toBe(true));
    resolveDecide({});

    // Assert
    await waitFor(() => expect(allowButton.disabled).toBe(false));
  });

  it('double-clicking Allow sends exactly one request', async () => {
    // Arrange
    const api = { decide: vi.fn(() => new Promise(() => {})) };
    await render(InboxComponent, { providers: [{ provide: FleetApiService, useValue: api }, { provide: FleetEventsService, useValue: fakeEvents() }] });
    const allowButton = screen.getByTestId('inbox-allow');

    // Act
    fireEvent.click(allowButton);
    fireEvent.click(allowButton);

    // Assert
    expect(api.decide).toHaveBeenCalledTimes(1);
  });

  it('shows an inline error when the decision request fails', async () => {
    // Arrange
    const api = { decide: vi.fn().mockRejectedValue(new Error('network down')) };
    await render(InboxComponent, { providers: [{ provide: FleetApiService, useValue: api }, { provide: FleetEventsService, useValue: fakeEvents() }] });

    // Act
    await userEvent.click(screen.getByTestId('inbox-allow'));

    // Assert
    expect(await screen.findByTestId('inbox-error')).toBeTruthy();
  });

  it('removes the item instead of erroring when the decision is already resolved (409)', async () => {
    // Arrange
    const api = { decide: vi.fn().mockRejectedValue(new ApiError(409, 'already_resolved')) };
    await render(InboxComponent, { providers: [{ provide: FleetApiService, useValue: api }, { provide: FleetEventsService, useValue: fakeEvents() }] });

    // Act
    await userEvent.click(screen.getByTestId('inbox-allow'));

    // Assert
    await waitFor(() => expect(screen.queryByTestId('inbox-gate-card')).toBeNull());
  });

  it('renders the gate card with the KindBadge for kind "gate"', async () => {
    // Arrange & Act
    await render(InboxComponent, { providers: [{ provide: FleetApiService, useValue: { decide: vi.fn() } }, { provide: FleetEventsService, useValue: fakeEvents() }] });
    const card = screen.getByTestId('inbox-gate-card');

    // Assert
    expect(within(card).getByTestId('kind-badge')).toHaveTextContent('GATE');
  });

  it('keeps long tool arguments scrollable inside the card instead of growing it', async () => {
    // Arrange
    const longCommand = 'echo '.concat('x'.repeat(2000));
    // Act
    await render(InboxComponent, {
      providers: [
        { provide: FleetApiService, useValue: { decide: vi.fn() } },
        { provide: FleetEventsService, useValue: fakeEvents({ toolInput: { command: longCommand } }) },
      ],
    });

    // Assert
    expect(screen.getByTestId('inbox-gate-args')).toHaveStyle({ overflow: 'auto', whiteSpace: 'pre-wrap' });
  });

  it('shows the All filter enabled, and Unread/Mine/Blocked/Recent disabled with a "needs backend support" tooltip', async () => {
    // Arrange & Act
    await render(InboxComponent, { providers: [{ provide: FleetApiService, useValue: { decide: vi.fn() } }, { provide: FleetEventsService, useValue: fakeEvents() }] });

    // Assert
    expect((screen.getByTestId('inbox-filter-all') as HTMLButtonElement).disabled).toBe(false);
    for (const key of ['unread', 'mine', 'blocked', 'recent']) {
      const button = screen.getByTestId(`inbox-filter-${key}`) as HTMLButtonElement;
      expect(button.disabled).toBe(true);
      expect(button.title).toMatch(/needs backend support/i);
    }
  });

  it('switching to the Questions tab shows the "coming" notice and renders zero fake items', async () => {
    // Arrange
    await render(InboxComponent, { providers: [{ provide: FleetApiService, useValue: { decide: vi.fn() } }, { provide: FleetEventsService, useValue: fakeEvents() }] });

    // Act
    await userEvent.click(screen.getByTestId('inbox-tab-questions'));

    // Assert
    expect(screen.getByTestId('inbox-questions-coming')).toBeTruthy();
    expect(screen.queryByTestId('inbox-gate-card')).toBeNull();
  });

  it('switching to the Proposals tab shows the "coming" notice and renders zero fake items', async () => {
    // Arrange
    await render(InboxComponent, { providers: [{ provide: FleetApiService, useValue: { decide: vi.fn() } }, { provide: FleetEventsService, useValue: fakeEvents() }] });

    // Act
    await userEvent.click(screen.getByTestId('inbox-tab-proposals'));

    // Assert
    expect(screen.getByTestId('inbox-proposals-coming')).toBeTruthy();
    expect(screen.queryByTestId('inbox-gate-card')).toBeNull();
  });
});
