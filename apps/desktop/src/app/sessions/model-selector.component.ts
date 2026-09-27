import { ChangeDetectionStrategy, Component, effect, inject, input, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import type { SessionState } from '@openfleet/shared';
import { FleetApiService } from '../core/fleet-api.service';
import { FleetEventsService } from '../core/fleet-events.service';

const MODEL_SWITCH_ERROR = 'Could not switch model — try again.';

const MODEL_RUNGS = ['haiku', 'sonnet', 'opus', 'fable'] as const;

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
      <select data-testid="model-select" [(ngModel)]="chosenRung">
        @for (rung of rungs; track rung) {
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
  readonly rungs = MODEL_RUNGS;
  chosenRung: (typeof MODEL_RUNGS)[number] = 'sonnet';
  readonly applying = signal(false);
  readonly switchStatus = signal<'relaunching' | 'deferred' | null>(null);
  readonly switchError = signal<string | null>(null);
  // The model and state in effect when the current switch was requested — as long as neither has
  // moved on, the switch is still in flight. `undefined` means no switch is being tracked.
  private readonly modelBeforeSwitch = signal<string | null | undefined>(undefined);
  private readonly stateBeforeSwitch = signal<SessionState | undefined>(undefined);

  constructor() {
    // A route param change reuses this component instance, so a session switch must not leak
    // the previous session's in-flight state or result into the one now shown.
    effect(() => {
      this.sessionId();
      this.chosenRung = 'sonnet';
      this.applying.set(false);
      this.switchStatus.set(null);
      this.switchError.set(null);
      this.modelBeforeSwitch.set(undefined);
      this.stateBeforeSwitch.set(undefined);
      this.pendingModelSwitch.emit(false);
    });

    // Clears "restarting…" / "switch pending" once the switch it describes has actually landed
    // (the model changed) or the session moved on to idle/closed since the request, so the note
    // never sits there forever. A session already idle when the switch was requested must still
    // observe a real transition, not just its already-idle starting state.
    effect(() => {
      const requestedFrom = this.modelBeforeSwitch();
      if (requestedFrom === undefined) return;
      const session = this.session();
      if (!session) return;
      const switchLanded = (session.model ?? null) !== requestedFrom;
      const settledSinceRequest = (session.state === 'idle' || session.state === 'closed') && session.state !== this.stateBeforeSwitch();
      if (!switchLanded && !settledSinceRequest) return;
      this.switchStatus.set(null);
      this.modelBeforeSwitch.set(undefined);
      this.stateBeforeSwitch.set(undefined);
    });
  }

  session() {
    return this.events.sessions().find((s) => s.id === this.sessionId());
  }

  statusLabel(status: 'relaunching' | 'deferred'): string {
    return SWITCH_STATUS_LABEL[status];
  }

  async apply(): Promise<void> {
    if (this.applying()) return;
    this.applying.set(true);
    this.switchError.set(null);
    const sessionIdAtApply = this.sessionId();
    const modelAtApply = this.session()?.model ?? null;
    const stateAtApply = this.session()?.state;
    try {
      const result = await this.api.updateModel(sessionIdAtApply, this.chosenRung);
      if (this.sessionId() !== sessionIdAtApply) return;
      this.modelBeforeSwitch.set(modelAtApply);
      this.stateBeforeSwitch.set(stateAtApply);
      this.switchStatus.set(result.status);
      this.pendingModelSwitch.emit(result.status === 'deferred');
    } catch {
      if (this.sessionId() !== sessionIdAtApply) return;
      this.switchError.set(MODEL_SWITCH_ERROR);
    } finally {
      if (this.sessionId() === sessionIdAtApply) this.applying.set(false);
    }
  }
}
