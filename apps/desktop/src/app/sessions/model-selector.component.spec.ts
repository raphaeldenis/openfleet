import { render, screen, waitFor, fireEvent } from '@testing-library/angular/zoneless';
import userEvent from '@testing-library/user-event';
import { inputBinding, outputBinding, signal } from '@angular/core';
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

  it('emits pendingModelSwitch(true) when the switch waits for the turn to end', async () => {
    const api = { updateModel: vi.fn().mockResolvedValue({ status: 'deferred' }) };
    const pendingModelSwitch = vi.fn();
    await render(ModelSelectorComponent, {
      bindings: [inputBinding('sessionId', () => 's1'), outputBinding('pendingModelSwitch', pendingModelSwitch)],
      providers: [{ provide: FleetApiService, useValue: api }, { provide: FleetEventsService, useValue: fakeEvents('claude-sonnet-5') }],
    });

    await userEvent.click(screen.getByTestId('apply-model'));

    await waitFor(() => expect(pendingModelSwitch).toHaveBeenLastCalledWith(true));
  });

  it('emits pendingModelSwitch(false) once the switch relaunches immediately instead of waiting', async () => {
    const api = { updateModel: vi.fn().mockResolvedValue({ status: 'relaunching' }) };
    const pendingModelSwitch = vi.fn();
    await render(ModelSelectorComponent, {
      bindings: [inputBinding('sessionId', () => 's1'), outputBinding('pendingModelSwitch', pendingModelSwitch)],
      providers: [{ provide: FleetApiService, useValue: api }, { provide: FleetEventsService, useValue: fakeEvents('claude-sonnet-5') }],
    });

    await userEvent.click(screen.getByTestId('apply-model'));

    await waitFor(() => expect(pendingModelSwitch).toHaveBeenLastCalledWith(false));
  });

  it('never emits a stale pendingModelSwitch for a session already navigated away from', async () => {
    // Arrange
    const sessionId = signal('s1');
    let resolveUpdate: (value: unknown) => void = () => {};
    const api = { updateModel: vi.fn(() => new Promise((resolve) => { resolveUpdate = resolve; })) };
    const pendingModelSwitch = vi.fn();
    const events = { sessions: signal([{ id: 's1', name: 'Gimli', emoji: '⚔️', model: 'claude-sonnet-5', state: 'idle' }, { id: 's2', name: 'Legolas', emoji: '🏹', model: 'claude-haiku-4-5', state: 'idle' }]), approvals: signal([]), managers: signal([]) };
    await render(ModelSelectorComponent, {
      bindings: [inputBinding('sessionId', sessionId), outputBinding('pendingModelSwitch', pendingModelSwitch)],
      providers: [{ provide: FleetApiService, useValue: api }, { provide: FleetEventsService, useValue: events }],
    });
    await userEvent.click(screen.getByTestId('apply-model'));
    // Only the initial mount's own reset (emit(false)) has fired so far — the switch is still in flight.
    expect(pendingModelSwitch).toHaveBeenCalledTimes(1);

    // Act — navigate away before the switch resolves. Wait for a SECOND emit(false): proof the
    // route-reuse reset for the session change itself has actually run (not just the mount's own),
    // which is only possible once the component's sessionId input genuinely reads 's2'.
    sessionId.set('s2');
    await waitFor(() => expect(pendingModelSwitch).toHaveBeenCalledTimes(2));
    expect(pendingModelSwitch).toHaveBeenLastCalledWith(false);
    pendingModelSwitch.mockClear();

    // ...then let s1's stale "deferred" response arrive well after that reset already ran
    resolveUpdate({ status: 'deferred' });
    await waitFor(() => expect(api.updateModel).toHaveBeenCalled());

    // Assert — s2's header never sees a pending-switch warning meant for s1
    expect(pendingModelSwitch).not.toHaveBeenCalled();
  });

  it('clears "restarting…" once session.model_changed reports the model actually changed', async () => {
    const api = { updateModel: vi.fn().mockResolvedValue({ status: 'relaunching' }) };
    const events = { sessions: signal([{ id: 's1', name: 'Gimli', emoji: '⚔️', model: 'claude-sonnet-5', state: 'starting' }]), approvals: signal([]), managers: signal([]) };
    await render(ModelSelectorComponent, {
      bindings: [inputBinding('sessionId', () => 's1')],
      providers: [{ provide: FleetApiService, useValue: api }, { provide: FleetEventsService, useValue: events }],
    });
    await userEvent.click(screen.getByTestId('apply-model'));
    await waitFor(() => expect(screen.getByTestId('model-switch-status')).toHaveTextContent('restarting…'));

    events.sessions.set([{ id: 's1', name: 'Gimli', emoji: '⚔️', model: 'claude-opus-5-5', state: 'starting' }]);

    await waitFor(() => expect(screen.queryByTestId('model-switch-status')).toBeNull());
  });

  it('clears "switch pending" once the session reaches idle', async () => {
    const api = { updateModel: vi.fn().mockResolvedValue({ status: 'deferred' }) };
    const events = { sessions: signal([{ id: 's1', name: 'Gimli', emoji: '⚔️', model: 'claude-sonnet-5', state: 'generating' }]), approvals: signal([]), managers: signal([]) };
    await render(ModelSelectorComponent, {
      bindings: [inputBinding('sessionId', () => 's1')],
      providers: [{ provide: FleetApiService, useValue: api }, { provide: FleetEventsService, useValue: events }],
    });
    await userEvent.click(screen.getByTestId('apply-model'));
    await waitFor(() => expect(screen.getByTestId('model-switch-status')).toHaveTextContent('switch pending'));

    events.sessions.set([{ id: 's1', name: 'Gimli', emoji: '⚔️', model: 'claude-sonnet-5', state: 'idle' }]);

    await waitFor(() => expect(screen.queryByTestId('model-switch-status')).toBeNull());
  });

  it('clears the switch status once the session closes', async () => {
    const api = { updateModel: vi.fn().mockResolvedValue({ status: 'relaunching' }) };
    const events = { sessions: signal([{ id: 's1', name: 'Gimli', emoji: '⚔️', model: 'claude-sonnet-5', state: 'starting' }]), approvals: signal([]), managers: signal([]) };
    await render(ModelSelectorComponent, {
      bindings: [inputBinding('sessionId', () => 's1')],
      providers: [{ provide: FleetApiService, useValue: api }, { provide: FleetEventsService, useValue: events }],
    });
    await userEvent.click(screen.getByTestId('apply-model'));
    await waitFor(() => expect(screen.getByTestId('model-switch-status')).toHaveTextContent('restarting…'));

    events.sessions.set([{ id: 's1', name: 'Gimli', emoji: '⚔️', model: 'claude-sonnet-5', state: 'closed' }]);

    await waitFor(() => expect(screen.queryByTestId('model-switch-status')).toBeNull());
  });

  it('reverts the select to the previously confirmed rung after a failed switch, instead of keeping the rejected choice', async () => {
    // Arrange
    const api = { updateModel: vi.fn().mockRejectedValue(new Error('session_closed')) };
    await render(ModelSelectorComponent, {
      bindings: [inputBinding('sessionId', () => 's1')],
      providers: [{ provide: FleetApiService, useValue: api }, { provide: FleetEventsService, useValue: fakeEvents('claude-opus-5-5') }],
    });
    const select = screen.getByTestId('model-select') as HTMLSelectElement;

    // Act
    await userEvent.selectOptions(select, 'sonnet');
    await userEvent.click(screen.getByTestId('apply-model'));
    await waitFor(() => expect(screen.queryByTestId('model-switch-error')).toBeTruthy());

    // Assert — reverts to the session's actual model, not a hardcoded 'sonnet'
    expect(select.value).toBe('claude-opus-5-5');
  });

  it('initialises the select to the session\'s actual model instead of a hardcoded "sonnet" default', async () => {
    await render(ModelSelectorComponent, {
      bindings: [inputBinding('sessionId', () => 's1')],
      providers: [{ provide: FleetApiService, useValue: { updateModel: vi.fn() } }, { provide: FleetEventsService, useValue: fakeEvents('claude-opus-5-5') }],
    });
    const select = screen.getByTestId('model-select') as HTMLSelectElement;
    expect(select.value).toBe('claude-opus-5-5');
  });

  it('shows a model not among the fixed rungs as an extra option instead of silently mismatching it', async () => {
    await render(ModelSelectorComponent, {
      bindings: [inputBinding('sessionId', () => 's1')],
      providers: [{ provide: FleetApiService, useValue: { updateModel: vi.fn() } }, { provide: FleetEventsService, useValue: fakeEvents('claude-opus-5-5') }],
    });
    const options = screen.getAllByRole('option').map((o) => (o as HTMLOptionElement).value);
    expect(options).toEqual(['haiku', 'sonnet', 'opus', 'fable', 'claude-opus-5-5']);
  });

  it('never types a slash-model command into the UI', async () => {
    await render(ModelSelectorComponent, {
      bindings: [inputBinding('sessionId', () => 's1')],
      providers: [{ provide: FleetApiService, useValue: { updateModel: vi.fn() } }, { provide: FleetEventsService, useValue: fakeEvents('claude-sonnet-5') }],
    });
    expect(document.body.textContent).not.toContain('/model');
  });

  it('gives the rung select an accessible name', async () => {
    await render(ModelSelectorComponent, {
      bindings: [inputBinding('sessionId', () => 's1')],
      providers: [{ provide: FleetApiService, useValue: { updateModel: vi.fn() } }, { provide: FleetEventsService, useValue: fakeEvents('claude-sonnet-5') }],
    });
    expect(screen.getByRole('combobox', { name: 'Model' })).toBeTruthy();
  });
});
