import { render, screen, waitFor } from '@testing-library/angular/zoneless';
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

  it('never types a slash-model command into the UI', async () => {
    await render(ModelSelectorComponent, {
      bindings: [inputBinding('sessionId', () => 's1')],
      providers: [{ provide: FleetApiService, useValue: { updateModel: vi.fn() } }, { provide: FleetEventsService, useValue: fakeEvents('claude-sonnet-5') }],
    });
    expect(document.body.textContent).not.toContain('/model');
  });
});
