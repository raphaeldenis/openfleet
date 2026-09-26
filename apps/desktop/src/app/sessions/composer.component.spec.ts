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

  it('does not send a whitespace-only draft', async () => {
    // Arrange
    const api = { sendMessage: vi.fn() };
    await render(ComposerComponent, {
      bindings: [inputBinding('sessionId', () => 's1')],
      providers: [{ provide: FleetApiService, useValue: api }, { provide: FleetEventsService, useValue: fakeEvents() }],
    });

    // Act
    await userEvent.type(screen.getByTestId('composer-input'), '   ');
    await userEvent.click(screen.getByTestId('composer-send'));

    // Assert
    expect(api.sendMessage).not.toHaveBeenCalled();
  });

  it('reads "Send" and shows the default placeholder when the session is idle', async () => {
    const api = { sendMessage: vi.fn() };
    await render(ComposerComponent, {
      bindings: [inputBinding('sessionId', () => 's1')],
      providers: [{ provide: FleetApiService, useValue: api }, { provide: FleetEventsService, useValue: fakeEvents() }],
    });
    expect(screen.getByTestId('composer-send')).toHaveTextContent('Send');
    expect(screen.getByTestId('composer-input')).toHaveAttribute('placeholder', 'Message this session…');
  });

  it('reads "Queue" and explains the message queues for the next idle turn while the session is busy', async () => {
    const api = { sendMessage: vi.fn() };
    await render(ComposerComponent, {
      bindings: [inputBinding('sessionId', () => 's1'), inputBinding('busy', () => true)],
      providers: [{ provide: FleetApiService, useValue: api }, { provide: FleetEventsService, useValue: fakeEvents() }],
    });
    expect(screen.getByTestId('composer-send')).toHaveTextContent('Queue');
    expect(screen.getByTestId('composer-input')).toHaveAttribute('placeholder', expect.stringMatching(/busy.*next idle turn/i));
  });

  it('does not leak a typed draft into the next session shown in the same composer slot after navigating', async () => {
    // Arrange — Angular's default route reuse strategy keeps this component instance alive across a
    // `session/:sessionId` param change, so only the `sessionId` input updates reactively; nothing
    // destroys and recreates the composer, so a signal-backed binding is the faithful reproduction.
    const sessionId = signal('s1');
    const api = { sendMessage: vi.fn().mockResolvedValue({ status: 'delivered', messageId: 'm1' }) };
    await render(ComposerComponent, {
      bindings: [inputBinding('sessionId', sessionId)],
      providers: [{ provide: FleetApiService, useValue: api }, { provide: FleetEventsService, useValue: fakeEvents() }],
    });
    await userEvent.type(screen.getByTestId('composer-input'), 'leftover draft meant for s1');

    // Act — navigate to a different session
    sessionId.set('s2');

    // Assert
    await waitFor(() => expect(screen.getByTestId('composer-input')).toHaveValue(''));
  });

  it('does not keep the previous session\'s delivery status visible after navigating to a different session', async () => {
    // Arrange
    const sessionId = signal('s1');
    const api = { sendMessage: vi.fn().mockResolvedValue({ status: 'queued', messageId: 'm1' }) };
    await render(ComposerComponent, {
      bindings: [inputBinding('sessionId', sessionId)],
      providers: [{ provide: FleetApiService, useValue: api }, { provide: FleetEventsService, useValue: fakeEvents() }],
    });
    await userEvent.type(screen.getByTestId('composer-input'), 'go');
    await userEvent.click(screen.getByTestId('composer-send'));
    await waitFor(() => expect(screen.getByTestId('composer-status')).toHaveTextContent('queued'));

    // Act — navigate to a different session before this message ever gets delivered
    sessionId.set('s2');

    // Assert
    await waitFor(() => expect(screen.queryByTestId('composer-status')).toBeNull());
  });
});
