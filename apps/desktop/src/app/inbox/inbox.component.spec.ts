import { render, screen } from '@testing-library/angular/zoneless';
import userEvent from '@testing-library/user-event';
import { signal } from '@angular/core';
import { describe, expect, it, vi } from 'vitest';
import { InboxComponent } from './inbox.component';
import { FleetApiService } from '../core/fleet-api.service';
import { FleetEventsService } from '../core/fleet-events.service';

describe('InboxComponent', () => {
  it('shows a pending approval and sends the decision', async () => {
    const api = { decide: vi.fn().mockResolvedValue({}) };
    const events = {
      sessions: signal([{ id: 's1', name: 'Gimli', emoji: '⚔️', state: 'waiting_permission' }]),
      approvals: signal([{ id: 'a1', sessionId: 's1', toolName: 'Bash', toolInput: { command: 'rm -rf dist' }, status: 'pending', createdAt: 't' }]),
    };
    await render(InboxComponent, { providers: [{ provide: FleetApiService, useValue: api }, { provide: FleetEventsService, useValue: events }] });
    expect(screen.getByText(/⚔️ Gimli/)).toBeTruthy();
    expect(screen.getByText(/rm -rf dist/)).toBeTruthy();
    expect(screen.getByTestId('inbox-item')).toBeTruthy();
    await userEvent.click(screen.getByTestId('inbox-allow'));
    expect(api.decide).toHaveBeenCalledWith('a1', 'allow');
  });

  it('denies an approval via the deny button', async () => {
    const api = { decide: vi.fn().mockResolvedValue({}) };
    const events = {
      sessions: signal([{ id: 's1', name: 'Gimli', emoji: '⚔️', state: 'waiting_permission' }]),
      approvals: signal([{ id: 'a1', sessionId: 's1', toolName: 'Bash', toolInput: {}, status: 'pending', createdAt: 't' }]),
    };
    await render(InboxComponent, { providers: [{ provide: FleetApiService, useValue: api }, { provide: FleetEventsService, useValue: events }] });
    await userEvent.click(screen.getByTestId('inbox-deny'));
    expect(api.decide).toHaveBeenCalledWith('a1', 'deny');
  });
});
