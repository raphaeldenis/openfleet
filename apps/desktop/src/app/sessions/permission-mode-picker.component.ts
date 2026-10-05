import { ChangeDetectionStrategy, Component, computed, inject, input, linkedSignal } from '@angular/core';
import { PERMISSION_MODES, type PermissionMode } from '@openfleet/shared';
import { ErrorLineComponent } from '../design/error-line.component';
import { moveFocusWithinListbox } from '../design/listbox-keyboard';
import { PopoverComponent } from '../design/popover.component';
import { PendingSwitchesService, SWITCH_STATUS_LABEL } from '../core/pending-switches.service';
import { SessionRequestsService } from '../core/session-requests';

export const PERMISSION_MODE_EXPLANATIONS: Record<PermissionMode, string> = {
  manual: 'Asks before risky tools, except those already allowed in your Claude settings.',
  acceptEdits: 'Edits are applied without asking; other tools still ask.',
  plan: 'Read-only: the agent plans, never writes.',
  auto: 'Risky tools are decided by the daemon policy.',
  dontAsk: 'Never asks; denied tools fail silently.',
  bypassPermissions: 'Every tool runs without a check — only in a sandbox.',
};

const INHERITED_LABEL = 'inherited';
export const INHERITED_EXPLANATION ='No mode set: the CLI uses your own default (Claude settings)';
const BYPASS_CONFIRM_TITLE = 'Turn off permission checks for this session?';
const BYPASS_CONFIRM_BODY =
  'bypassPermissions lets the agent run every tool — shell, network, file deletes — without asking you. Gates stop appearing in the Inbox and the Audit log is the only record. It applies on the next turn.';
const APPLY_NOTE = 'Changing the mode applies on the next turn (harness restarts if it must).';
const LIST_WIDTH = '17rem';
const BYPASS_CONFIRM_WIDTH = '24rem';
const MODES_WITH_BYPASS_LAST: readonly PermissionMode[] = [
  ...PERMISSION_MODES.filter((mode) => mode !== 'bypassPermissions'),
  'bypassPermissions',
];

@Component({
  selector: 'of-permission-mode-picker',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ErrorLineComponent, PopoverComponent],
  template: `
    <div class="permission-mode-picker" data-testid="permission-mode-picker">
      <of-popover
        #popover
        [(open)]="isOpen"
        triggerTestId="permission-mode-trigger"
        [triggerLabel]="'Permission mode: ' + label()"
        [triggerTitle]="'Permission mode: ' + label() + ' — ' + explanation()"
        [width]="confirmingBypass() ? bypassConfirmWidth : listWidth"
        [tone]="isDangerous() ? 'danger' : 'neutral'"
        [isAlertDialog]="confirmingBypass()"
        panelLabel="Turn off permission checks"
        [disabled]="applying()"
        [fillsRow]="true"
      >
        <span popoverTrigger class="mode" data-testid="permission-mode" [attr.data-warning]="isDangerous() ? '1' : null">{{ label() }}</span>
        <ng-template>
          @if (confirmingBypass()) {
            <div class="confirm-title"><span class="confirm-icon" aria-hidden="true">!</span>{{ bypassConfirmTitle }}</div>
            <div class="confirm-body">{{ bypassConfirmBody }}</div>
            <div class="confirm-actions">
              <button type="button" class="of-btn of-btn--danger" data-testid="permission-mode-bypass-confirm" (click)="confirmBypass(popover)">Turn off checks</button>
              <button type="button" class="of-btn of-btn--secondary" data-testid="permission-mode-bypass-cancel" data-initial-focus (click)="keepAsking(popover)">Keep asking</button>
            </div>
          } @else {
            <div role="listbox" aria-label="Permission mode" #listbox (keydown)="moveFocusWithinListbox($event, listbox)">
              @for (mode of modes; track mode; let index = $index) {
                <button
                  type="button"
                  role="option"
                  class="mode-row"
                  [attr.aria-selected]="mode === modeInForce()"
                  [attr.tabindex]="index === focusableModeIndex() ? 0 : -1"
                  [attr.data-initial-focus]="index === focusableModeIndex() ? '' : null"
                  (click)="choose(mode, popover)"
                >
                  <span class="mode-head">
                    <span class="check" aria-hidden="true">{{ mode === modeInForce() ? '✓' : '' }}</span>
                    <span class="mode-name">{{ mode }}</span>
                    @if (mode === dangerousMode) {
                      <span class="danger-mark" aria-hidden="true">!</span>
                    }
                  </span>
                  <span class="mode-explanation">{{ explanations[mode] }}</span>
                </button>
              }
            </div>
            <p class="apply-note">{{ applyNote }}</p>
          }
        </ng-template>
      </of-popover>
      @if (switchStatus(); as status) {
        <span class="switch-status" data-testid="permission-mode-switch-status">{{ statusLabel[status] }}</span>
      }
      @if (switchError(); as error) {
        <of-error-line role="alert" data-testid="permission-mode-switch-error">{{ error }}</of-error-line>
      }
    </div>
  `,
  styles: `
    :host { flex: 1; min-width: 0; }
    .permission-mode-picker { display: flex; align-items: center; gap: .375rem; flex-wrap: wrap; }
    .switch-status { font-size: .6875rem; color: var(--fg); }
    .mode-row {
      display: flex; flex-direction: column; align-items: flex-start; gap: .0625rem; width: 100%; padding: .375rem .5rem; border: 0; border-radius: .375rem;
      background: transparent; color: var(--fg); font: inherit; text-align: left; cursor: pointer;
    }
    .mode-row[aria-selected='true'], .mode-row:hover { background: var(--hover); }
    .mode-row:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
    .mode-head { display: flex; align-items: center; gap: .5rem; font-family: var(--mono); font-size: .75rem; }
    .mode-explanation { padding-left: 1.25rem; font-size: .75rem; color: var(--mut); text-wrap: pretty; }
    .danger-mark { font-weight: 700; color: var(--state-error); }
    .check { width: .75rem; color: var(--accent); }
    .apply-note { margin: 0; padding: .375rem .5rem 0; font-size: .6875rem; color: var(--mut); }
    .confirm-title { display: flex; align-items: center; gap: .5rem; font-weight: 600; }
    .confirm-icon { color: var(--state-error); }
    .confirm-body { font-size: .75rem; text-wrap: pretty; }
    .confirm-actions { display: flex; gap: .5rem; }
  `,
})
export class PermissionModePickerComponent {
  readonly sessionId = input.required<string>();
  readonly currentMode = input<PermissionMode>();
  private readonly pendingSwitches = inject(PendingSwitchesService);
  private readonly requests = inject(SessionRequestsService);

  protected readonly modes = MODES_WITH_BYPASS_LAST;
  protected readonly explanations = PERMISSION_MODE_EXPLANATIONS;
  protected readonly dangerousMode: PermissionMode = 'bypassPermissions';
  protected readonly statusLabel = SWITCH_STATUS_LABEL;
  protected readonly bypassConfirmTitle = BYPASS_CONFIRM_TITLE;
  protected readonly bypassConfirmBody = BYPASS_CONFIRM_BODY;
  protected readonly applyNote = APPLY_NOTE;
  protected readonly listWidth = LIST_WIDTH;
  protected readonly bypassConfirmWidth = BYPASS_CONFIRM_WIDTH;
  protected readonly moveFocusWithinListbox = moveFocusWithinListbox;
  protected readonly label = computed(() => this.currentMode() ?? INHERITED_LABEL);
  protected readonly isDangerous = computed(() => this.currentMode() === 'bypassPermissions');
  protected readonly explanation = computed(() => {
    const mode = this.currentMode();
    return mode ? PERMISSION_MODE_EXPLANATIONS[mode] : INHERITED_EXPLANATION;
  });

  // A session switch closes the list, and so does any closing: a reopened list never starts on the bypass confirmation.
  protected readonly isOpen = linkedSignal<string, boolean>({ source: this.sessionId, computation: () => false });
  protected readonly confirmingBypass = linkedSignal<{ sessionId: string; isOpen: boolean }, boolean>({
    source: () => ({ sessionId: this.sessionId(), isOpen: this.isOpen() }),
    computation: () => false,
  });
  private readonly pending = computed(() => this.pendingSwitches.pendingOf(this.sessionId(), 'permissionMode'));
  /** The mode the session runs in or is switching to: the one checked in the list; undefined while the CLI default is inherited. */
  protected readonly modeInForce = computed(() => (this.pending()?.requestedValue as PermissionMode | undefined) ?? this.currentMode());
  protected readonly focusableModeIndex = computed(() => {
    const modeInForce = this.modeInForce();
    return Math.max(modeInForce ? this.modes.indexOf(modeInForce) : 0, 0);
  });
  protected readonly switchStatus = computed(() => this.pending()?.status ?? null);
  protected readonly applying = computed(() => this.requests.isBusy(this.sessionId(), 'permissionMode'));
  protected readonly switchError = computed(() => this.requests.errorOf(this.sessionId(), 'permissionMode'));

  protected choose(mode: PermissionMode, popover: PopoverComponent): void {
    const isAlreadyInForce = mode === this.modeInForce();
    if (isAlreadyInForce) return popover.close();
    const needsConfirmation = mode === 'bypassPermissions';
    if (needsConfirmation) return this.confirmingBypass.set(true);
    this.applyAndClose(mode, popover);
  }

  protected confirmBypass(popover: PopoverComponent): void {
    this.applyAndClose('bypassPermissions', popover);
  }

  protected keepAsking(popover: PopoverComponent): void {
    popover.close();
  }

  private applyAndClose(mode: PermissionMode, popover: PopoverComponent): void {
    popover.close();
    if (this.applying()) return;
    void this.pendingSwitches.request({ sessionId: this.sessionId(), kind: 'permissionMode', value: mode });
  }
}
