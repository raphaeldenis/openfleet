import { ChangeDetectionStrategy, Component, computed, effect, inject, input, linkedSignal, signal } from '@angular/core';
import { MODEL_ID_MAX_LENGTH, ModelIdSchema } from '@openfleet/shared';
import { FleetApiService } from '../core/fleet-api.service';
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
                [attr.aria-label]="rung"
                [attr.aria-description]="modelTable()[rung] ?? null"
                [attr.aria-selected]="rung === rungInForce()"
                [attr.tabindex]="index === focusableRungIndex() ? 0 : -1"
                [attr.data-initial-focus]="index === focusableRungIndex() ? '' : null"
                [attr.title]="'Switching to ' + rung + ' restarts this session with its history, ~3 s'"
                (click)="choose({ model: rung, popover })"
              >
                <span class="rung-name">{{ rung }}</span>
                @if (modelTable()[rung]; as modelId) {
                  <span class="mapped-id">{{ modelId }}</span>
                }
                <span class="check" aria-hidden="true">{{ rung === rungInForce() ? '✓' : '' }}</span>
              </button>
            }
          </div>
          @if (isMappingLoading()) {
            <p class="mapping-note" role="status">Loading model ids…</p>
          }
          @if (hasMappingFailed()) {
            <div class="mapping-error" role="alert">
              <of-error-line>Model ids could not be loaded — try again.</of-error-line>
              <button type="button" class="of-btn of-btn--compact of-btn--secondary" data-testid="model-mapping-retry" (click)="loadModelTable()">Try again</button>
            </div>
          }
          <div class="exact-id-row">
            <input
              type="text"
              class="of-input exact-id-input"
              data-testid="exact-model-id"
              aria-label="Exact model id"
              placeholder="Exact model id…"
              [maxLength]="modelIdMaxLength"
              [value]="exactModelId()"
              [disabled]="applying()"
              [attr.aria-invalid]="isExactModelIdInvalid() ? 'true' : null"
              (input)="updateExactModelId($event)"
              (keydown.enter)="useExactModelId({ popover, event: $event })"
            />
            <button type="button" class="of-btn of-btn--compact of-btn--secondary" data-testid="use-model-id" [disabled]="applying() || !parsedExactModelId().success" (click)="useExactModelId({ popover })">Use id</button>
          </div>
          @if (isExactModelIdInvalid()) {
            <of-error-line class="exact-id-error" role="alert">Enter a model id without spaces or control characters, starting with a letter or number.</of-error-line>
          }
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
      display: flex; align-items: center; gap: .5rem; min-height: 1.875rem; width: 100%; padding: .25rem .5rem; border: 0; border-radius: .375rem;
      background: transparent; color: var(--fg); font-family: var(--mono); font-size: .75rem; font-weight: 500; text-align: left; cursor: pointer;
    }
    .rung[aria-selected='true'] { background: var(--hover); }
    .rung:hover { background: var(--hover); }
    .rung:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
    .rung-name { flex: 0 0 3.5rem; min-width: 0; overflow-wrap: anywhere; }
    .mapped-id { flex: 1; min-width: 0; overflow-wrap: anywhere; font-size: .6875rem; font-weight: 400; color: var(--mut); }
    .mapping-note { margin: .25rem .5rem; font-size: .6875rem; color: var(--mut); }
    .mapping-error { display: flex; flex-wrap: wrap; align-items: center; gap: .375rem; padding: .25rem .5rem; font-size: .6875rem; color: var(--fg); }
    .exact-id-row { display: flex; flex-wrap: wrap; align-items: center; gap: .375rem; margin-top: .25rem; padding: .375rem .25rem .125rem; border-top: 1px solid var(--line); }
    .exact-id-input { flex: 1; min-width: 0; font-family: var(--mono); font-size: .6875rem; }
    .exact-id-error { padding: .25rem .5rem; font-size: .6875rem; color: var(--fg); }
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
  private readonly api = inject(FleetApiService);
  protected readonly modelTable = signal<Record<string, string>>({});
  protected readonly isMappingLoading = signal(false);
  protected readonly hasMappingFailed = signal(false);
  private mappingRequestVersion = 0;
  protected readonly rungsHeading = RUNGS_HEADING;
  protected readonly switchNote = SWITCH_NOTE;
  protected readonly pendingSwitchTooltip = PENDING_SWITCH_TOOLTIP;
  protected readonly moveFocusWithinListbox = moveFocusWithinListbox;
  protected readonly isOpen = linkedSignal<string, boolean>({ source: this.sessionId, computation: () => false });
  protected readonly modelIdMaxLength = MODEL_ID_MAX_LENGTH;
  protected readonly exactModelId = linkedSignal<string, string>({ source: this.sessionId, computation: () => '' });
  protected readonly parsedExactModelId = computed(() => ModelIdSchema.safeParse(this.exactModelId()));
  protected readonly isExactModelIdInvalid = computed(() => {
    const hasModelId = this.exactModelId().trim().length > 0;
    return hasModelId && !this.parsedExactModelId().success;
  });
  protected readonly session = computed(() => this.events.sessions().find((s) => s.id === this.sessionId()));
  protected readonly modelLabel = computed(() => this.session()?.model ?? NO_MODEL_LABEL);
  protected readonly rungs = computed((): readonly string[] => {
    const model = this.session()?.model;
    return model && !(MODEL_RUNGS as readonly string[]).includes(model) ? [...MODEL_RUNGS, model] : MODEL_RUNGS;
  });
  private readonly pending = computed(() => this.pendingSwitches.pendingOf(this.sessionId(), 'model'));
  protected readonly pendingRung = computed(() => this.pending()?.requestedValue);
  protected readonly rungInForce = computed(() => this.pendingRung() ?? this.session()?.model);
  protected readonly focusableRungIndex = computed(() => Math.max(this.rungs().indexOf(this.rungInForce() ?? ''), 0));
  protected readonly switchStatus = computed(() => this.pending()?.status ?? null);
  protected readonly applying = computed(() => this.requests.isBusy(this.sessionId(), 'model'));
  protected readonly switchError = computed(() => this.requests.errorOf(this.sessionId(), 'model'));

  constructor() {
    effect((onCleanup) => {
      if (!this.isOpen()) return;
      void this.loadModelTable();
      onCleanup(() => this.mappingRequestVersion++);
    });
  }

  protected async loadModelTable(): Promise<void> {
    const requestVersion = ++this.mappingRequestVersion;
    this.isMappingLoading.set(true);
    this.hasMappingFailed.set(false);
    this.modelTable.set({});
    try {
      const table = await this.api.models();
      if (requestVersion !== this.mappingRequestVersion) return;
      this.modelTable.set(table);
    } catch {
      if (requestVersion !== this.mappingRequestVersion) return;
      this.hasMappingFailed.set(true);
    } finally {
      if (requestVersion === this.mappingRequestVersion) this.isMappingLoading.set(false);
    }
  }

  protected updateExactModelId(event: Event): void {
    this.exactModelId.set((event.target as HTMLInputElement).value);
  }

  protected useExactModelId({ popover, event }: { popover: PopoverComponent; event?: Event }): void {
    event?.preventDefault();
    const parsedModelId = this.parsedExactModelId();
    if (!parsedModelId.success) return;
    this.choose({ model: parsedModelId.data, popover });
  }

  protected choose({ model, popover }: { model: string; popover: PopoverComponent }): void {
    popover.close();
    const isAlreadyInForce = model === this.rungInForce();
    if (isAlreadyInForce || this.applying()) return;
    void this.pendingSwitches.request({ sessionId: this.sessionId(), kind: 'model', value: model });
  }
}
