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

  it('keeps the draft and shows an inline error when sending fails, instead of clearing it optimistically', async () => {
    // Arrange
    const api = { sendMessage: vi.fn().mockRejectedValue(new Error('boom')) };
    await render(ComposerComponent, {
      bindings: [inputBinding('sessionId', () => 's1')],
      providers: [{ provide: FleetApiService, useValue: api }, { provide: FleetEventsService, useValue: fakeEvents() }],
    });

    // Act
    await userEvent.type(screen.getByTestId('composer-input'), 'go');
    await userEvent.click(screen.getByTestId('composer-send'));

    // Assert
    await waitFor(() => expect(screen.getByTestId('composer-send-error')).toHaveTextContent(/could not send.*message is kept/i));
    expect(screen.getByTestId('composer-input')).toHaveValue('go');
  });

  it('drops a send response for a session the composer has since navigated away from', async () => {
    // Arrange
    const sessionId = signal('s1');
    let resolveSend: (value: unknown) => void = () => {};
    const api = { sendMessage: vi.fn(() => new Promise((resolve) => { resolveSend = resolve; })) };
    await render(ComposerComponent, {
      bindings: [inputBinding('sessionId', sessionId)],
      providers: [{ provide: FleetApiService, useValue: api }, { provide: FleetEventsService, useValue: fakeEvents() }],
    });
    await userEvent.type(screen.getByTestId('composer-input'), 'leftover for s1');
    await userEvent.click(screen.getByTestId('composer-send'));

    // Act — navigate away before the send resolves. Wait for proof the route-reuse reset for s2
    // has actually run (s1's leftover draft is cleared), meaning the component's sessionId input
    // genuinely reads 's2' by the time the stale response below is delivered.
    sessionId.set('s2');
    await waitFor(() => expect(screen.getByTestId('composer-input')).toHaveValue(''));

    resolveSend({ status: 'delivered', messageId: 'm1' });
    await waitFor(() => expect(api.sendMessage).toHaveBeenCalledTimes(1));
    // Give the resumed send() continuation a real tick to run and (if unguarded) reach the DOM.
    await new Promise((resolve) => setTimeout(resolve, 20));

    // Assert — s2's composer shows no delivery status meant for s1
    expect(screen.queryByTestId('composer-status')).toBeNull();
  });

  describe('while a send is pending', () => {
    async function renderWithPendingSend() {
      const user = userEvent.setup({ delay: null });
      let resolveSend: (value: unknown) => void = () => {};
      let rejectSend: (reason: unknown) => void = () => {};
      const api = { sendMessage: vi.fn(() => new Promise((resolve, reject) => { resolveSend = resolve; rejectSend = reject; })) };
      const { fixture } = await render(ComposerComponent, {
        bindings: [inputBinding('sessionId', () => 's1')],
        providers: [{ provide: FleetApiService, useValue: api }, { provide: FleetEventsService, useValue: fakeEvents() }],
      });
      return { user, api, fixture, resolveSend: (value: unknown) => resolveSend(value), rejectSend: (reason: unknown) => rejectSend(reason) };
    }

    it('user who clicks Send twice before the response arrives sends the message once', async () => {
      const { user, api, fixture } = await renderWithPendingSend();
      await user.type(screen.getByTestId('composer-input'), 'approve staging');

      await user.click(screen.getByTestId('composer-send'));
      await user.click(screen.getByTestId('composer-send'));
      await fixture.whenStable();

      expect(api.sendMessage).toHaveBeenCalledTimes(1);
      expect(screen.getByTestId('composer-send')).toBeDisabled();
    });

    it('user can send again once a failed send is over', async () => {
      const { user, api, rejectSend } = await renderWithPendingSend();
      await user.type(screen.getByTestId('composer-input'), 'approve staging');
      await user.click(screen.getByTestId('composer-send'));

      rejectSend(new Error('boom'));

      await waitFor(() => expect(screen.getByTestId('composer-send')).toBeEnabled());
      await user.click(screen.getByTestId('composer-send'));
      expect(api.sendMessage).toHaveBeenCalledTimes(2);
    });

    it('user keeps the text typed after Send while the response arrives, and loses only what was sent', async () => {
      const { user, fixture, resolveSend } = await renderWithPendingSend();
      await user.type(screen.getByTestId('composer-input'), 'first part');
      await user.click(screen.getByTestId('composer-send'));
      await user.type(screen.getByTestId('composer-input'), ' and a second thought');
      await fixture.whenStable();

      resolveSend({ status: 'delivered', messageId: 'm1' });

      await waitFor(() => expect(screen.getByTestId('composer-status')).toHaveTextContent('sent'));
      expect(screen.getByTestId('composer-input')).toHaveValue('and a second thought');
    });

    it('user who replaces the text after Send keeps the new text when the response arrives', async () => {
      const { user, fixture, resolveSend } = await renderWithPendingSend();
      await user.type(screen.getByTestId('composer-input'), 'A');
      await user.click(screen.getByTestId('composer-send'));
      await user.clear(screen.getByTestId('composer-input'));
      await user.type(screen.getByTestId('composer-input'), 'B');
      await fixture.whenStable();

      resolveSend({ status: 'delivered', messageId: 'm1' });

      await waitFor(() => expect(screen.getByTestId('composer-status')).toHaveTextContent('sent'));
      expect(screen.getByTestId('composer-input')).toHaveValue('B');
    });
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
