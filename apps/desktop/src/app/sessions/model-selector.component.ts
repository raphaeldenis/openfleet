import { ChangeDetectionStrategy, Component, computed, inject, input, linkedSignal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { FleetEventsService } from '../core/fleet-events.service';
import { PendingSwitchesService, SWITCH_STATUS_LABEL } from '../core/pending-switches.service';
import { SessionRequestsService } from '../core/session-requests';

export const MODEL_RUNGS = ['haiku', 'sonnet', 'opus', 'fable'] as const;

const FALLBACK_RUNG = 'sonnet';

@Component({
  selector: 'of-model-selector',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule],
  template: `
    <div class="model-selector" data-testid="model-selector">
      <span class="current" data-testid="current-model">{{ session()?.model ?? 'default' }}</span>
      <select class="of-input" data-testid="model-select" aria-label="Model" [ngModel]="shownRung()" (ngModelChange)="pickedRung.set($event)">
        @for (rung of rungs(); track rung) {
          <option [value]="rung">{{ rung }}</option>
        }
      </select>
      <button type="button" class="of-btn of-btn--secondary" data-testid="apply-model" [disabled]="applying()" (click)="apply()">Apply</button>
      @if (switchStatus(); as status) {
        <span class="switch-status" data-testid="model-switch-status">{{ statusLabel[status] }}</span>
      }
      @if (switchError(); as error) {
        <span role="alert" data-testid="model-switch-error" class="of-error">✕ {{ error }}</span>
      }
      @if (session(); as current) {
        <div class="resolution">
          @if (current.resolvedModel) {
            <span data-testid="resolved-model">resolved {{ current.resolvedModel }}</span>
          }
          @if (current.cliVersion) {
            <span data-testid="cli-version">CLI {{ current.cliVersion }}</span>
          }
          @if (current.modelDriftedFrom) {
            <span data-testid="model-drift">changed from {{ current.modelDriftedFrom }}</span>
          }
        </div>
      }
    </div>
  `,
  styles: `
    .model-selector { display: flex; flex-wrap: wrap; align-items: center; gap: .375rem; }
    .resolution { flex-basis: 100%; display: flex; gap: .5rem; font-family: var(--mono); font-size: .6875rem; color: var(--mut); }
    .resolution:empty { display: none; }
    .current { font-family: var(--mono); font-size: .75rem; }
    .switch-status { font-size: .6875rem; color: var(--state-waiting-permission); }
  `,
})
export class ModelSelectorComponent {
  readonly sessionId = input.required<string>();
  private readonly events = inject(FleetEventsService);
  private readonly pendingSwitches = inject(PendingSwitchesService);
  private readonly requests = inject(SessionRequestsService);
  protected readonly statusLabel = SWITCH_STATUS_LABEL;
  protected readonly session = computed(() => this.events.sessions().find((s) => s.id === this.sessionId()));
  // The session's current model is either a rung alias (e.g. 'opus') or a full model id (e.g. 'claude-opus-5-5').
  // A full id matches no fixed rung, so it is added as its own option instead of forcing the select
  // onto a rung that would silently apply a different model.
  protected readonly rungs = computed(() => {
    const model = this.session()?.model;
    return model && !(MODEL_RUNGS as readonly string[]).includes(model) ? [...MODEL_RUNGS, model] : MODEL_RUNGS;
  });
  // What the user picked and has not applied yet; a session switch starts from no pick.
  protected readonly pickedRung = linkedSignal<string, string | undefined>({ source: this.sessionId, computation: () => undefined });
  private readonly pending = computed(() => this.pendingSwitches.pendingOf(this.sessionId(), 'model'));
  protected readonly shownRung = computed(() => this.pickedRung() ?? this.pending()?.requestedValue ?? this.session()?.model ?? FALLBACK_RUNG);
  protected readonly switchStatus = computed(() => this.pending()?.status ?? null);
  protected readonly applying = computed(() => this.requests.isBusy(this.sessionId(), 'model'));
  protected readonly switchError = computed(() => this.requests.errorOf(this.sessionId(), 'model'));

  protected apply(): void {
    const value = this.shownRung();
    this.pickedRung.set(undefined);
    void this.pendingSwitches.request({ sessionId: this.sessionId(), kind: 'model', value });
  }
}
