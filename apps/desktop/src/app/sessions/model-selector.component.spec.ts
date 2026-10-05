import { render, screen, waitFor, fireEvent, within } from '@testing-library/angular/zoneless';
import userEvent from '@testing-library/user-event';
import { inputBinding, signal } from '@angular/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ModelSelectorComponent } from './model-selector.component';
import { FleetApiService } from '../core/fleet-api.service';
import { FleetEventsService } from '../core/fleet-events.service';

function fakeEvents(model?: string) {
  return { sessions: signal([{ id: 's1', name: 'Gimli', emoji: '⚔️', model, state: 'idle' }]), approvals: signal([]), managers: signal([]) };
}

const modelButton = () => screen.getByRole('button', { name: /^Model:/ });
const openRungs = () => userEvent.click(modelButton());
const rungNamed = (name: string) => screen.findByRole('option', { name });
const rungList = () => screen.queryByRole('listbox', { name: 'Model' });

async function pickRung(rung: string) {
  await openRungs();
  await userEvent.click(await rungNamed(rung));
}

describe('ModelSelectorComponent', () => {
  describe('exact model id', () => {
    async function renderPicker({ model = 'sonnet', state = 'idle', updateModel = vi.fn().mockResolvedValue({ status: 'relaunching' }) } = {}) {
      const sessionId = signal('s1');
      const events = { sessions: signal([{ id: 's1', name: 'Gimli', emoji: '⚔️', model, state }, { id: 's2', name: 'Legolas', emoji: '🏹', model: 'haiku', state: 'idle' }]), approvals: signal([]), managers: signal([]) };
      const api = { models: vi.fn().mockResolvedValue({ sonnet: 'mapped-sonnet' }), updateModel, saveModels: vi.fn() };
      const rendered = await render(ModelSelectorComponent, {
        bindings: [inputBinding('sessionId', sessionId)],
        providers: [{ provide: FleetApiService, useValue: api }, { provide: FleetEventsService, useValue: events }],
      });
      await openRungs();
      return { ...rendered, api, sessionId };
    }

    const exactIdField = () => screen.getByRole('textbox', { name: 'Exact model id' });
    const useIdButton = () => screen.getByRole('button', { name: 'Use id' });

    it('uses a trimmed exact id on Enter, closes the popover and announces the restart', async () => {
      const { api } = await renderPicker();

      await userEvent.type(exactIdField(), '  custom-model-v2  {Enter}');

      expect(api.updateModel).toHaveBeenCalledExactlyOnceWith('s1', 'custom-model-v2');
      expect(api.saveModels).not.toHaveBeenCalled();
      expect(rungList()).toBeNull();
      expect(modelButton()).toHaveFocus();
      expect(await screen.findByTestId('model-switch-status')).toHaveTextContent('restarting…');
    });

    it.each(['', '   ', '-flag', 'two words', 'x'.repeat(101), 'id\u202e'])('refuses invalid id %j even when Enter is dispatched', async (id) => {
      const { api } = await renderPicker();

      fireEvent.input(exactIdField(), { target: { value: id } });
      await waitFor(() => expect(useIdButton()).toBeDisabled());
      fireEvent.keyDown(exactIdField(), { key: 'Enter' });

      expect(api.updateModel).not.toHaveBeenCalled();
      expect(rungList()).not.toBeNull();
    });

    it('closes without sending a switch for the exact id already in force', async () => {
      const { api } = await renderPicker({ model: 'custom-model-v2' });
      await userEvent.type(exactIdField(), 'custom-model-v2');

      await userEvent.click(useIdButton());

      expect(api.updateModel).not.toHaveBeenCalled();
      expect(rungList()).toBeNull();
    });

    it('sends one exact-id switch on a double click and displays a deferred switch', async () => {
      let resolveUpdate!: (value: { status: 'deferred' }) => void;
      const response = new Promise<{ status: 'deferred' }>((resolve) => { resolveUpdate = resolve; });
      const { api } = await renderPicker({ state: 'generating', updateModel: vi.fn().mockReturnValue(response) });
      await userEvent.type(exactIdField(), 'custom-model-v2');
      const button = useIdButton();

      fireEvent.click(button);
      fireEvent.click(button);
      resolveUpdate({ status: 'deferred' });
      await response;

      expect(api.updateModel).toHaveBeenCalledExactlyOnceWith('s1', 'custom-model-v2');
      expect(await screen.findByTestId('model-switch-status')).toHaveTextContent('switch pending → custom-model-v2');
    });

    it('keeps the active model selected after a refused exact-id switch', async () => {
      await renderPicker({ model: 'current-id', updateModel: vi.fn().mockRejectedValue(new Error('refused')) });
      await userEvent.type(exactIdField(), 'refused-id');

      await userEvent.click(useIdButton());

      expect(await screen.findByTestId('model-switch-error')).toBeVisible();
      await openRungs();
      expect(await rungNamed('current-id')).toHaveAttribute('aria-selected', 'true');
      expect(screen.queryByRole('option', { name: 'refused-id' })).toBeNull();
    });

    it('clears the exact-id draft on navigation and switches the displayed session', async () => {
      const { api, sessionId, fixture } = await renderPicker();
      await userEvent.type(exactIdField(), 'old-draft-id');

      sessionId.set('s2');
      await fixture.whenStable();
      await screen.findByRole('button', { name: 'Model: haiku' });

      expect(rungList()).toBeNull();
      await openRungs();
      expect(exactIdField()).toHaveValue('');
      await userEvent.type(exactIdField(), 'new-session-id');
      await userEvent.click(useIdButton());
      expect(api.updateModel).toHaveBeenCalledExactlyOnceWith('s2', 'new-session-id');
    });
  });

  it('shows the current daemon mapping for each rung and keeps the exact active id selected', async () => {
    const models = { haiku: 'haiku-live-id', sonnet: 'sonnet-live-id', opus: 'opus-live-id', fable: 'fable-live-id' };
    await render(ModelSelectorComponent, {
      bindings: [inputBinding('sessionId', () => 's1')],
      providers: [{ provide: FleetApiService, useValue: { models: vi.fn().mockResolvedValue(models), updateModel: vi.fn() } }, { provide: FleetEventsService, useValue: fakeEvents('custom-active-id') }],
    });

    await openRungs();

    for (const [rung, id] of Object.entries(models)) {
      const option = await rungNamed(rung);
      expect(await within(option).findByText(id)).toBeVisible();
      expect(option).toHaveAccessibleDescription(id);
      expect(option).toHaveAttribute('aria-selected', 'false');
    }
    expect(await rungNamed('custom-active-id')).toHaveAttribute('aria-selected', 'true');
  });

  it('refetches the mapping when reopening after Settings changes', async () => {
    const api = { models: vi.fn().mockResolvedValueOnce({ sonnet: 'first-id' }).mockResolvedValue({ sonnet: 'new-id' }), updateModel: vi.fn() };
    await render(ModelSelectorComponent, {
      bindings: [inputBinding('sessionId', () => 's1')],
      providers: [{ provide: FleetApiService, useValue: api }, { provide: FleetEventsService, useValue: fakeEvents('sonnet') }],
    });
    await openRungs();
    expect(await screen.findByText('first-id')).toBeVisible();
    await userEvent.keyboard('{Escape}');

    await openRungs();

    expect(await screen.findByText('new-id')).toBeVisible();
    expect(screen.queryByText('first-id')).toBeNull();
  });

  it('keeps rung selection available when the mapping fails and retries the mapping', async () => {
    const api = { models: vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue({ sonnet: 'recovered-id' }), updateModel: vi.fn() };
    await render(ModelSelectorComponent, {
      bindings: [inputBinding('sessionId', () => 's1')],
      providers: [{ provide: FleetApiService, useValue: api }, { provide: FleetEventsService, useValue: fakeEvents('sonnet') }],
    });

    await openRungs();

    expect(await screen.findByRole('alert')).toHaveTextContent('Model ids could not be loaded');
    expect(await rungNamed('sonnet')).toHaveAttribute('aria-selected', 'true');
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('recovered-id')).toBeVisible();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it.each(['success', 'failure'])('ignores an older mapping %s after reopening', async (outcome) => {
    let resolveOld!: (value: Record<string, string>) => void;
    let rejectOld!: (reason: Error) => void;
    const oldRequest = new Promise<Record<string, string>>((resolve, reject) => { resolveOld = resolve; rejectOld = reject; });
    const api = { models: vi.fn().mockReturnValueOnce(oldRequest).mockResolvedValue({ sonnet: 'current-id' }), updateModel: vi.fn() };
    const { fixture } = await render(ModelSelectorComponent, {
      bindings: [inputBinding('sessionId', () => 's1')],
      providers: [{ provide: FleetApiService, useValue: api }, { provide: FleetEventsService, useValue: fakeEvents('sonnet') }],
    });
    await openRungs();
    expect(await screen.findByText('Loading model ids…')).toBeVisible();
    await userEvent.keyboard('{Escape}');
    await openRungs();
    expect(await screen.findByText('current-id')).toBeVisible();

    if (outcome === 'success') resolveOld({ sonnet: 'obsolete-id' });
    else rejectOld(new Error('old failure'));
    await oldRequest.catch(() => undefined);
    await fixture.whenStable();

    expect(screen.getByText('current-id')).toBeVisible();
    expect(screen.queryByText('obsolete-id')).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('keeps the new mapping loading until its own response arrives', async () => {
    let resolveOld!: (value: Record<string, string>) => void;
    let resolveCurrent!: (value: Record<string, string>) => void;
    const oldRequest = new Promise<Record<string, string>>((resolve) => { resolveOld = resolve; });
    const currentRequest = new Promise<Record<string, string>>((resolve) => { resolveCurrent = resolve; });
    const api = { models: vi.fn().mockReturnValueOnce(oldRequest).mockReturnValueOnce(currentRequest), updateModel: vi.fn() };
    const { fixture } = await render(ModelSelectorComponent, {
      bindings: [inputBinding('sessionId', () => 's1')],
      providers: [{ provide: FleetApiService, useValue: api }, { provide: FleetEventsService, useValue: fakeEvents('sonnet') }],
    });
    await openRungs();
    expect(await screen.findByText('Loading model ids…')).toBeVisible();
    await userEvent.keyboard('{Escape}');
    await openRungs();
    expect(await screen.findByText('Loading model ids…')).toBeVisible();

    resolveOld({ sonnet: 'obsolete-id' });
    await oldRequest;
    await fixture.whenStable();

    expect(screen.getByText('Loading model ids…')).toBeVisible();
    expect(screen.queryByText('obsolete-id')).toBeNull();
    resolveCurrent({ sonnet: 'current-id' });
    expect(await screen.findByText('current-id')).toBeVisible();
    expect(screen.queryByText('Loading model ids…')).toBeNull();
  });

  it('shows the session\'s current model, or "default" when none is set', async () => {
    await render(ModelSelectorComponent, {
      bindings: [inputBinding('sessionId', () => 's1')],
      providers: [{ provide: FleetApiService, useValue: { updateModel: vi.fn() } }, { provide: FleetEventsService, useValue: fakeEvents() }],
    });
    expect(screen.getByTestId('current-model')).toHaveTextContent('default');
  });

  describe('the rung popover', () => {
    async function renderOn(model: string | undefined, api: Record<string, unknown> = { updateModel: vi.fn() }) {
      return render(ModelSelectorComponent, {
        bindings: [inputBinding('sessionId', () => 's1')],
        providers: [{ provide: FleetApiService, useValue: api }, { provide: FleetEventsService, useValue: fakeEvents(model) }],
      });
    }

    it('starts closed and opens on the model button, which announces the popup and its state', async () => {
      await renderOn('sonnet');
      expect(rungList()).toBeNull();
      expect(modelButton()).toHaveAttribute('aria-haspopup', 'listbox');
      expect(modelButton()).toHaveAttribute('aria-expanded', 'false');

      await openRungs();

      expect(rungList()).toBeTruthy();
      expect(modelButton()).toHaveAttribute('aria-expanded', 'true');
    });

    it('lists the four rungs and marks the session\'s own as selected', async () => {
      await renderOn('sonnet');

      await openRungs();

      const rungs = (await screen.findAllByRole('option')).map((option) => option.textContent?.replace('✓', '').trim());
      expect(rungs).toEqual(['haiku', 'sonnet', 'opus', 'fable']);
      expect(await rungNamed('sonnet')).toHaveAttribute('aria-selected', 'true');
      expect(await rungNamed('opus')).toHaveAttribute('aria-selected', 'false');
    });

    it('lists a model that is not one of the fixed rungs as an extra row, selected, instead of silently mismatching it', async () => {
      await renderOn('claude-opus-5-5');

      await openRungs();

      const rungs = (await screen.findAllByRole('option')).map((option) => option.textContent?.replace('✓', '').trim());
      expect(rungs).toEqual(['haiku', 'sonnet', 'opus', 'fable', 'claude-opus-5-5']);
      expect(await rungNamed('claude-opus-5-5')).toHaveAttribute('aria-selected', 'true');
    });

    it('explains that a switch restarts the session on the new model with its history', async () => {
      await renderOn('sonnet');

      await openRungs();

      expect(screen.getByText(/Switching restarts this session on the new model with its history/)).toBeTruthy();
    });

    it('switches the session to the chosen rung, closes the popover and gives focus back to the model button', async () => {
      const api = { updateModel: vi.fn().mockResolvedValue({ status: 'relaunching' }) };
      await renderOn('claude-sonnet-5', api);

      await pickRung('opus');

      expect(api.updateModel).toHaveBeenCalledWith('s1', 'opus');
      expect(rungList()).toBeNull();
      expect(modelButton()).toHaveFocus();
    });

    it('sends nothing when the rung already in force is chosen, and just closes', async () => {
      const api = { updateModel: vi.fn().mockResolvedValue({ status: 'relaunching' }) };
      await renderOn('sonnet', api);

      await pickRung('sonnet');

      expect(api.updateModel).not.toHaveBeenCalled();
      expect(rungList()).toBeNull();
    });

    it('closes on Escape and gives focus back to the model button', async () => {
      await renderOn('sonnet');
      await openRungs();
      await waitFor(() => expect(screen.getByRole('option', { name: 'sonnet' })).toHaveFocus());

      await userEvent.keyboard('{Escape}');

      expect(rungList()).toBeNull();
      expect(modelButton()).toHaveFocus();
    });

    it('closes on a click outside, without taking focus back', async () => {
      await renderOn('sonnet');
      await openRungs();
      await rungNamed('sonnet');

      await userEvent.click(document.body);

      expect(rungList()).toBeNull();
      expect(modelButton()).not.toHaveFocus();
    });

    it('closes when the model button is pressed again', async () => {
      await renderOn('sonnet');
      await openRungs();
      await rungNamed('sonnet');

      await openRungs();

      expect(rungList()).toBeNull();
    });

    it('puts focus on the selected rung when it opens, and moves it with the arrow keys, wrapping at both ends', async () => {
      await renderOn('sonnet');
      await openRungs();
      await waitFor(() => expect(screen.getByRole('option', { name: 'sonnet' })).toHaveFocus());

      await userEvent.keyboard('{ArrowDown}');
      expect(screen.getByRole('option', { name: 'opus' })).toHaveFocus();

      await userEvent.keyboard('{End}');
      expect(screen.getByRole('option', { name: 'fable' })).toHaveFocus();

      await userEvent.keyboard('{ArrowDown}');
      expect(screen.getByRole('option', { name: 'haiku' })).toHaveFocus();

      await userEvent.keyboard('{ArrowUp}');
      expect(screen.getByRole('option', { name: 'fable' })).toHaveFocus();

      await userEvent.keyboard('{Home}');
      expect(screen.getByRole('option', { name: 'haiku' })).toHaveFocus();
    });

    it('lets the keyboard choose a rung with Enter', async () => {
      const api = { updateModel: vi.fn().mockResolvedValue({ status: 'relaunching' }) };
      await renderOn('sonnet', api);
      await openRungs();
      await waitFor(() => expect(screen.getByRole('option', { name: 'sonnet' })).toHaveFocus());

      await userEvent.keyboard('{ArrowDown}{Enter}');

      expect(api.updateModel).toHaveBeenCalledWith('s1', 'opus');
    });

    it('keeps the model button inert while the request is in flight, then frees it', async () => {
      let resolveUpdate: (value: unknown) => void = () => {};
      const api = { updateModel: vi.fn(() => new Promise((resolve) => { resolveUpdate = resolve; })) };
      await renderOn('claude-sonnet-5', api);

      await pickRung('opus');
      await waitFor(() => expect(modelButton()).toHaveAttribute('aria-disabled', 'true'));
      await userEvent.click(modelButton());
      expect(rungList()).toBeNull();

      resolveUpdate({ status: 'relaunching' });
      await waitFor(() => expect(modelButton()).not.toHaveAttribute('aria-disabled'));
    });

    it('sends only one updateModel call when a rung is double-clicked before the request resolves', async () => {
      // Arrange
      let resolveUpdate: (value: unknown) => void = () => {};
      const api = { updateModel: vi.fn(() => new Promise((resolve) => { resolveUpdate = resolve; })) };
      await renderOn('claude-sonnet-5', api);
      await openRungs();
      const opus = await rungNamed('opus');

      // Act — two clicks land before Angular flushes the busy state to the DOM
      fireEvent.click(opus);
      fireEvent.click(opus);
      resolveUpdate({ status: 'relaunching' });
      await waitFor(() => expect(modelButton()).not.toHaveAttribute('aria-disabled'));

      // Assert
      expect(api.updateModel).toHaveBeenCalledTimes(1);
    });

    it('surfaces an error instead of silently discarding a failed model switch', async () => {
      const api = { updateModel: vi.fn().mockRejectedValue(new Error('session_closed')) };
      await renderOn('claude-sonnet-5', api);

      await pickRung('opus');

      await waitFor(() => expect(screen.queryByTestId('model-switch-error')).toBeTruthy());
    });

    it('marks the session\'s actual model as selected again after a failed switch, instead of the rejected choice', async () => {
      // Arrange
      const api = { updateModel: vi.fn().mockRejectedValue(new Error('session_closed')) };
      await renderOn('claude-opus-5-5', api);

      // Act
      await pickRung('sonnet');
      await waitFor(() => expect(screen.queryByTestId('model-switch-error')).toBeTruthy());
      await openRungs();

      // Assert
      expect(await rungNamed('claude-opus-5-5')).toHaveAttribute('aria-selected', 'true');
      expect(await rungNamed('sonnet')).toHaveAttribute('aria-selected', 'false');
    });
  });

  describe('the switch status next to the model button', () => {
    async function renderWith({ status, state = 'idle' }: { status: 'relaunching' | 'deferred'; state?: string }) {
      const api = { updateModel: vi.fn().mockResolvedValue({ status }) };
      const events = { sessions: signal([{ id: 's1', name: 'Gimli', emoji: '⚔️', model: 'claude-sonnet-5', state }]), approvals: signal([]), managers: signal([]) };
      const rendered = await render(ModelSelectorComponent, {
        bindings: [inputBinding('sessionId', () => 's1')],
        providers: [{ provide: FleetApiService, useValue: api }, { provide: FleetEventsService, useValue: events }],
      });
      return { ...rendered, events };
    }

    it('shows "restarting…" once the switch relaunches the session immediately', async () => {
      await renderWith({ status: 'relaunching' });

      await pickRung('opus');

      await waitFor(() => expect(screen.getByTestId('model-switch-status')).toHaveTextContent('restarting…'));
    });

    it('shows the pending chip with the requested rung when the switch waits for the turn to end', async () => {
      await renderWith({ status: 'deferred', state: 'generating' });

      await pickRung('opus');

      await waitFor(() =>
        expect(screen.getByTestId('model-switch-status')).toHaveTextContent('switch pending → opus · happens when this turn ends'),
      );
    });

    it('explains in the chip\'s tooltip that closing the session first cancels the switch', async () => {
      await renderWith({ status: 'deferred', state: 'generating' });

      await pickRung('opus');

      const chip = await screen.findByTestId('model-switch-status');
      expect(chip).toHaveAttribute(
        'title',
        'The switch restarts the session on the new model as soon as this turn ends. Closing the session first cancels the switch: it ends closed.',
      );
    });

    it('marks the requested rung as selected while the switch is pending', async () => {
      await renderWith({ status: 'deferred', state: 'generating' });
      await pickRung('opus');
      await screen.findByTestId('model-switch-status');

      await openRungs();

      expect(await rungNamed('opus')).toHaveAttribute('aria-selected', 'true');
    });

    it('clears the pending chip once the session reaches idle', async () => {
      const { events } = await renderWith({ status: 'deferred', state: 'generating' });
      await pickRung('opus');
      await waitFor(() => expect(screen.getByTestId('model-switch-status')).toHaveTextContent('switch pending'));

      events.sessions.set([{ id: 's1', name: 'Gimli', emoji: '⚔️', model: 'claude-sonnet-5', state: 'idle' }]);

      await waitFor(() => expect(screen.queryByTestId('model-switch-status')).toBeNull());
    });

    it('clears the switch status once the session closes', async () => {
      const { events } = await renderWith({ status: 'relaunching', state: 'starting' });
      await pickRung('opus');
      await waitFor(() => expect(screen.getByTestId('model-switch-status')).toHaveTextContent('restarting…'));

      events.sessions.set([{ id: 's1', name: 'Gimli', emoji: '⚔️', model: 'claude-sonnet-5', state: 'closed' }]);

      await waitFor(() => expect(screen.queryByTestId('model-switch-status')).toBeNull());
    });

    it('keeps "restarting…" visible when the daemon reports the model change before the relaunch settles', async () => {
      const { fixture, events } = await renderWith({ status: 'relaunching' });
      await pickRung('opus');
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

    it('does not keep the previous session\'s switch status visible after navigating to a different session', async () => {
      // Arrange — same instance reused across a `session/:sessionId` route param change (no destroy/recreate)
      const sessionId = signal('s1');
      const api = { updateModel: vi.fn().mockResolvedValue({ status: 'relaunching' }) };
      const events = { sessions: signal([{ id: 's1', name: 'Gimli', emoji: '⚔️', model: 'claude-sonnet-5', state: 'idle' }, { id: 's2', name: 'Legolas', emoji: '🏹', model: 'claude-haiku-4-5', state: 'idle' }]), approvals: signal([]), managers: signal([]) };
      await render(ModelSelectorComponent, {
        bindings: [inputBinding('sessionId', sessionId)],
        providers: [{ provide: FleetApiService, useValue: api }, { provide: FleetEventsService, useValue: events }],
      });
      await pickRung('opus');
      await waitFor(() => expect(screen.getByTestId('model-switch-status')).toHaveTextContent('restarting…'));

      // Act — navigate to a different session that never triggered a switch
      sessionId.set('s2');

      // Assert
      await waitFor(() => expect(screen.queryByTestId('model-switch-status')).toBeNull());
    });

    it('closes an open rung list when navigating to a different session', async () => {
      const sessionId = signal('s1');
      const events = { sessions: signal([{ id: 's1', name: 'Gimli', emoji: '⚔️', model: 'sonnet', state: 'idle' }, { id: 's2', name: 'Legolas', emoji: '🏹', model: 'haiku', state: 'idle' }]), approvals: signal([]), managers: signal([]) };
      const { fixture } = await render(ModelSelectorComponent, {
        bindings: [inputBinding('sessionId', sessionId)],
        providers: [{ provide: FleetApiService, useValue: { updateModel: vi.fn() } }, { provide: FleetEventsService, useValue: events }],
      });
      await openRungs();
      await rungNamed('sonnet');

      sessionId.set('s2');
      await fixture.whenStable();

      expect(rungList()).toBeNull();
    });
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
      await pickRung('opus');
      await waitFor(() => expect(screen.getByTestId('model-switch-status')).toHaveTextContent('switch pending'));

      const goTo = async (id: string) => {
        sessionId.set(id);
        await fixture.whenStable();
      };
      return { goTo, events };
    }

    it('shows session A\'s pending chip again, with the requested rung selected, after coming back', async () => {
      const { goTo } = await renderSwitchedAwayFromAndBackTo();
      await goTo('s2');

      await goTo('s1');

      expect(screen.getByTestId('model-switch-status')).toHaveTextContent('switch pending → opus · happens when this turn ends');
      await openRungs();
      expect(await rungNamed('opus')).toHaveAttribute('aria-selected', 'true');
    });

    it('lifts the restored chip once the turn ends', async () => {
      const { goTo, events } = await renderSwitchedAwayFromAndBackTo();
      await goTo('s2');
      await goTo('s1');

      events.sessions.update((all) => all.map((s) => (s.id === 's1' ? { ...s, state: 'idle' } : s)));

      await waitFor(() => expect(screen.queryByTestId('model-switch-status')).toBeNull());
    });

    it('shows no chip on return when the turn ended while the user was away', async () => {
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

      expect(screen.getByTestId('resolved-model')).toHaveTextContent('resolved · claude-opus-5-5');
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

    it('user sees no resolved model, CLI version or drift mark when the fields are empty strings', async () => {
      await renderWithSession({ resolvedModel: '', cliVersion: '', modelDriftedFrom: '' });

      expect(screen.queryByTestId('resolved-model')).toBeNull();
      expect(screen.queryByTestId('cli-version')).toBeNull();
      expect(screen.queryByTestId('model-drift')).toBeNull();
    });

    describe('fed by the real FleetEventsService', () => {
      class FakeWebSocket {
        static instances: FakeWebSocket[] = [];
        private readonly listeners: Record<string, ((event: { data: string }) => void)[]> = {};
        constructor(readonly url: string) {
          FakeWebSocket.instances.push(this);
        }
        addEventListener(type: string, listener: (event: { data: string }) => void): void {
          (this.listeners[type] ??= []).push(listener);
        }
        send(): void {}
        dispatchMessage(payload: unknown): void {
          for (const listener of this.listeners['message'] ?? []) listener({ data: JSON.stringify(payload) });
        }
      }

      afterEach(() => vi.unstubAllGlobals());

      const fullSession =(fields: Record<string, string>) => ({ id: 's1', name: 'Gimli', emoji: '⚔️', directory: '/tmp', harness: 'fake', state: 'idle', stateSince: 't', createdAt: 't', model: 'opus', ...fields });

      it('user sees the three lines stay on a model switch, the resolved model and drift mark clear on the relaunch session.updated, then the new resolved id return', async () => {
        // Arrange
        FakeWebSocket.instances = [];
        vi.stubGlobal('WebSocket', FakeWebSocket);
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({ ticket: 'fake-ticket' }) }));
        localStorage.clear();
        const events = new FleetEventsService();
        await events.connect();
        const socket = FakeWebSocket.instances[0]!;
        socket.dispatchMessage({ type: 'snapshot', sessions: [fullSession({ resolvedModel: 'claude-opus-5-5', cliVersion: '2.1.284', modelDriftedFrom: 'claude-opus-5-4' })], approvals: [] });
        const { fixture } = await render(ModelSelectorComponent, {
          bindings: [inputBinding('sessionId', () => 's1')],
          providers: [{ provide: FleetApiService, useValue: { updateModel: vi.fn() } }, { provide: FleetEventsService, useValue: events }],
        });
        expect(screen.getByTestId('resolved-model')).toBeTruthy();
        expect(screen.getByTestId('model-drift')).toBeTruthy();

        // Act — the daemon reports the model switch
        socket.dispatchMessage({ type: 'session.model_changed', sessionId: 's1', model: 'sonnet' });
        await fixture.whenStable();

        // Assert — the still-running process stays visible next to the pending model
        expect(screen.getByTestId('current-model')).toHaveTextContent('sonnet');
        expect(screen.getByTestId('resolved-model')).toHaveTextContent('resolved · claude-opus-5-5');
        expect(screen.getByTestId('model-drift')).toHaveTextContent('changed from claude-opus-5-4');
        expect(screen.getByTestId('cli-version')).toHaveTextContent('CLI 2.1.284');

        // Act — the relaunch clears the resolved fields
        socket.dispatchMessage({ type: 'session.updated', session: fullSession({ model: 'sonnet', cliVersion: '2.1.284' }) });
        await fixture.whenStable();

        // Assert
        expect(screen.queryByTestId('resolved-model')).toBeNull();
        expect(screen.queryByTestId('model-drift')).toBeNull();
        expect(screen.getByTestId('cli-version')).toHaveTextContent('CLI 2.1.284');

        // Act — the relaunched session reports its new resolved id and CLI version
        socket.dispatchMessage({ type: 'session.updated', session: fullSession({ model: 'sonnet', resolvedModel: 'claude-sonnet-5-5', cliVersion: '2.1.290' }) });
        await fixture.whenStable();

        // Assert
        expect(screen.getByTestId('resolved-model')).toHaveTextContent('resolved · claude-sonnet-5-5');
        expect(screen.getByTestId('cli-version')).toHaveTextContent('CLI 2.1.290');
        expect(screen.queryByTestId('model-drift')).toBeNull();
      });
    });
  });

  it('never types a slash-model command into the UI', async () => {
    await render(ModelSelectorComponent, {
      bindings: [inputBinding('sessionId', () => 's1')],
      providers: [{ provide: FleetApiService, useValue: { updateModel: vi.fn() } }, { provide: FleetEventsService, useValue: fakeEvents('claude-sonnet-5') }],
    });
    await openRungs();
    await rungNamed('opus');
    expect(document.body.textContent).not.toContain('/model');
  });

  it('gives the model button and its rung list accessible names', async () => {
    await render(ModelSelectorComponent, {
      bindings: [inputBinding('sessionId', () => 's1')],
      providers: [{ provide: FleetApiService, useValue: { updateModel: vi.fn() } }, { provide: FleetEventsService, useValue: fakeEvents('claude-sonnet-5') }],
    });
    expect(screen.getByRole('button', { name: 'Model: claude-sonnet-5' })).toBeTruthy();
    await openRungs();
    expect(await screen.findByRole('listbox', { name: 'Model' })).toBeTruthy();
  });
});
