import { ChangeDetectionStrategy, Component, DestroyRef, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { PERMISSION_MODES, type PermissionMode, type SessionState } from '@openfleet/shared';
import { FleetApiService } from '../core/fleet-api.service';
import { NO_SWITCH_TRACKED, PendingSwitchesService, type SwitchSnapshot, type SwitchStatus } from '../core/pending-switches.service';
import { SessionRequests } from '../core/session-requests';

export const PERMISSION_MODE_EXPLANATIONS: Record<PermissionMode, string> = {
  manual: 'asks before risky tools, except those you already allowed in your Claude settings',
  acceptEdits: 'File edits run without asking; shell and network still gate.',
  plan: 'Read-only: the agent plans and asks before any change.',
  auto: 'The harness decides from the project allow-list; unknown tools gate.',
  dontAsk: 'Gated tools are denied instead of asked — never blocks, never escalates.',
  bypassPermissions: 'Everything runs. Only for throwaway worktrees; audited and flagged red.',
};

const INHERITED_LABEL = 'inherited';
export const INHERITED_EXPLANATION ='No mode set: the CLI uses your own default (Claude settings)';
const PERMISSION_MODE_SWITCH_ERROR = 'Could not change permission mode — try again.';

const SWITCH_STATUS_LABEL: Record<SwitchStatus, string> = {
  relaunching: 'restarting…',
  deferred: 'switch pending: happens when this turn ends',
};

@Component({
  selector: 'of-permission-mode-picker',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule],
  template: `
    <div class="permission-mode-picker" data-testid="permission-mode-picker">
      <span class="mode" data-testid="permission-mode" [attr.data-warning]="isDangerous() ? '1' : null">🛡 {{ label() }}</span>
      <span class="explanation" data-testid="permission-mode-explanation">{{ explanation() }}</span>
      <select class="of-input" data-testid="permission-mode-select" aria-label="Permission mode" [(ngModel)]="chosenMode">
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
        <span class="switch-status" data-testid="permission-mode-switch-status">{{ statusLabel(status) }}</span>
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
  readonly sessionState = input<SessionState>();
  private readonly api = inject(FleetApiService);
  private readonly pendingSwitches = inject(PendingSwitchesService);
  private shownSessionId: string | undefined;

  protected readonly modes = PERMISSION_MODES;
  protected readonly bypassWarning = PERMISSION_MODE_EXPLANATIONS.bypassPermissions;
  protected readonly label = computed(() => this.currentMode() ?? INHERITED_LABEL);
  protected readonly isDangerous = computed(() => this.currentMode() === 'bypassPermissions');
  protected readonly explanation = computed(() => {
    const mode = this.currentMode();
    return mode ? PERMISSION_MODE_EXPLANATIONS[mode] : INHERITED_EXPLANATION;
  });

  chosenMode: PermissionMode = 'manual';
  private confirmedMode: PermissionMode = 'manual';
  readonly applying = signal(false);
  readonly confirmingBypass = signal(false);
  readonly switchStatus = signal<'relaunching' | 'deferred' | null>(null);
  readonly switchError = signal<string | null>(null);
  // The mode and state in effect when the current switch was requested — `null` (not `undefined`)
  // records an inherited starting mode, since `undefined` is the "no switch pending" sentinel below —
  // collapsing the two left a switch from an inherited mode untracked forever.
  private readonly modeBeforeSwitch = signal<PermissionMode | null | undefined>(undefined);
  private readonly stateBeforeSwitch = signal<SessionState | undefined>(undefined);
  // The daemon persists the mode (and emits permission_mode_changed) before or while the relaunch it
  // triggers is still starting, so the mode alone landing is not proof the switch is done — only the
  // relaunch's own state transition (leaving 'starting') or the turn ending (idle/closed) is.
  private readonly sawStartingSinceSwitch = signal(false);

  private readonly requests = new SessionRequests({
    shownSessionId: () => this.sessionId(),
    busy: this.applying,
    error: this.switchError,
  });

  constructor() {
    // A route param change reuses this component instance: the session being left keeps its pending
    // switch in the service, the session arriving gets its own back.
    effect(() => {
      const sessionId = this.sessionId();
      untracked(() => this.showSwitchStateOf(sessionId));
    });
    inject(DestroyRef).onDestroy(() => this.parkPendingSwitchOfShownSession());

    // A switch requested while another relaunch is already starting waits for the session to leave that
    // one: only a 'starting' entered after the request is this switch's own relaunch.
    effect(() => {
      const requestedFrom = this.modeBeforeSwitch();
      if (requestedFrom === undefined) return;
      const state = this.sessionState();
      const wasRequestedDuringRelaunch = this.stateBeforeSwitch() === 'starting';
      if (state === 'starting') {
        if (!wasRequestedDuringRelaunch) this.sawStartingSinceSwitch.set(true);
        return;
      }
      const relaunchSettled = this.sawStartingSinceSwitch();
      const isEarlierRelaunchOver = wasRequestedDuringRelaunch && !relaunchSettled && state !== 'closed';
      if (isEarlierRelaunchOver) {
        this.stateBeforeSwitch.set(state);
        return;
      }
      const turnEndSettled = (state === 'idle' || state === 'closed') && state !== this.stateBeforeSwitch();
      if (!relaunchSettled && !turnEndSettled) return;
      this.switchStatus.set(null);
      this.modeBeforeSwitch.set(undefined);
      this.stateBeforeSwitch.set(undefined);
      this.sawStartingSinceSwitch.set(false);
    });
  }

  private showSwitchStateOf(sessionId: string): void {
    this.parkPendingSwitchOfShownSession();
    this.shownSessionId = sessionId;
    this.requests.show(sessionId);
    this.confirmingBypass.set(false);
    const pending = this.pendingSwitches.recall(sessionId, 'permissionMode');
    const currentMode = this.currentMode() ?? 'manual';
    this.showSwitch(pending ?? { ...NO_SWITCH_TRACKED, requestedValue: currentMode });
  }

  private parkPendingSwitchOfShownSession(): void {
    if (this.shownSessionId === undefined) return;
    this.pendingSwitches.park(this.shownSessionId, 'permissionMode', this.switchSnapshot());
  }

  private switchSnapshot(): SwitchSnapshot {
    return {
      status: this.switchStatus(),
      requestedValue: this.confirmedMode,
      valueBeforeSwitch: this.modeBeforeSwitch(),
      stateBeforeSwitch: this.stateBeforeSwitch(),
      sawStartingSinceSwitch: this.sawStartingSinceSwitch(),
    };
  }

  private showSwitch(snapshot: SwitchSnapshot): void {
    this.chosenMode = snapshot.requestedValue as PermissionMode;
    this.confirmedMode = this.chosenMode;
    this.switchStatus.set(snapshot.status);
    this.modeBeforeSwitch.set(snapshot.valueBeforeSwitch as PermissionMode | null | undefined);
    this.stateBeforeSwitch.set(snapshot.stateBeforeSwitch);
    this.sawStartingSinceSwitch.set(snapshot.sawStartingSinceSwitch);
  }

  statusLabel(status: SwitchStatus): string {
    return SWITCH_STATUS_LABEL[status];
  }

  onApplyClick(): void {
    if (this.chosenMode === 'bypassPermissions') {
      this.confirmingBypass.set(true);
      return;
    }
    void this.apply();
  }

  cancelBypass(): void {
    this.confirmingBypass.set(false);
    this.chosenMode = this.confirmedMode;
  }

  confirmBypass(): void {
    this.confirmingBypass.set(false);
    void this.apply();
  }

  // The switch is tracked from the click, not from the reply: the daemon's state events can outrun the HTTP
  // answer, and a tracking that starts late would miss a relaunch that already ran.
  private async apply(): Promise<void> {
    const sessionIdAtApply = this.sessionId();
    const modeAtApply = this.currentMode() ?? null;
    const stateAtApply = this.sessionState();
    const attemptedMode = this.chosenMode;
    const switchBeforeApply = this.switchSnapshot();
    await this.requests.run(sessionIdAtApply, PERMISSION_MODE_SWITCH_ERROR, async (isStale) => {
      this.showSwitch({
        status: switchBeforeApply.status,
        requestedValue: attemptedMode,
        valueBeforeSwitch: modeAtApply,
        stateBeforeSwitch: stateAtApply,
        sawStartingSinceSwitch: false,
      });
      try {
        const { status } = await this.api.updatePermissionMode(sessionIdAtApply, attemptedMode);
        if (isStale()) this.pendingSwitches.answer(sessionIdAtApply, 'permissionMode', status);
        else this.showAnswer(status);
      } catch (error) {
        if (isStale()) this.pendingSwitches.park(sessionIdAtApply, 'permissionMode', switchBeforeApply);
        else this.showSwitch(switchBeforeApply);
        throw error;
      }
    });
  }

  // A switch the session has already settled (its relaunch or turn ended before the answer) shows no note.
  private showAnswer(status: SwitchStatus): void {
    const isSwitchStillTracked = this.modeBeforeSwitch() !== undefined;
    if (isSwitchStillTracked) this.switchStatus.set(status);
  }
}
