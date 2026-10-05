import { render, screen, waitFor, fireEvent } from '@testing-library/angular/zoneless';
import userEvent from '@testing-library/user-event';
import { inputBinding, signal } from '@angular/core';
import { describe, expect, it, vi } from 'vitest';
import type { PermissionMode, SessionState } from '@openfleet/shared';
import { PermissionModePickerComponent } from './permission-mode-picker.component';
import { FleetApiService } from '../core/fleet-api.service';
import { FleetEventsService } from '../core/fleet-events.service';

/** The fleet as the daemon reports it: sessions s1 (and s2, when asked for) in the given state. */
function fakeFleet(state: SessionState = 'idle', sessionIds: string[] = ['s1']) {
  return {
    sessions: signal(sessionIds.map((id) => ({ id, name: id, emoji: '⚔️', state }))),
    approvals: signal([]),
    managers: signal([]),
  };
}

const setStateOf = (fleet: ReturnType<typeof fakeFleet>, sessionId: string, state: SessionState) =>
  fleet.sessions.update((all) => all.map((s) => (s.id === sessionId ? { ...s, state } : s)));

function providersWith(api: { updatePermissionMode: ReturnType<typeof vi.fn> }, fleet = fakeFleet()) {
  return [{ provide: FleetApiService, useValue: api }, { provide: FleetEventsService, useValue: fleet }];
}

const permissionButton = () => screen.getByRole('button', { name: /^Permission mode:/ });
const openModes = () => userEvent.click(permissionButton());
const modeNamed = (mode: string) => screen.findByRole('option', { name: new RegExp(`^${mode}`) });
const modeList = () => screen.queryByRole('listbox', { name: 'Permission mode' });
const bypassConfirm = () => screen.queryByRole('alertdialog', { name: 'Turn off permission checks' });
const turnOffChecks = () => screen.getByRole('button', { name: 'Turn off checks' });
const keepAsking = () => screen.getByRole('button', { name: 'Keep asking' });

async function pickMode(mode: string) {
  await openModes();
  await userEvent.click(await modeNamed(mode));
}

async function askForBypass() {
  await pickMode('bypassPermissions');
  await screen.findByRole('alertdialog');
}

interface PickerOptions {
  api?: { updatePermissionMode: ReturnType<typeof vi.fn> };
  currentMode?: PermissionMode;
  fleet?: ReturnType<typeof fakeFleet>;
}

/** Renders the picker; passing `currentMode: undefined` explicitly renders a session with no mode set (inherited). */
function renderPicker(options: PickerOptions = {}) {
  const { api = { updatePermissionMode: vi.fn() }, currentMode, fleet = fakeFleet() } = { currentMode: 'manual' as PermissionMode | undefined, ...options };
  return render(PermissionModePickerComponent, {
    bindings: [inputBinding('sessionId', () => 's1'), inputBinding('currentMode', () => currentMode)],
    providers: providersWith(api, fleet),
  });
}

describe('PermissionModePickerComponent', () => {
  it('shows the current mode on its button and lists all 6 modes in its popover, bypassPermissions last', async () => {
    await renderPicker({ currentMode: 'acceptEdits' });
    expect(screen.getByTestId('permission-mode')).toHaveTextContent('acceptEdits');
    expect(modeList()).toBeNull();

    await openModes();

    const options = await screen.findAllByRole('option');
    const expectedModes = ['manual', 'acceptEdits', 'plan', 'auto', 'dontAsk', 'bypassPermissions'];
    expect(options).toHaveLength(expectedModes.length);
    expectedModes.forEach((mode, index) => expect(options[index]).toHaveAccessibleName(new RegExp(`^${mode}`)));
  });

  it('puts a check mark on the mode in force, and none on the others', async () => {
    await renderPicker({ currentMode: 'plan' });

    await openModes();

    expect(await modeNamed('plan')).toHaveTextContent('✓');
    expect(await modeNamed('manual')).not.toHaveTextContent('✓');
  });

  it('writes a "!" right after bypassPermissions and after no other mode', async () => {
    await renderPicker();

    await openModes();

    expect((await modeNamed('bypassPermissions')).textContent).toMatch(/bypassPermissions\s*!/);
    expect((await modeNamed('dontAsk')).textContent).not.toContain('!');
  });

  it('announces the popup and its state on the button, and marks the session\'s mode as selected', async () => {
    await renderPicker({ currentMode: 'plan' });
    expect(permissionButton()).toHaveAttribute('aria-haspopup', 'listbox');
    expect(permissionButton()).toHaveAttribute('aria-expanded', 'false');

    await openModes();

    expect(permissionButton()).toHaveAttribute('aria-expanded', 'true');
    expect(await modeNamed('plan')).toHaveAttribute('aria-selected', 'true');
    expect(await modeNamed('manual')).toHaveAttribute('aria-selected', 'false');
  });

  const EXPLANATIONS = [
    ['manual', 'Asks before risky tools, except those already allowed in your Claude settings.'],
    ['acceptEdits', 'Edits are applied without asking; other tools still ask.'],
    ['plan', 'Read-only: the agent plans, never writes.'],
    ['auto', 'Risky tools are decided by the daemon policy.'],
    ['dontAsk', 'Never asks; denied tools fail silently.'],
    ['bypassPermissions', 'Every tool runs without a check — only in a sandbox.'],
  ] as const;

  it.each(EXPLANATIONS)('explains %s as "%s" on the button\'s tooltip', async (mode, explanation) => {
    await renderPicker({ currentMode: mode });
    expect(permissionButton()).toHaveAttribute('title', `Permission mode: ${mode} — ${explanation}`);
  });

  it.each(EXPLANATIONS)('explains %s as "%s" on its row in the popover', async (mode, explanation) => {
    await renderPicker();

    await openModes();

    expect(await modeNamed(mode)).toHaveTextContent(explanation);
  });

  it('renders bypassPermissions with a warning style', async () => {
    await renderPicker({ currentMode: 'bypassPermissions' });
    expect(screen.getByTestId('permission-mode')).toHaveAttribute('data-warning', '1');
  });

  it('does not warn for a non-dangerous mode', async () => {
    await renderPicker({ currentMode: 'manual' });
    expect(screen.getByTestId('permission-mode')).not.toHaveAttribute('data-warning');
  });

  it('shows "inherited" when the session carries no permission mode, never claiming a mode that was not set', async () => {
    await renderPicker({ currentMode: undefined });
    expect(screen.getByTestId('permission-mode')).toHaveTextContent('inherited');
    expect(permissionButton()).toHaveAttribute('title', 'Permission mode: inherited — No mode set: the CLI uses your own default (Claude settings)');

    await openModes();

    for (const option of await screen.findAllByRole('option')) expect(option).toHaveAttribute('aria-selected', 'false');
  });

  it('does not warn for the inherited (no mode set) state', async () => {
    await renderPicker({ currentMode: undefined });
    expect(screen.getByTestId('permission-mode')).not.toHaveAttribute('data-warning');
  });

  describe('the mode popover', () => {
    it('applies a picked non-dangerous mode with one click, no confirmation needed, and closes', async () => {
      const api = { updatePermissionMode: vi.fn().mockResolvedValue({ status: 'relaunching' }) };
      await renderPicker({ api });

      await pickMode('acceptEdits');

      expect(api.updatePermissionMode).toHaveBeenCalledWith('s1', 'acceptEdits');
      expect(bypassConfirm()).toBeNull();
      expect(modeList()).toBeNull();
      expect(permissionButton()).toHaveFocus();
    });

    it('sends nothing when the mode already in force is picked, and just closes', async () => {
      const api = { updatePermissionMode: vi.fn() };
      await renderPicker({ api, currentMode: 'manual' });

      await pickMode('manual');

      expect(api.updatePermissionMode).not.toHaveBeenCalled();
      expect(modeList()).toBeNull();
    });

    it('closes on Escape and gives focus back to the permission button', async () => {
      await renderPicker();
      await openModes();
      await waitFor(() => expect(screen.getByRole('option', { name: /^manual/ })).toHaveFocus());

      await userEvent.keyboard('{Escape}');

      expect(modeList()).toBeNull();
      expect(permissionButton()).toHaveFocus();
    });

    it('closes on a click outside, without taking focus back', async () => {
      await renderPicker();
      await openModes();
      await modeNamed('manual');

      await userEvent.click(document.body);

      expect(modeList()).toBeNull();
      expect(permissionButton()).not.toHaveFocus();
    });

    it('puts focus on the mode in force when it opens, and moves it with the arrow keys, wrapping at both ends', async () => {
      await renderPicker({ currentMode: 'acceptEdits' });
      await openModes();
      await waitFor(() => expect(screen.getByRole('option', { name: /^acceptEdits/ })).toHaveFocus());

      await userEvent.keyboard('{ArrowDown}');
      expect(screen.getByRole('option', { name: /^plan/ })).toHaveFocus();

      await userEvent.keyboard('{End}');
      expect(screen.getByRole('option', { name: /^bypassPermissions/ })).toHaveFocus();

      await userEvent.keyboard('{ArrowDown}');
      expect(screen.getByRole('option', { name: /^manual/ })).toHaveFocus();

      await userEvent.keyboard('{ArrowUp}');
      expect(screen.getByRole('option', { name: /^bypassPermissions/ })).toHaveFocus();
    });

    it('lets the keyboard choose a mode with Enter', async () => {
      const api = { updatePermissionMode: vi.fn().mockResolvedValue({ status: 'relaunching' }) };
      await renderPicker({ api, currentMode: 'manual' });
      await openModes();
      await waitFor(() => expect(screen.getByRole('option', { name: /^manual/ })).toHaveFocus());

      await userEvent.keyboard('{ArrowDown}{Enter}');

      expect(api.updatePermissionMode).toHaveBeenCalledWith('s1', 'acceptEdits');
    });
  });

  describe('the bypassPermissions confirmation', () => {
    it('opens as an alert dialog instead of switching, saying what turning the checks off means', async () => {
      const api = { updatePermissionMode: vi.fn().mockResolvedValue({ status: 'relaunching' }) };
      await renderPicker({ api });

      await askForBypass();

      expect(api.updatePermissionMode).not.toHaveBeenCalled();
      const dialog = screen.getByRole('alertdialog', { name: 'Turn off permission checks' });
      expect(dialog).toHaveTextContent('Turn off permission checks for this session?');
      expect(dialog).toHaveTextContent(
        'bypassPermissions lets the agent run every tool — shell, network, file deletes — without asking you. Gates stop appearing in the Inbox and the Audit log is the only record. It applies on the next turn.',
      );
    });

    it('draws "Turn off checks" with the shared danger style', async () => {
      await renderPicker();

      await askForBypass();

      expect(screen.getByRole('button', { name: 'Turn off checks' })).toHaveClass('of-btn', 'of-btn--danger');
    });

    it('puts focus on "Keep asking" when it opens', async () => {
      await renderPicker();

      await askForBypass();

      await waitFor(() => expect(keepAsking()).toHaveFocus());
    });

    it('applies bypassPermissions only after "Turn off checks", then closes and returns focus to the button', async () => {
      const api = { updatePermissionMode: vi.fn().mockResolvedValue({ status: 'relaunching' }) };
      await renderPicker({ api });
      await askForBypass();
      expect(api.updatePermissionMode).not.toHaveBeenCalled();

      await userEvent.click(turnOffChecks());

      expect(api.updatePermissionMode).toHaveBeenCalledTimes(1);
      expect(api.updatePermissionMode).toHaveBeenCalledWith('s1', 'bypassPermissions');
      expect(bypassConfirm()).toBeNull();
      expect(permissionButton()).toHaveFocus();
    });

    it('sends no request on "Keep asking", closes, and returns focus to the button', async () => {
      const api = { updatePermissionMode: vi.fn() };
      await renderPicker({ api });
      await askForBypass();

      await userEvent.click(keepAsking());

      expect(api.updatePermissionMode).not.toHaveBeenCalled();
      expect(bypassConfirm()).toBeNull();
      expect(modeList()).toBeNull();
      expect(permissionButton()).toHaveFocus();
    });

    it('sends no request on Escape, closes, and returns focus to the button', async () => {
      const api = { updatePermissionMode: vi.fn() };
      await renderPicker({ api });
      await askForBypass();
      await waitFor(() => expect(keepAsking()).toHaveFocus());

      await userEvent.keyboard('{Escape}');

      expect(api.updatePermissionMode).not.toHaveBeenCalled();
      expect(bypassConfirm()).toBeNull();
      expect(permissionButton()).toHaveFocus();
    });

    it('sends no request on a click outside, and the next opening shows the modes, not the confirmation', async () => {
      const api = { updatePermissionMode: vi.fn() };
      await renderPicker({ api });
      await askForBypass();

      await userEvent.click(document.body);
      expect(bypassConfirm()).toBeNull();
      await openModes();

      expect(api.updatePermissionMode).not.toHaveBeenCalled();
      expect(await screen.findByRole('listbox', { name: 'Permission mode' })).toBeTruthy();
      expect(bypassConfirm()).toBeNull();
    });

    it('keeps Tab and Shift+Tab inside the dialog, cycling between its two buttons', async () => {
      await renderPicker();
      await askForBypass();
      await waitFor(() => expect(keepAsking()).toHaveFocus());

      await userEvent.tab();
      expect(turnOffChecks()).toHaveFocus();

      await userEvent.tab();
      expect(keepAsking()).toHaveFocus();

      await userEvent.tab({ shift: true });
      expect(turnOffChecks()).toHaveFocus();
    });

    it('leaves the mode in force selected, not bypassPermissions, once the dialog is dismissed', async () => {
      await renderPicker({ currentMode: 'manual' });
      await askForBypass();
      await userEvent.click(keepAsking());

      await openModes();

      expect(await modeNamed('manual')).toHaveAttribute('aria-selected', 'true');
      expect(await modeNamed('bypassPermissions')).toHaveAttribute('aria-selected', 'false');
    });

    it('does not ask again for bypassPermissions when the session already runs in it', async () => {
      const api = { updatePermissionMode: vi.fn() };
      await renderPicker({ api, currentMode: 'bypassPermissions' });

      await pickMode('bypassPermissions');

      expect(bypassConfirm()).toBeNull();
      expect(api.updatePermissionMode).not.toHaveBeenCalled();
    });
  });

  describe('the switch status next to the permission button', () => {
    it('shows "restarting…" once the switch relaunches the session immediately', async () => {
      const api = { updatePermissionMode: vi.fn().mockResolvedValue({ status: 'relaunching' }) };
      await renderPicker({ api });

      await pickMode('acceptEdits');

      await waitFor(() => expect(screen.getByTestId('permission-mode-switch-status')).toHaveTextContent('restarting…'));
    });

    it('shows the deferred switch note when the switch waits for the turn to end', async () => {
      const api = { updatePermissionMode: vi.fn().mockResolvedValue({ status: 'deferred' }) };
      await renderPicker({ api });

      await pickMode('acceptEdits');

      await waitFor(() => expect(screen.getByTestId('permission-mode-switch-status')).toHaveTextContent('switch pending: happens when this turn ends'));
    });

    it('keeps "restarting…" visible when the daemon reports the mode change before the relaunch settles', async () => {
      const api = { updatePermissionMode: vi.fn().mockResolvedValue({ status: 'relaunching' }) };
      const currentMode = signal<'manual' | 'acceptEdits'>('manual');
      const fleet = fakeFleet('idle');
      const { fixture } = await render(PermissionModePickerComponent, {
        bindings: [inputBinding('sessionId', () => 's1'), inputBinding('currentMode', currentMode)],
        providers: providersWith(api, fleet),
      });

      await pickMode('acceptEdits');
      await waitFor(() => expect(screen.getByTestId('permission-mode-switch-status')).toHaveTextContent('restarting…'));

      // The daemon persists the mode and emits permission_mode_changed right away, before/while the relaunch starts.
      currentMode.set('acceptEdits');
      await fixture.whenStable();
      expect(screen.getByTestId('permission-mode-switch-status')).toHaveTextContent('restarting…');

      setStateOf(fleet, 's1', 'starting');
      await fixture.whenStable();
      expect(screen.getByTestId('permission-mode-switch-status')).toHaveTextContent('restarting…');

      setStateOf(fleet, 's1', 'idle');
      await waitFor(() => expect(screen.queryByTestId('permission-mode-switch-status')).toBeNull());
    });

    it('keeps "switch pending" visible until the turn ends, even once the mode itself has landed', async () => {
      const api = { updatePermissionMode: vi.fn().mockResolvedValue({ status: 'deferred' }) };
      const currentMode = signal<'manual' | 'acceptEdits'>('manual');
      const fleet = fakeFleet('generating');
      const { fixture } = await render(PermissionModePickerComponent, {
        bindings: [inputBinding('sessionId', () => 's1'), inputBinding('currentMode', currentMode)],
        providers: providersWith(api, fleet),
      });

      await pickMode('acceptEdits');
      await waitFor(() => expect(screen.getByTestId('permission-mode-switch-status')).toHaveTextContent('switch pending'));

      currentMode.set('acceptEdits');
      await fixture.whenStable();
      expect(screen.getByTestId('permission-mode-switch-status')).toHaveTextContent('switch pending');

      setStateOf(fleet, 's1', 'idle');
      await waitFor(() => expect(screen.queryByTestId('permission-mode-switch-status')).toBeNull());
    });

    it('clears the switch status once the session reaches idle', async () => {
      const api = { updatePermissionMode: vi.fn().mockResolvedValue({ status: 'deferred' }) };
      const fleet = fakeFleet('generating');
      await renderPicker({ api, fleet });
      await pickMode('acceptEdits');
      await waitFor(() => expect(screen.getByTestId('permission-mode-switch-status')).toHaveTextContent('switch pending'));

      setStateOf(fleet, 's1', 'idle');

      await waitFor(() => expect(screen.queryByTestId('permission-mode-switch-status')).toBeNull());
    });

    it('clears the "restarting…" note when the session closes mid-relaunch', async () => {
      const api = { updatePermissionMode: vi.fn().mockResolvedValue({ status: 'relaunching' }) };
      const fleet = fakeFleet('starting');
      await renderPicker({ api, fleet });
      await pickMode('acceptEdits');
      await waitFor(() => expect(screen.getByTestId('permission-mode-switch-status')).toHaveTextContent('restarting…'));

      setStateOf(fleet, 's1', 'closed');

      await waitFor(() => expect(screen.queryByTestId('permission-mode-switch-status')).toBeNull());
    });

    it('clears the "restarting…" note when the session closes mid-relaunch, starting from an inherited (no mode set) permission mode', async () => {
      const api = { updatePermissionMode: vi.fn().mockResolvedValue({ status: 'relaunching' }) };
      const fleet = fakeFleet('starting');
      await renderPicker({ api, fleet, currentMode: undefined });
      await pickMode('acceptEdits');
      await waitFor(() => expect(screen.getByTestId('permission-mode-switch-status')).toHaveTextContent('restarting…'));

      setStateOf(fleet, 's1', 'closed');

      await waitFor(() => expect(screen.queryByTestId('permission-mode-switch-status')).toBeNull());
    });

    it('marks the requested mode as selected while the switch is pending, even once the mode itself has landed', async () => {
      const api = { updatePermissionMode: vi.fn().mockResolvedValue({ status: 'deferred' }) };
      const currentMode = signal<'manual' | 'acceptEdits' | 'plan'>('manual');
      const fleet = fakeFleet('generating');
      const { fixture } = await render(PermissionModePickerComponent, {
        bindings: [inputBinding('sessionId', () => 's1'), inputBinding('currentMode', currentMode)],
        providers: providersWith(api, fleet),
      });
      await pickMode('acceptEdits');
      await waitFor(() => expect(screen.getByTestId('permission-mode-switch-status')).toHaveTextContent('switch pending'));

      currentMode.set('plan');
      await fixture.whenStable();
      await openModes();

      expect(await modeNamed('acceptEdits')).toHaveAttribute('aria-selected', 'true');
      expect(await modeNamed('plan')).toHaveAttribute('aria-selected', 'false');
    });
  });

  it('surfaces an error instead of silently discarding a failed mode switch', async () => {
    const api = { updatePermissionMode: vi.fn().mockRejectedValue(new Error('session_closed')) };
    await renderPicker({ api });

    await pickMode('acceptEdits');

    await waitFor(() => expect(screen.queryByTestId('permission-mode-switch-error')).toBeTruthy());
  });

  it('marks the previously confirmed mode as selected again after a failed switch', async () => {
    const api = { updatePermissionMode: vi.fn().mockRejectedValue(new Error('session_closed')) };
    await renderPicker({ api, currentMode: 'manual' });

    await pickMode('acceptEdits');
    await waitFor(() => expect(screen.queryByTestId('permission-mode-switch-error')).toBeTruthy());
    await openModes();

    expect(await modeNamed('manual')).toHaveAttribute('aria-selected', 'true');
    expect(await modeNamed('acceptEdits')).toHaveAttribute('aria-selected', 'false');
  });

  it('keeps the permission button inert while the request is in flight, then frees it', async () => {
    let resolveUpdate: (value: unknown) => void = () => {};
    const api = { updatePermissionMode: vi.fn(() => new Promise((resolve) => { resolveUpdate = resolve; })) };
    await renderPicker({ api });

    await pickMode('acceptEdits');
    await waitFor(() => expect(permissionButton()).toHaveAttribute('aria-disabled', 'true'));
    await userEvent.click(permissionButton());
    expect(modeList()).toBeNull();

    resolveUpdate({ status: 'relaunching' });
    await waitFor(() => expect(permissionButton()).not.toHaveAttribute('aria-disabled'));
  });

  it('sends only one updatePermissionMode call when a mode is double-clicked before the request resolves', async () => {
    let resolveUpdate: (value: unknown) => void = () => {};
    const api = { updatePermissionMode: vi.fn(() => new Promise((resolve) => { resolveUpdate = resolve; })) };
    await renderPicker({ api });
    await openModes();
    const acceptEdits = await modeNamed('acceptEdits');

    fireEvent.click(acceptEdits);
    fireEvent.click(acceptEdits);
    resolveUpdate({ status: 'relaunching' });
    await waitFor(() => expect(permissionButton()).not.toHaveAttribute('aria-disabled'));

    expect(api.updatePermissionMode).toHaveBeenCalledTimes(1);
  });

  it('marks the new session\'s mode as selected on a session switch, and closes an open popover', async () => {
    const sessionId = signal('s1');
    const currentMode = signal<'manual' | 'acceptEdits'>('manual');
    const { fixture } = await render(PermissionModePickerComponent, {
      bindings: [inputBinding('sessionId', sessionId), inputBinding('currentMode', currentMode)],
      providers: providersWith({ updatePermissionMode: vi.fn() }, fakeFleet('idle', ['s1', 's2'])),
    });
    await openModes();
    await modeNamed('manual');

    sessionId.set('s2');
    currentMode.set('acceptEdits');
    await fixture.whenStable();
    expect(modeList()).toBeNull();
    await openModes();

    expect(await modeNamed('acceptEdits')).toHaveAttribute('aria-selected', 'true');
  });

  describe('a pending switch belongs to its session', () => {
    async function renderSwitchedAwayFromAndBackTo(fleet: ReturnType<typeof fakeFleet>) {
      const api = { updatePermissionMode: vi.fn().mockResolvedValue({ status: 'deferred' }) };
      const sessionId = signal('s1');
      const currentMode = signal<'manual' | 'plan'>('manual');
      const { fixture } = await render(PermissionModePickerComponent, {
        bindings: [inputBinding('sessionId', sessionId), inputBinding('currentMode', currentMode)],
        providers: providersWith(api, fleet),
      });
      await pickMode('acceptEdits');
      await waitFor(() => expect(screen.getByTestId('permission-mode-switch-status')).toHaveTextContent('switch pending'));

      const goTo = async (id: string, mode: 'manual' | 'plan') => {
        sessionId.set(id);
        currentMode.set(mode);
        await fixture.whenStable();
      };
      return { goTo };
    }

    it('shows session A\'s deferred switch again after switching to B and coming back, with the requested mode selected', async () => {
      const { goTo } = await renderSwitchedAwayFromAndBackTo(fakeFleet('generating', ['s1', 's2']));
      await goTo('s2', 'plan');

      await goTo('s1', 'manual');

      expect(screen.getByTestId('permission-mode-switch-status')).toHaveTextContent('switch pending: happens when this turn ends');
      await openModes();
      expect(await modeNamed('acceptEdits')).toHaveAttribute('aria-selected', 'true');
    });

    it('does not restore the note when session A\'s turn ended while the user was away', async () => {
      const fleet = fakeFleet('generating', ['s1', 's2']);
      const { goTo } = await renderSwitchedAwayFromAndBackTo(fleet);
      await goTo('s2', 'plan');
      setStateOf(fleet, 's1', 'idle');

      await goTo('s1', 'manual');

      await waitFor(() => expect(screen.queryByTestId('permission-mode-switch-status')).toBeNull());
    });
  });

  it('gives the permission button and its mode list accessible names', async () => {
    await renderPicker();
    expect(screen.getByRole('button', { name: 'Permission mode: manual' })).toBeTruthy();
    await openModes();
    expect(await screen.findByRole('listbox', { name: 'Permission mode' })).toBeTruthy();
  });
});
