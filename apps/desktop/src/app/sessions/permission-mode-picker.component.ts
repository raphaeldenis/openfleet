import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import type { PermissionMode } from '@openfleet/shared';

// No REST route lets a running session's permission mode change today (checked against
// packages/core/src/api/restHandlers.ts on 2026-09-26 — only /model, /messages, /input,
// /resize, /close exist for a session). Until one lands this renders read-only: a label and
// a one-line explanation, never a picker that could call an endpoint that does not exist.
const EXPLANATION: Record<PermissionMode, string> = {
  manual: 'asks before risky tools, except those you already allowed in your Claude settings',
  acceptEdits: 'File edits run without asking; shell and network still gate.',
  plan: 'Read-only: the agent plans and asks before any change.',
  auto: 'The harness decides from the project allow-list; unknown tools gate.',
  dontAsk: 'Gated tools are denied instead of asked — never blocks, never escalates.',
  bypassPermissions: 'Everything runs. Only for throwaway worktrees; audited and flagged red.',
};

const DEFAULT_MODE: PermissionMode = 'manual';

@Component({
  selector: 'of-permission-mode-picker',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <span class="mode" data-testid="permission-mode" [attr.data-warning]="isDangerous() ? '1' : null">🛡 {{ mode() }}</span>
    <span class="explanation" data-testid="permission-mode-explanation">{{ explanation() }}</span>
  `,
  styles: `
    .mode { display: inline-flex; align-items: center; gap: .25rem; height: 1.5rem; padding: 0 .5rem; border: 1px solid var(--line); border-radius: .375rem; font-family: var(--mono); font-size: .6875rem; color: var(--fg); }
    .mode[data-warning='1'] { border-color: var(--state-error); color: var(--state-error); }
    .explanation { font-size: .6875rem; color: var(--mut); }
  `,
})
export class PermissionModePickerComponent {
  readonly sessionId = input.required<string>();
  readonly currentMode = input<PermissionMode>();
  protected readonly mode = computed(() => this.currentMode() ?? DEFAULT_MODE);
  protected readonly isDangerous = computed(() => this.mode() === 'bypassPermissions');
  protected readonly explanation = computed(() => EXPLANATION[this.mode()]);
}
