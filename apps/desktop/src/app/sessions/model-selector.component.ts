import { ChangeDetectionStrategy, Component, computed, inject, input, linkedSignal } from '@angular/core';
import { ErrorLineComponent } from '../design/error-line.component';
import { moveFocusWithinListbox } from '../design/listbox-keyboard';
import { PopoverComponent } from '../design/popover.component';
import { FleetEventsService } from '../core/fleet-events.service';
import { PendingSwitchesService } from '../core/pending-switches.service';
import { SessionRequestsService } from '../core/session-requests';

export const MODEL_RUNGS = ['haiku', 'sonnet', 'opus', 'fable'] as const;

const RUNGS_HEADING = 'Rungs · mapped in Settings → Models';
const SWITCH_NOTE = 'Switching restarts this session on the new model with its history, ~3 s. Never a silent in-place swap.';
const PENDING_SWITCH_TOOLTIP =
  'The switch restarts the session on the new model as soon as this turn ends. Closing the session first cancels the switch: it ends closed.';
const NO_MODEL_LABEL = 'default';

@Component({
  selector: 'of-model-selector',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ErrorLineComponent, PopoverComponent],
  template: `
    <div class="model-selector" data-testid="model-selector">
      <of-popover
        #popover
        [(open)]="isOpen"
        triggerTestId="model-trigger"
        [triggerLabel]="'Model: ' + modelLabel()"
        [triggerTitle]="'Model: ' + modelLabel()"
        width="19rem"
        [disabled]="applying()"
      >
        <span popoverTrigger class="current" data-testid="current-model">{{ modelLabel() }}</span>
        <ng-template>
          <div class="heading">{{ rungsHeading }}</div>
          <div role="listbox" aria-label="Model" #listbox (keydown)="moveFocusWithinListbox($event, listbox)">
            @for (rung of rungs(); track rung; let index = $index) {
              <button
                type="button"
                role="option"
                class="rung"
                [attr.aria-selected]="rung === rungInForce()"
                [attr.tabindex]="index === focusableRungIndex() ? 0 : -1"
                [attr.data-initial-focus]="index === focusableRungIndex() ? '' : null"
                [attr.title]="'Switching to ' + rung + ' restarts this session with its history, ~3 s'"
                (click)="choose(rung, popover)"
              >
                <span class="rung-name">{{ rung }}</span>
                <span class="check" aria-hidden="true">{{ rung === rungInForce() ? '✓' : '' }}</span>
              </button>
            }
          </div>
          <p class="switch-note">{{ switchNote }}</p>
        </ng-template>
      </of-popover>
      @switch (switchStatus()) {
        @case ('relaunching') {
          <span class="restarting" data-testid="model-switch-status"><span class="status-icon" aria-hidden="true">↻</span>restarting…</span>
        }
        @case ('deferred') {
          <span class="pending-chip" data-testid="model-switch-status" [attr.title]="pendingSwitchTooltip">
            <span class="status-icon" aria-hidden="true">↻</span>switch pending → {{ pendingRung() }} · happens when this turn ends
          </span>
        }
      }
      @if (switchError(); as error) {
        <of-error-line role="alert" data-testid="model-switch-error">{{ error }}</of-error-line>
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
            <span class="drift">
              <span class="drift-icon" aria-hidden="true">⚠</span>
              <span class="drift-text" data-testid="model-drift">changed from {{ current.modelDriftedFrom }}</span>
            </span>
          }
        </div>
      }
    </div>
  `,
  styles: `
    :host { flex: 1 1 auto; }
    .model-selector { display: flex; flex-wrap: wrap; align-items: center; gap: .375rem; min-width: 0; }
    .resolution { flex-basis: 100%; min-width: 0; contain: inline-size; display: flex; flex-wrap: wrap; gap: .125rem .5rem; font-family: var(--mono); font-size: .6875rem; color: var(--mut); overflow-wrap: anywhere; }
    .resolution:empty { display: none; }
    .drift { display: inline-flex; gap: .25rem; min-width: 0; color: var(--fg); }
    .drift-icon { color: var(--state-waiting-permission); }
    .current { font-size: .75rem; }
    .heading { padding: .25rem .5rem; font-size: .6875rem; color: var(--mut); }
    .rung {
      display: flex; align-items: center; gap: .5rem; height: 1.875rem; padding: 0 .5rem; border: 0; border-radius: .375rem;
      background: transparent; color: var(--fg); font-family: var(--mono); font-size: .75rem; font-weight: 500; text-align: left; cursor: pointer;
    }
    .rung[aria-selected='true'] { background: var(--hover); }
    .rung:hover { background: var(--hover); }
    .rung:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
    .rung-name { flex: 1; min-width: 0; overflow-wrap: anywhere; }
    .check { color: var(--accent); }
    .switch-note { margin: .25rem 0 0; padding: .375rem .5rem 0; border-top: 1px solid var(--line); font-size: .6875rem; color: var(--mut); text-wrap: pretty; }
    .restarting, .pending-chip {
      display: inline-flex; align-items: center; height: 1.5rem; padding: 0 .5rem; border-radius: .375rem;
      font-size: .6875rem; white-space: nowrap; color: var(--fg);
    }
    .restarting { border: 1px solid var(--line); background: var(--sunk); }
    .pending-chip {
      border: 1px solid color-mix(in oklch, var(--state-waiting-permission) 45%, transparent);
      background: color-mix(in oklch, var(--state-waiting-permission) 14%, transparent);
    }
    .status-icon { margin-right: .3125rem; color: var(--state-waiting-permission); }
  `,
})
export class ModelSelectorComponent {
  readonly sessionId = input.required<string>();
  private readonly events = inject(FleetEventsService);
  private readonly pendingSwitches = inject(PendingSwitchesService);
  private readonly requests = inject(SessionRequestsService);
  protected readonly rungsHeading = RUNGS_HEADING;
  protected readonly switchNote = SWITCH_NOTE;
  protected readonly pendingSwitchTooltip = PENDING_SWITCH_TOOLTIP;
  protected readonly moveFocusWithinListbox = moveFocusWithinListbox;
  // A route param change reuses this instance, so a session switch closes the list.
  protected readonly isOpen = linkedSignal<string, boolean>({ source: this.sessionId, computation: () => false });
  protected readonly session = computed(() => this.events.sessions().find((s) => s.id === this.sessionId()));
  protected readonly modelLabel = computed(() => this.session()?.model ?? NO_MODEL_LABEL);
  // The session's current model is either a rung alias (e.g. 'opus') or a full model id (e.g. 'claude-opus-5-5').
  // A full id matches no fixed rung, so it is listed as its own row instead of being forced onto a rung
  // that would silently apply a different model.
  protected readonly rungs = computed((): readonly string[] => {
    const model = this.session()?.model;
    return model && !(MODEL_RUNGS as readonly string[]).includes(model) ? [...MODEL_RUNGS, model] : MODEL_RUNGS;
  });
  private readonly pending = computed(() => this.pendingSwitches.pendingOf(this.sessionId(), 'model'));
  protected readonly pendingRung = computed(() => this.pending()?.requestedValue);
  /** The rung the session runs on or is switching to: the one checked in the list. */
  protected readonly rungInForce = computed(() => this.pendingRung() ?? this.session()?.model);
  protected readonly focusableRungIndex = computed(() => Math.max(this.rungs().indexOf(this.rungInForce() ?? ''), 0));
  protected readonly switchStatus = computed(() => this.pending()?.status ?? null);
  protected readonly applying = computed(() => this.requests.isBusy(this.sessionId(), 'model'));
  protected readonly switchError = computed(() => this.requests.errorOf(this.sessionId(), 'model'));

  protected choose(rung: string, popover: PopoverComponent): void {
    popover.close();
    const isAlreadyInForce = rung === this.rungInForce();
    if (isAlreadyInForce || this.applying()) return;
    void this.pendingSwitches.request({ sessionId: this.sessionId(), kind: 'model', value: rung });
  }
}
