import { ChangeDetectionStrategy, Component, computed, inject, input, linkedSignal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { PERMISSION_MODES, type PermissionMode } from '@openfleet/shared';
import { PendingSwitchesService, SWITCH_STATUS_LABEL } from '../core/pending-switches.service';
import { SessionRequestsService } from '../core/session-requests';

export const PERMISSION_MODE_EXPLANATIONS: Record<PermissionMode, string> = {
  manual: 'Asks before risky tools, except those you already allowed in your Claude settings.',
  acceptEdits: 'File edits run without asking; shell and network still gate.',
  plan: 'Read-only: the agent plans and asks before any change.',
  auto: 'The harness decides from the project allow-list; unknown tools gate.',
  dontAsk: 'Gated tools are denied instead of asked — never blocks, never escalates.',
  bypassPermissions: 'Everything runs. Only for throwaway worktrees; audited and flagged red.',
};

const INHERITED_LABEL = 'inherited';
export const INHERITED_EXPLANATION ='No mode set: the CLI uses your own default (Claude settings)';
const FALLBACK_MODE: PermissionMode = 'manual';

@Component({
  selector: 'of-permission-mode-picker',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule],
  template: `
    <div class="permission-mode-picker" data-testid="permission-mode-picker">
      <span class="mode" data-testid="permission-mode" [attr.data-warning]="isDangerous() ? '1' : null">🛡 {{ label() }}</span>
      <span class="explanation" data-testid="permission-mode-explanation">{{ explanation() }}</span>
      <select class="of-input" data-testid="permission-mode-select" aria-label="Permission mode" [ngModel]="shownMode()" (ngModelChange)="pickedMode.set($event)">
        @for (mode of modes; track mode) { <option [value]="mode">{{ mode }}</option> }
      </select>
      <button type="button" class="of-btn of-btn--secondary" data-testid="apply-permission-mode" [disabled]="applying()" (click)="onApplyClick()">
        Apply
      </button>
      @if (confirmingBypass()) {
        <div class="bypass-confirm" data-testid="permission-mode-bypass-confirm-row">
          <span role="alert" data-testid="permission-mode-bypass-warning" class="of-error">✕ {{ bypassWarning }}</span>
          <button type="button" class="of-btn of-btn--secondary" data-testid="permission-mode-bypass-cancel" (click)="cancelBypass()">Cancel</button>
          <button type="button" class="of-btn of-btn--primary" data-testid="permission-mode-bypass-confirm" (click)="confirmBypass()">Confirm</button>
        </div>
      }
      @if (switchStatus(); as status) {
        <span class="switch-status" data-testid="permission-mode-switch-status">{{ statusLabel[status] }}</span>
      }
      @if (switchError(); as error) {
        <span role="alert" data-testid="permission-mode-switch-error" class="of-error">✕ {{ error }}</span>
      }
    </div>
  `,
  styles: `
    .permission-mode-picker { display: flex; align-items: center; gap: .375rem; flex-wrap: wrap; }
    .mode { display: inline-flex; align-items: center; gap: .25rem; height: 1.5rem; padding: 0 .5rem; border: 1px solid var(--line); border-radius: .375rem; font-family: var(--mono); font-size: .6875rem; color: var(--fg); }
    .mode[data-warning='1'] { border-color: var(--state-error); color: var(--state-error); }
    .explanation { font-size: .6875rem; color: var(--mut); }
    .switch-status { font-size: .6875rem; color: var(--state-waiting-permission); }
    .bypass-confirm { display: flex; align-items: center; gap: .375rem; }
  `,
})
export class PermissionModePickerComponent {
  readonly sessionId = input.required<string>();
  readonly currentMode = input<PermissionMode>();
  private readonly pendingSwitches = inject(PendingSwitchesService);
  private readonly requests = inject(SessionRequestsService);

  protected readonly modes = PERMISSION_MODES;
  protected readonly bypassWarning = PERMISSION_MODE_EXPLANATIONS.bypassPermissions;
  protected readonly statusLabel = SWITCH_STATUS_LABEL;
  protected readonly label = computed(() => this.currentMode() ?? INHERITED_LABEL);
  protected readonly isDangerous = computed(() => this.currentMode() === 'bypassPermissions');
  protected readonly explanation = computed(() => {
    const mode = this.currentMode();
    return mode ? PERMISSION_MODE_EXPLANATIONS[mode] : INHERITED_EXPLANATION;
  });

  // What the user picked and has not applied yet; a session switch starts from no pick and no bypass confirmation.
  protected readonly pickedMode = linkedSignal<string, PermissionMode | undefined>({ source: this.sessionId, computation: () => undefined });
  protected readonly confirmingBypass = linkedSignal<string, boolean>({ source: this.sessionId, computation: () => false });
  private readonly pending = computed(() => this.pendingSwitches.pendingOf(this.sessionId(), 'permissionMode'));
  private readonly modeInForce = computed(() => (this.pending()?.requestedValue as PermissionMode | undefined) ?? this.currentMode() ?? FALLBACK_MODE);
  protected readonly shownMode = computed(() => this.pickedMode() ?? this.modeInForce());
  protected readonly switchStatus = computed(() => this.pending()?.status ?? null);
  protected readonly applying = computed(() => this.requests.isBusy(this.sessionId(), 'permissionMode'));
  protected readonly switchError = computed(() => this.requests.errorOf(this.sessionId(), 'permissionMode'));

  protected onApplyClick(): void {
    if (this.shownMode() === 'bypassPermissions') {
      this.confirmingBypass.set(true);
      return;
    }
    this.apply();
  }

  protected cancelBypass(): void {
    this.confirmingBypass.set(false);
    this.pickedMode.set(undefined);
  }

  protected confirmBypass(): void {
    this.confirmingBypass.set(false);
    this.apply();
  }

  private apply(): void {
    const value = this.shownMode();
    this.pickedMode.set(undefined);
    void this.pendingSwitches.request({ sessionId: this.sessionId(), kind: 'permissionMode', value });
  }
}
