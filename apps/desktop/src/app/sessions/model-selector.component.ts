import { ChangeDetectionStrategy, Component, DestroyRef, computed, effect, inject, input, output, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import type { SessionState } from '@openfleet/shared';
import { FleetApiService } from '../core/fleet-api.service';
import { FleetEventsService } from '../core/fleet-events.service';
import { PendingSwitchesService } from '../core/pending-switches.service';
import { runGuarded } from '../core/run-guarded';

const MODEL_SWITCH_ERROR = 'Could not switch model — try again.';

export const MODEL_RUNGS = ['haiku', 'sonnet', 'opus', 'fable'] as const;

const SWITCH_STATUS_LABEL: Record<'relaunching' | 'deferred', string> = {
  relaunching: 'restarting…',
  deferred: 'switch pending: happens when this turn ends',
};

@Component({
  selector: 'of-model-selector',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule],
  template: `
    <div class="model-selector" data-testid="model-selector">
      <span class="current" data-testid="current-model">{{ session()?.model ?? 'default' }}</span>
      <select class="of-input" data-testid="model-select" aria-label="Model" [(ngModel)]="chosenRung">
        @for (rung of rungs(); track rung) {
          <option [value]="rung">{{ rung }}</option>
        }
      </select>
      <button type="button" class="of-btn of-btn--secondary" data-testid="apply-model" [disabled]="applying()" (click)="apply()">Apply</button>
      @if (switchStatus(); as status) {
        <span class="switch-status" data-testid="model-switch-status">{{ statusLabel(status) }}</span>
      }
      @if (switchError(); as error) {
        <span role="alert" data-testid="model-switch-error" class="of-error">✕ {{ error }}</span>
      }
    </div>
  `,
  styles: `
    .model-selector { display: flex; align-items: center; gap: .375rem; }
    .current { font-family: var(--mono); font-size: .75rem; }
    .switch-status { font-size: .6875rem; color: var(--state-waiting-permission); }
  `,
})
export class ModelSelectorComponent {
  readonly sessionId = input.required<string>();
  readonly pendingModelSwitch = output<boolean>();
  private readonly events = inject(FleetEventsService);
  private readonly api = inject(FleetApiService);
  private readonly pendingSwitches = inject(PendingSwitchesService);
  private shownSessionId: string | undefined;
  // The session's current model rarely matches one of the fixed rungs exactly (it is a full model id,
  // e.g. 'claude-opus-5-5', not the short alias 'opus') — add it as its own option instead of forcing
  // the select onto a rung that would silently apply a different model.
  readonly rungs = computed(() => {
    const model = this.session()?.model;
    return model && !(MODEL_RUNGS as readonly string[]).includes(model) ? [...MODEL_RUNGS, model] : MODEL_RUNGS;
  });
  chosenRung = 'sonnet';
  // The last value a switch actually confirmed (or the session's model at mount) — a failed switch
  // reverts `chosenRung` here instead of leaving the select showing the rejected choice.
  private confirmedRung = 'sonnet';
  readonly applying = signal(false);
  readonly switchStatus = signal<'relaunching' | 'deferred' | null>(null);
  readonly switchError = signal<string | null>(null);
  // The model and state in effect when the current switch was requested — as long as neither has
  // moved on, the switch is still in flight. `undefined` means no switch is being tracked.
  private readonly modelBeforeSwitch = signal<string | null | undefined>(undefined);
  private readonly stateBeforeSwitch = signal<SessionState | undefined>(undefined);
  // The daemon persists the model (and emits session.model_changed) before or while the relaunch it
  // triggers is still starting, so the model alone landing is not proof the switch is done — only the
  // relaunch's own state transition (leaving 'starting') or the turn ending (idle/closed) is.
  private readonly sawStartingSinceSwitch = signal(false);

  constructor() {
    // A route param change reuses this component instance: the session being left keeps its pending
    // switch in the service, the session arriving gets its own back.
    effect(() => {
      const sessionId = this.sessionId();
      untracked(() => this.parkPendingSwitchOfShownSession());
      this.shownSessionId = sessionId;
      const pending = this.pendingSwitches.recall(sessionId, 'model');
      const currentModel = untracked(() => this.session()?.model) ?? 'sonnet';
      this.chosenRung = pending?.requestedValue ?? currentModel;
      this.confirmedRung = this.chosenRung;
      this.applying.set(false);
      this.switchStatus.set(pending?.status ?? null);
      this.switchError.set(null);
      this.modelBeforeSwitch.set(pending ? pending.valueBeforeSwitch : undefined);
      this.stateBeforeSwitch.set(pending?.stateBeforeSwitch);
      this.sawStartingSinceSwitch.set(pending?.sawStartingSinceSwitch ?? false);
      this.pendingModelSwitch.emit(pending?.status === 'deferred');
    });
    inject(DestroyRef).onDestroy(() => this.parkPendingSwitchOfShownSession());

    // Clears "restarting…" / "switch pending" once the relaunch it describes has actually settled
    // (passed through 'starting' and moved on) or the session reached idle/closed since the request,
    // so the note never sits there forever. session.model_changed alone is not proof: the daemon emits
    // it before or while the relaunch is still starting, so clearing on it would drop the note early.
    effect(() => {
      const requestedFrom = this.modelBeforeSwitch();
      if (requestedFrom === undefined) return;
      const session = this.session();
      if (!session) return;
      if (session.state === 'starting') {
        this.sawStartingSinceSwitch.set(true);
        return;
      }
      const relaunchSettled = this.sawStartingSinceSwitch();
      const turnEndSettled = (session.state === 'idle' || session.state === 'closed') && session.state !== this.stateBeforeSwitch();
      if (!relaunchSettled && !turnEndSettled) return;
      this.switchStatus.set(null);
      this.modelBeforeSwitch.set(undefined);
      this.stateBeforeSwitch.set(undefined);
      this.sawStartingSinceSwitch.set(false);
      this.pendingModelSwitch.emit(false);
    });
  }

  session() {
    return this.events.sessions().find((s) => s.id === this.sessionId());
  }

  private parkPendingSwitchOfShownSession(): void {
    if (this.shownSessionId === undefined) return;
    this.pendingSwitches.park(this.shownSessionId, 'model', {
      status: this.switchStatus(),
      requestedValue: this.confirmedRung,
      valueBeforeSwitch: this.modelBeforeSwitch(),
      stateBeforeSwitch: this.stateBeforeSwitch(),
      sawStartingSinceSwitch: this.sawStartingSinceSwitch(),
    });
  }

  statusLabel(status: 'relaunching' | 'deferred'): string {
    return SWITCH_STATUS_LABEL[status];
  }

  async apply(): Promise<void> {
    const sessionIdAtApply = this.sessionId();
    const modelAtApply = this.session()?.model ?? null;
    const stateAtApply = this.session()?.state;
    const attemptedRung = this.chosenRung;
    await runGuarded(this.applying, this.switchError, MODEL_SWITCH_ERROR, async () => {
      let result: { status: 'relaunching' | 'deferred' };
      try {
        result = await this.api.updateModel(sessionIdAtApply, attemptedRung);
      } catch (error) {
        if (this.sessionId() !== sessionIdAtApply) return;
        this.chosenRung = this.confirmedRung;
        throw error;
      }
      if (this.sessionId() !== sessionIdAtApply) return;
      this.confirmedRung = attemptedRung;
      this.modelBeforeSwitch.set(modelAtApply);
      this.stateBeforeSwitch.set(stateAtApply);
      this.switchStatus.set(result.status);
      this.pendingModelSwitch.emit(result.status === 'deferred');
    });
  }
}
