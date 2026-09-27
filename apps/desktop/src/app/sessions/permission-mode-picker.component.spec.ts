import { render, screen, waitFor, fireEvent } from '@testing-library/angular/zoneless';
import userEvent from '@testing-library/user-event';
import { inputBinding, signal } from '@angular/core';
import { describe, expect, it, vi } from 'vitest';
import { PermissionModePickerComponent } from './permission-mode-picker.component';
import { FleetApiService } from '../core/fleet-api.service';

function providersWith(api: { updatePermissionMode: ReturnType<typeof vi.fn> }) {
  return [{ provide: FleetApiService, useValue: api }];
}

describe('PermissionModePickerComponent', () => {
  it('shows the current mode badge and lists all 6 modes to switch to', async () => {
    await render(PermissionModePickerComponent, {
      bindings: [inputBinding('sessionId', () => 's1'), inputBinding('currentMode', () => 'acceptEdits' as const)],
      providers: providersWith({ updatePermissionMode: vi.fn() }),
    });
    expect(screen.getByTestId('permission-mode')).toHaveTextContent('acceptEdits');
    const options = screen.getAllByRole('option').map((o) => o.getAttribute('value'));
    expect(options).toEqual(['manual', 'acceptEdits', 'plan', 'auto', 'bypassPermissions', 'dontAsk']);
  });

  it.each([
    ['manual', 'asks before risky tools, except those you already allowed in your Claude settings'],
    ['acceptEdits', 'File edits run without asking; shell and network still gate.'],
    ['plan', 'Read-only: the agent plans and asks before any change.'],
    ['auto', 'The harness decides from the project allow-list; unknown tools gate.'],
    ['dontAsk', 'Gated tools are denied instead of asked — never blocks, never escalates.'],
    ['bypassPermissions', 'Everything runs. Only for throwaway worktrees; audited and flagged red.'],
  ] as const)('explains %s as "%s"', async (mode, explanation) => {
    await render(PermissionModePickerComponent, {
      bindings: [inputBinding('sessionId', () => 's1'), inputBinding('currentMode', () => mode)],
      providers: providersWith({ updatePermissionMode: vi.fn() }),
    });
    expect(screen.getByTestId('permission-mode-explanation')).toHaveTextContent(explanation);
  });

  it('renders bypassPermissions with a warning style', async () => {
    await render(PermissionModePickerComponent, {
      bindings: [inputBinding('sessionId', () => 's1'), inputBinding('currentMode', () => 'bypassPermissions' as const)],
      providers: providersWith({ updatePermissionMode: vi.fn() }),
    });
    expect(screen.getByTestId('permission-mode')).toHaveAttribute('data-warning', '1');
  });

  it('does not warn for a non-dangerous mode', async () => {
    await render(PermissionModePickerComponent, {
      bindings: [inputBinding('sessionId', () => 's1'), inputBinding('currentMode', () => 'manual' as const)],
      providers: providersWith({ updatePermissionMode: vi.fn() }),
    });
    expect(screen.getByTestId('permission-mode')).not.toHaveAttribute('data-warning');
  });

  it('shows "inherited" when the session carries no permission mode, never claiming a mode that was not set', async () => {
    await render(PermissionModePickerComponent, {
      bindings: [inputBinding('sessionId', () => 's1'), inputBinding('currentMode', () => undefined)],
      providers: providersWith({ updatePermissionMode: vi.fn() }),
    });
    expect(screen.getByTestId('permission-mode')).toHaveTextContent('inherited');
    expect(screen.getByTestId('permission-mode-explanation')).toHaveTextContent(
      'No mode set: the CLI uses your own default (Claude settings)',
    );
  });

  it('does not warn for the inherited (no mode set) state', async () => {
    await render(PermissionModePickerComponent, {
      bindings: [inputBinding('sessionId', () => 's1'), inputBinding('currentMode', () => undefined)],
      providers: providersWith({ updatePermissionMode: vi.fn() }),
    });
    expect(screen.getByTestId('permission-mode')).not.toHaveAttribute('data-warning');
  });

  it('applies a picked non-dangerous mode with one click, no confirmation needed', async () => {
    const api = { updatePermissionMode: vi.fn().mockResolvedValue({ status: 'relaunching' }) };
    await render(PermissionModePickerComponent, {
      bindings: [inputBinding('sessionId', () => 's1'), inputBinding('currentMode', () => 'manual' as const)],
      providers: providersWith(api),
    });

    await userEvent.selectOptions(screen.getByTestId('permission-mode-select'), 'acceptEdits');
    await userEvent.click(screen.getByTestId('apply-permission-mode'));

    expect(api.updatePermissionMode).toHaveBeenCalledWith('s1', 'acceptEdits');
    expect(screen.queryByTestId('permission-mode-bypass-confirm-row')).toBeNull();
  });

  it('shows "restarting…" once the switch relaunches the session immediately', async () => {
    const api = { updatePermissionMode: vi.fn().mockResolvedValue({ status: 'relaunching' }) };
    await render(PermissionModePickerComponent, {
      bindings: [inputBinding('sessionId', () => 's1'), inputBinding('currentMode', () => 'manual' as const)],
      providers: providersWith(api),
    });
    await userEvent.click(screen.getByTestId('apply-permission-mode'));
    await waitFor(() => expect(screen.getByTestId('permission-mode-switch-status')).toHaveTextContent('restarting…'));
  });

  it('shows the deferred switch note when the switch waits for the turn to end', async () => {
    const api = { updatePermissionMode: vi.fn().mockResolvedValue({ status: 'deferred' }) };
    await render(PermissionModePickerComponent, {
      bindings: [inputBinding('sessionId', () => 's1'), inputBinding('currentMode', () => 'manual' as const)],
      providers: providersWith(api),
    });
    await userEvent.click(screen.getByTestId('apply-permission-mode'));
    await waitFor(() => expect(screen.getByTestId('permission-mode-switch-status')).toHaveTextContent('switch pending: happens when this turn ends'));
  });

  it('clears the switch status once the session reaches idle', async () => {
    const api = { updatePermissionMode: vi.fn().mockResolvedValue({ status: 'deferred' }) };
    const sessionState = signal<'generating' | 'idle'>('generating');
    await render(PermissionModePickerComponent, {
      bindings: [inputBinding('sessionId', () => 's1'), inputBinding('currentMode', () => 'manual' as const), inputBinding('sessionState', sessionState)],
      providers: providersWith(api),
    });
    await userEvent.click(screen.getByTestId('apply-permission-mode'));
    await waitFor(() => expect(screen.getByTestId('permission-mode-switch-status')).toHaveTextContent('switch pending'));

    sessionState.set('idle');

    await waitFor(() => expect(screen.queryByTestId('permission-mode-switch-status')).toBeNull());
  });

  it('clears the "restarting…" note when the session closes mid-relaunch', async () => {
    const api = { updatePermissionMode: vi.fn().mockResolvedValue({ status: 'relaunching' }) };
    const sessionState = signal<'starting' | 'closed'>('starting');
    await render(PermissionModePickerComponent, {
      bindings: [inputBinding('sessionId', () => 's1'), inputBinding('currentMode', () => 'manual' as const), inputBinding('sessionState', sessionState)],
      providers: providersWith(api),
    });
    await userEvent.click(screen.getByTestId('apply-permission-mode'));
    await waitFor(() => expect(screen.getByTestId('permission-mode-switch-status')).toHaveTextContent('restarting…'));

    sessionState.set('closed');

    await waitFor(() => expect(screen.queryByTestId('permission-mode-switch-status')).toBeNull());
  });

  it('requires a confirmation before applying bypassPermissions, showing it with the alert style', async () => {
    const api = { updatePermissionMode: vi.fn().mockResolvedValue({ status: 'relaunching' }) };
    await render(PermissionModePickerComponent, {
      bindings: [inputBinding('sessionId', () => 's1'), inputBinding('currentMode', () => 'manual' as const)],
      providers: providersWith(api),
    });

    await userEvent.selectOptions(screen.getByTestId('permission-mode-select'), 'bypassPermissions');
    await userEvent.click(screen.getByTestId('apply-permission-mode'));

    expect(api.updatePermissionMode).not.toHaveBeenCalled();
    const warning = screen.getByTestId('permission-mode-bypass-warning');
    expect(warning).toHaveAttribute('role', 'alert');
    expect(warning).toHaveTextContent('Everything runs. Only for throwaway worktrees; audited and flagged red.');

    await userEvent.click(screen.getByTestId('permission-mode-bypass-confirm'));
    expect(api.updatePermissionMode).toHaveBeenCalledWith('s1', 'bypassPermissions');
  });

  it('cancelling the bypassPermissions confirmation sends no request', async () => {
    const api = { updatePermissionMode: vi.fn() };
    await render(PermissionModePickerComponent, {
      bindings: [inputBinding('sessionId', () => 's1'), inputBinding('currentMode', () => 'manual' as const)],
      providers: providersWith(api),
    });

    await userEvent.selectOptions(screen.getByTestId('permission-mode-select'), 'bypassPermissions');
    await userEvent.click(screen.getByTestId('apply-permission-mode'));
    await userEvent.click(screen.getByTestId('permission-mode-bypass-cancel'));

    expect(api.updatePermissionMode).not.toHaveBeenCalled();
    expect(screen.queryByTestId('permission-mode-bypass-confirm-row')).toBeNull();
  });

  it('puts the select back on the applied mode when the bypassPermissions confirmation is cancelled', async () => {
    const api = { updatePermissionMode: vi.fn() };
    await render(PermissionModePickerComponent, {
      bindings: [inputBinding('sessionId', () => 's1'), inputBinding('currentMode', () => 'manual' as const)],
      providers: providersWith(api),
    });
    const select = screen.getByTestId('permission-mode-select') as HTMLSelectElement;

    await userEvent.selectOptions(select, 'bypassPermissions');
    await userEvent.click(screen.getByTestId('apply-permission-mode'));
    await userEvent.click(screen.getByTestId('permission-mode-bypass-cancel'));

    expect(select.value).toBe('manual');
  });

  it('surfaces an error instead of silently discarding a failed mode switch', async () => {
    const api = { updatePermissionMode: vi.fn().mockRejectedValue(new Error('session_closed')) };
    await render(PermissionModePickerComponent, {
      bindings: [inputBinding('sessionId', () => 's1'), inputBinding('currentMode', () => 'manual' as const)],
      providers: providersWith(api),
    });

    await userEvent.click(screen.getByTestId('apply-permission-mode'));

    await waitFor(() => expect(screen.queryByTestId('permission-mode-switch-error')).toBeTruthy());
  });

  it('reverts the select to the previously confirmed mode after a failed switch', async () => {
    const api = { updatePermissionMode: vi.fn().mockRejectedValue(new Error('session_closed')) };
    await render(PermissionModePickerComponent, {
      bindings: [inputBinding('sessionId', () => 's1'), inputBinding('currentMode', () => 'manual' as const)],
      providers: providersWith(api),
    });
    const select = screen.getByTestId('permission-mode-select') as HTMLSelectElement;

    await userEvent.selectOptions(select, 'acceptEdits');
    await userEvent.click(screen.getByTestId('apply-permission-mode'));
    await waitFor(() => expect(screen.queryByTestId('permission-mode-switch-error')).toBeTruthy());

    expect(select.value).toBe('manual');
  });

  it('disables Apply while the request is in flight', async () => {
    let resolveUpdate: (value: unknown) => void = () => {};
    const api = { updatePermissionMode: vi.fn(() => new Promise((resolve) => { resolveUpdate = resolve; })) };
    await render(PermissionModePickerComponent, {
      bindings: [inputBinding('sessionId', () => 's1'), inputBinding('currentMode', () => 'manual' as const)],
      providers: providersWith(api),
    });
    const applyButton = screen.getByTestId('apply-permission-mode') as HTMLButtonElement;

    await userEvent.click(applyButton);
    await waitFor(() => expect(applyButton.disabled).toBe(true));

    resolveUpdate({ status: 'relaunching' });
    await waitFor(() => expect(applyButton.disabled).toBe(false));
  });

  it('keeps a newly picked mode selected when an earlier pending switch lands, without touching it', async () => {
    const api = { updatePermissionMode: vi.fn().mockResolvedValue({ status: 'deferred' }) };
    const currentMode = signal<'manual' | 'acceptEdits' | undefined>('manual');
    await render(PermissionModePickerComponent, {
      bindings: [inputBinding('sessionId', () => 's1'), inputBinding('currentMode', currentMode)],
      providers: providersWith(api),
    });
    const select = screen.getByTestId('permission-mode-select') as HTMLSelectElement;

    await userEvent.selectOptions(select, 'acceptEdits');
    await userEvent.click(screen.getByTestId('apply-permission-mode'));
    await waitFor(() => expect(screen.getByTestId('permission-mode-switch-status')).toHaveTextContent('switch pending'));

    await userEvent.selectOptions(select, 'plan');
    currentMode.set('acceptEdits');

    // Force the currentMode update to actually flush before asserting: it clears the switch-status
    // note either way (buggy full reset, or the fix's "switch landed" detection), so waiting for that
    // guards against asserting on a stale DOM snapshot taken before the signal update propagated.
    await waitFor(() => expect(screen.queryByTestId('permission-mode-switch-status')).toBeNull());
    expect(select.value).toBe('plan');
  });

  it('resets the picker to the new session\'s mode on a session switch, even mid pending-switch', async () => {
    const api = { updatePermissionMode: vi.fn().mockResolvedValue({ status: 'deferred' }) };
    const sessionId = signal('s1');
    const currentMode = signal<'manual' | 'acceptEdits' | undefined>('manual');
    await render(PermissionModePickerComponent, {
      bindings: [inputBinding('sessionId', sessionId), inputBinding('currentMode', currentMode)],
      providers: providersWith(api),
    });
    const select = screen.getByTestId('permission-mode-select') as HTMLSelectElement;
    await userEvent.selectOptions(select, 'plan');

    sessionId.set('s2');
    currentMode.set('acceptEdits');

    await waitFor(() => expect(select.value).toBe('acceptEdits'));
  });

  it('gives the mode select an accessible name', async () => {
    await render(PermissionModePickerComponent, {
      bindings: [inputBinding('sessionId', () => 's1'), inputBinding('currentMode', () => 'manual' as const)],
      providers: providersWith({ updatePermissionMode: vi.fn() }),
    });
    expect(screen.getByRole('combobox', { name: 'Permission mode' })).toBeTruthy();
  });

  it('sends only one updatePermissionMode call when Apply is double-clicked before the request resolves', async () => {
    let resolveUpdate: (value: unknown) => void = () => {};
    const api = { updatePermissionMode: vi.fn(() => new Promise((resolve) => { resolveUpdate = resolve; })) };
    await render(PermissionModePickerComponent, {
      bindings: [inputBinding('sessionId', () => 's1'), inputBinding('currentMode', () => 'manual' as const)],
      providers: providersWith(api),
    });
    const applyButton = screen.getByTestId('apply-permission-mode') as HTMLButtonElement;

    fireEvent.click(applyButton);
    fireEvent.click(applyButton);
    resolveUpdate({ status: 'relaunching' });
    await waitFor(() => expect(applyButton.disabled).toBe(false));

    expect(api.updatePermissionMode).toHaveBeenCalledTimes(1);
  });
});
