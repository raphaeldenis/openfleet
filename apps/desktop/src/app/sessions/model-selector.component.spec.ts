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

  it('keeps "restarting…" visible when the daemon reports the model change before the relaunch settles', async () => {
    const api = { updateModel: vi.fn().mockResolvedValue({ status: 'relaunching' }) };
    const events = { sessions: signal([{ id: 's1', name: 'Gimli', emoji: '⚔️', model: 'claude-sonnet-5', state: 'idle' }]), approvals: signal([]), managers: signal([]) };
    const { fixture } = await render(ModelSelectorComponent, {
      bindings: [inputBinding('sessionId', () => 's1')],
      providers: [{ provide: FleetApiService, useValue: api }, { provide: FleetEventsService, useValue: events }],
    });
    await userEvent.click(screen.getByTestId('apply-model'));
    await waitFor(() => expect(screen.getByTestId('model-switch-status')).toHaveTextContent('restarting…'));

    // The daemon persists the model and emits session.model_changed right away, before/while the relaunch starts.
    events.sessions.set([{ id: 's1', name: 'Gimli', emoji: '⚔️', model: 'claude-opus-5-5', state: 'idle' }]);
    await fixture.whenStable();
    expect(screen.getByTestId('model-switch-status')).toHaveTextContent('restarting…');

    events.sessions.set([{ id: 's1', name: 'Gimli', emoji: '⚔️', model: 'claude-opus-5-5', state: 'starting' }]);
    await fixture.whenStable();
    expect(screen.getByTestId('model-switch-status')).toHaveTextContent('restarting…');

    events.sessions.set([{ id: 's1', name: 'Gimli', emoji: '⚔️', model: 'claude-opus-5-5', state: 'idle' }]);
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

  describe('a pending switch belongs to its session', () => {
    async function renderSwitchedAwayFromAndBackTo() {
      const api = { updateModel: vi.fn().mockResolvedValue({ status: 'deferred' }) };
      const sessionId = signal('s1');
      const events = {
        sessions: signal([
          { id: 's1', name: 'Gimli', emoji: '⚔️', model: 'claude-sonnet-5', state: 'generating' },
          { id: 's2', name: 'Legolas', emoji: '🏹', model: 'claude-haiku-4-5', state: 'idle' },
        ]),
        approvals: signal([]),
        managers: signal([]),
      };
      const { fixture } = await render(ModelSelectorComponent, {
        bindings: [inputBinding('sessionId', sessionId)],
        providers: [{ provide: FleetApiService, useValue: api }, { provide: FleetEventsService, useValue: events }],
      });
      await userEvent.selectOptions(screen.getByTestId('model-select'), 'opus');
      await userEvent.click(screen.getByTestId('apply-model'));
      await waitFor(() => expect(screen.getByTestId('model-switch-status')).toHaveTextContent('switch pending'));

      const goTo = async (id: string) => {
        sessionId.set(id);
        await fixture.whenStable();
      };
      return { goTo, events };
    }

    it('shows session A\'s deferred switch again, with the requested rung selected, after coming back', async () => {
      const { goTo } = await renderSwitchedAwayFromAndBackTo();
      await goTo('s2');

      await goTo('s1');

      expect(screen.getByTestId('model-switch-status')).toHaveTextContent('switch pending: happens when this turn ends');
      expect((screen.getByTestId('model-select') as HTMLSelectElement).value).toBe('opus');
    });

    it('lifts the restored note once the turn ends', async () => {
      const { goTo, events } = await renderSwitchedAwayFromAndBackTo();
      await goTo('s2');
      await goTo('s1');

      events.sessions.update((all) => all.map((s) => (s.id === 's1' ? { ...s, state: 'idle' } : s)));

      await waitFor(() => expect(screen.queryByTestId('model-switch-status')).toBeNull());
    });

    it('shows no note on return when the turn ended while the user was away', async () => {
      const { goTo, events } = await renderSwitchedAwayFromAndBackTo();
      await goTo('s2');
      events.sessions.update((all) => all.map((s) => (s.id === 's1' ? { ...s, state: 'idle' } : s)));

      await goTo('s1');

      expect(screen.queryByTestId('model-switch-status')).toBeNull();
    });
  });

  describe('resolved model line', () => {
    async function renderWithSession(fields: Record<string, string>) {
      const events = { sessions: signal([{ id: 's1', name: 'Gimli', emoji: '⚔️', model: 'opus', state: 'idle', ...fields }]), approvals: signal([]), managers: signal([]) };
      await render(ModelSelectorComponent, {
        bindings: [inputBinding('sessionId', () => 's1')],
        providers: [{ provide: FleetApiService, useValue: { updateModel: vi.fn() } }, { provide: FleetEventsService, useValue: events }],
      });
    }

    it('user can see the resolved model id, the CLI version and the previous id when the model drifted', async () => {
      await renderWithSession({ resolvedModel: 'claude-opus-5-5', cliVersion: '2.1.284', modelDriftedFrom: 'claude-opus-5-4' });

      expect(screen.getByTestId('resolved-model')).toHaveTextContent('resolved claude-opus-5-5');
      expect(screen.getByTestId('cli-version')).toHaveTextContent('CLI 2.1.284');
      expect(screen.getByTestId('model-drift')).toHaveTextContent('changed from claude-opus-5-4');
    });

    it('user sees no resolved model, CLI version or drift mark for a session that has none', async () => {
      await renderWithSession({});

      expect(screen.queryByTestId('resolved-model')).toBeNull();
      expect(screen.queryByTestId('cli-version')).toBeNull();
      expect(screen.queryByTestId('model-drift')).toBeNull();
    });

    it('user sees the resolved model without a drift mark when the model did not drift', async () => {
      await renderWithSession({ resolvedModel: 'claude-opus-5-5', cliVersion: '2.1.284' });

      expect(screen.getByTestId('resolved-model')).toBeTruthy();
      expect(screen.queryByTestId('model-drift')).toBeNull();
    });
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
