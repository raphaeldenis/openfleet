import { render, screen } from '@testing-library/angular/zoneless';
import { inputBinding } from '@angular/core';
import { describe, expect, it } from 'vitest';
import { PermissionModePickerComponent } from './permission-mode-picker.component';

describe('PermissionModePickerComponent', () => {
  it('renders the current mode read-only, since no REST route updates permission mode on a running session', async () => {
    await render(PermissionModePickerComponent, {
      bindings: [inputBinding('sessionId', () => 's1'), inputBinding('currentMode', () => 'acceptEdits' as const)],
    });
    expect(screen.getByTestId('permission-mode')).toHaveTextContent('acceptEdits');
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.queryByRole('combobox')).toBeNull();
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
    });
    expect(screen.getByTestId('permission-mode-explanation')).toHaveTextContent(explanation);
  });

  it('renders bypassPermissions with a warning style', async () => {
    await render(PermissionModePickerComponent, {
      bindings: [inputBinding('sessionId', () => 's1'), inputBinding('currentMode', () => 'bypassPermissions' as const)],
    });
    expect(screen.getByTestId('permission-mode')).toHaveAttribute('data-warning', '1');
  });

  it('does not warn for a non-dangerous mode', async () => {
    await render(PermissionModePickerComponent, {
      bindings: [inputBinding('sessionId', () => 's1'), inputBinding('currentMode', () => 'manual' as const)],
    });
    expect(screen.getByTestId('permission-mode')).not.toHaveAttribute('data-warning');
  });

  it('shows "inherited" when the session carries no permission mode, never claiming a mode that was not set', async () => {
    await render(PermissionModePickerComponent, {
      bindings: [inputBinding('sessionId', () => 's1'), inputBinding('currentMode', () => undefined)],
    });
    expect(screen.getByTestId('permission-mode')).toHaveTextContent('inherited');
    expect(screen.getByTestId('permission-mode-explanation')).toHaveTextContent(
      'No mode set: the CLI uses your own default (Claude settings)',
    );
  });

  it('does not warn for the inherited (no mode set) state', async () => {
    await render(PermissionModePickerComponent, {
      bindings: [inputBinding('sessionId', () => 's1'), inputBinding('currentMode', () => undefined)],
    });
    expect(screen.getByTestId('permission-mode')).not.toHaveAttribute('data-warning');
  });
});
