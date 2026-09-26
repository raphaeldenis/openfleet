import { render, screen, waitFor, fireEvent } from '@testing-library/angular/zoneless';
import userEvent from '@testing-library/user-event';
import { inputBinding, signal } from '@angular/core';
import { describe, expect, it, vi } from 'vitest';
import { ModelSelectorComponent } from './model-selector.component';
import { FleetApiService } from '../core/fleet-api.service';
import { FleetEventsService } from '../core/fleet-events.service';

function fakeEvents(model?: string) {
  return { sessions: signal([{ id: 's1', name: 'Gimli', emoji: '⚔️', model, state: 'idle' }]), approvals: signal([]), managers: signal([]) };
}

describe('ModelSelectorComponent', () => {
  it('shows the session\'s current model, or "default" when none is set', async () => {
    await render(ModelSelectorComponent, {
      bindings: [inputBinding('sessionId', () => 's1')],
      providers: [{ provide: FleetApiService, useValue: { updateModel: vi.fn() } }, { provide: FleetEventsService, useValue: fakeEvents() }],
    });
    expect(screen.getByTestId('current-model')).toHaveTextContent('default');
  });

  it('applies the selected rung to the session', async () => {
    const api = { updateModel: vi.fn().mockResolvedValue({ status: 'relaunching' }) };
    await render(ModelSelectorComponent, {
      bindings: [inputBinding('sessionId', () => 's1')],
      providers: [{ provide: FleetApiService, useValue: api }, { provide: FleetEventsService, useValue: fakeEvents('claude-sonnet-5') }],
    });
    expect(screen.getByTestId('current-model')).toHaveTextContent('claude-sonnet-5');

    await userEvent.selectOptions(screen.getByTestId('model-select'), 'opus');
    await userEvent.click(screen.getByTestId('apply-model'));

    expect(api.updateModel).toHaveBeenCalledWith('s1', 'opus');
  });

  it('disables Apply while the request is in flight', async () => {
    let resolveUpdate: (value: unknown) => void = () => {};
    const api = { updateModel: vi.fn(() => new Promise((resolve) => { resolveUpdate = resolve; })) };
    await render(ModelSelectorComponent, {
      bindings: [inputBinding('sessionId', () => 's1')],
      providers: [{ provide: FleetApiService, useValue: api }, { provide: FleetEventsService, useValue: fakeEvents('claude-sonnet-5') }],
    });
    const applyButton = screen.getByTestId('apply-model') as HTMLButtonElement;

    await userEvent.click(applyButton);
    await waitFor(() => expect(applyButton.disabled).toBe(true));

    resolveUpdate({ status: 'relaunching' });
    await waitFor(() => expect(applyButton.disabled).toBe(false));
  });

  it('sends only one updateModel call when Apply is double-clicked before the request resolves', async () => {
    // Arrange
    let resolveUpdate: (value: unknown) => void = () => {};
    const api = { updateModel: vi.fn(() => new Promise((resolve) => { resolveUpdate = resolve; })) };
    await render(ModelSelectorComponent, {
      bindings: [inputBinding('sessionId', () => 's1')],
      providers: [{ provide: FleetApiService, useValue: api }, { provide: FleetEventsService, useValue: fakeEvents('claude-sonnet-5') }],
    });
    const applyButton = screen.getByTestId('apply-model') as HTMLButtonElement;

    // Act — two clicks land before Angular flushes the `applying` signal to the DOM's disabled attribute
    fireEvent.click(applyButton);
    fireEvent.click(applyButton);
    resolveUpdate({ status: 'relaunching' });
    await waitFor(() => expect(applyButton.disabled).toBe(false));

    // Assert
    expect(api.updateModel).toHaveBeenCalledTimes(1);
  });

  it('surfaces an error instead of silently discarding a failed model switch', async () => {
    // Arrange
    const api = { updateModel: vi.fn().mockRejectedValue(new Error('session_closed')) };
    await render(ModelSelectorComponent, {
      bindings: [inputBinding('sessionId', () => 's1')],
      providers: [{ provide: FleetApiService, useValue: api }, { provide: FleetEventsService, useValue: fakeEvents('claude-sonnet-5') }],
    });

    // Act
    await userEvent.click(screen.getByTestId('apply-model'));

    // Assert
    await waitFor(() => expect(screen.queryByTestId('model-switch-error')).toBeTruthy());
  });

  it('shows "restarting…" once the switch relaunches the session immediately', async () => {
    const api = { updateModel: vi.fn().mockResolvedValue({ status: 'relaunching' }) };
    await render(ModelSelectorComponent, {
      bindings: [inputBinding('sessionId', () => 's1')],
      providers: [{ provide: FleetApiService, useValue: api }, { provide: FleetEventsService, useValue: fakeEvents('claude-sonnet-5') }],
    });
    await userEvent.click(screen.getByTestId('apply-model'));
    await waitFor(() => expect(screen.getByTestId('model-switch-status')).toHaveTextContent('restarting…'));
  });

  it('shows the deferred switch note when the switch waits for the turn to end', async () => {
    const api = { updateModel: vi.fn().mockResolvedValue({ status: 'deferred' }) };
    await render(ModelSelectorComponent, {
      bindings: [inputBinding('sessionId', () => 's1')],
      providers: [{ provide: FleetApiService, useValue: api }, { provide: FleetEventsService, useValue: fakeEvents('claude-sonnet-5') }],
    });
    await userEvent.click(screen.getByTestId('apply-model'));
    await waitFor(() => expect(screen.getByTestId('model-switch-status')).toHaveTextContent('switch pending: happens when this turn ends'));
  });

  it('does not keep the previous session\'s switch status visible after navigating to a different session', async () => {
    // Arrange — same instance reused across a `session/:sessionId` route param change (no destroy/recreate)
    const sessionId = signal('s1');
    const api = { updateModel: vi.fn().mockResolvedValue({ status: 'relaunching' }) };
    const events = { sessions: signal([{ id: 's1', name: 'Gimli', emoji: '⚔️', model: 'claude-sonnet-5', state: 'idle' }, { id: 's2', name: 'Legolas', emoji: '🏹', model: 'claude-haiku-4-5', state: 'idle' }]), approvals: signal([]), managers: signal([]) };
    await render(ModelSelectorComponent, {
      bindings: [inputBinding('sessionId', sessionId)],
      providers: [{ provide: FleetApiService, useValue: api }, { provide: FleetEventsService, useValue: events }],
    });
    await userEvent.click(screen.getByTestId('apply-model'));
    await waitFor(() => expect(screen.getByTestId('model-switch-status')).toHaveTextContent('restarting…'));

    // Act — navigate to a different session that never triggered a switch
    sessionId.set('s2');

    // Assert
    await waitFor(() => expect(screen.queryByTestId('model-switch-status')).toBeNull());
  });

  it('never types a slash-model command into the UI', async () => {
    await render(ModelSelectorComponent, {
      bindings: [inputBinding('sessionId', () => 's1')],
      providers: [{ provide: FleetApiService, useValue: { updateModel: vi.fn() } }, { provide: FleetEventsService, useValue: fakeEvents('claude-sonnet-5') }],
    });
    expect(document.body.textContent).not.toContain('/model');
  });
});
