import { render, screen, waitFor } from '@testing-library/angular/zoneless';
import userEvent from '@testing-library/user-event';
import { inputBinding, signal } from '@angular/core';
import { describe, expect, it, vi } from 'vitest';
import { ComposerComponent } from './composer.component';
import { FleetApiService } from '../core/fleet-api.service';
import { FleetEventsService } from '../core/fleet-events.service';

function fakeEvents(delivered: string[] = []) {
  return { deliveredMessageIds: signal(new Set(delivered)) };
}

describe('ComposerComponent', () => {
  it('sends the draft body via sendMessage', async () => {
    const api = { sendMessage: vi.fn().mockResolvedValue({ status: 'delivered', messageId: 'm1' }) };
    await render(ComposerComponent, {
      bindings: [inputBinding('sessionId', () => 's1')],
      providers: [{ provide: FleetApiService, useValue: api }, { provide: FleetEventsService, useValue: fakeEvents() }],
    });
    await userEvent.type(screen.getByTestId('composer-input'), 'go');
    await userEvent.click(screen.getByTestId('composer-send'));
    expect(api.sendMessage).toHaveBeenCalledWith('s1', 'go');
  });

  it('shows "sent" once the API confirms immediate delivery', async () => {
    const api = { sendMessage: vi.fn().mockResolvedValue({ status: 'delivered', messageId: 'm1' }) };
    await render(ComposerComponent, {
      bindings: [inputBinding('sessionId', () => 's1')],
      providers: [{ provide: FleetApiService, useValue: api }, { provide: FleetEventsService, useValue: fakeEvents() }],
    });
    await userEvent.type(screen.getByTestId('composer-input'), 'go');
    await userEvent.click(screen.getByTestId('composer-send'));
    await waitFor(() => expect(screen.getByTestId('composer-status')).toHaveTextContent('sent'));
  });

  it('shows "queued" when the message queues behind a running turn, then flips to "sent" once delivered', async () => {
    const api = { sendMessage: vi.fn().mockResolvedValue({ status: 'queued', messageId: 'm1' }) };
    const events = fakeEvents();
    await render(ComposerComponent, {
      bindings: [inputBinding('sessionId', () => 's1')],
      providers: [{ provide: FleetApiService, useValue: api }, { provide: FleetEventsService, useValue: events }],
    });
    await userEvent.type(screen.getByTestId('composer-input'), 'go');
    await userEvent.click(screen.getByTestId('composer-send'));
    await waitFor(() => expect(screen.getByTestId('composer-status')).toHaveTextContent('queued'));

    events.deliveredMessageIds.set(new Set(['m1']));
    await waitFor(() => expect(screen.getByTestId('composer-status')).toHaveTextContent('sent'));
  });

  it('shows the disabled banner instead of the input when disabledReason is set', async () => {
    await render(ComposerComponent, {
      bindings: [inputBinding('sessionId', () => 's1'), inputBinding('disabledReason', () => 'Session closed')],
      providers: [{ provide: FleetApiService, useValue: { sendMessage: vi.fn() } }, { provide: FleetEventsService, useValue: fakeEvents() }],
    });
    expect(screen.getByTestId('banner')).toHaveTextContent('Session closed');
    expect(screen.queryByTestId('composer-input')).toBeNull();
  });
});
