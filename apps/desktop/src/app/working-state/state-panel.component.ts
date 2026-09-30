import { ChangeDetectionStrategy, Component, ElementRef, computed, inject, input, linkedSignal, viewChild } from '@angular/core';
import { WORKING_STATE_SECTIONS, type Session } from '@openfleet/shared';
import { FleetEventsService } from '../core/fleet-events.service';
import { OverdueChipComponent } from './overdue-chip.component';
import { StateSectionComponent } from './state-section.component';
import { SECTION_HEADINGS, ageInWholeMinutes, tickingNow } from './working-state-freshness';
import { injectOverdue } from './working-state-overdue';

const BODY_ID = 'state-panel-body';

@Component({
  selector: 'of-state-panel',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [OverdueChipComponent, StateSectionComponent],
  template: `
    <div class="panel" data-testid="state-panel" (keydown.escape)="closeAndReturnToToggle()">
      <button
        #toggleButton
        type="button"
        class="toggle"
        data-testid="state-panel-toggle"
        [attr.aria-expanded]="isOpen()"
        [attr.aria-controls]="bodyId"
        (click)="isOpen.set(!isOpen())"
      >
        <span class="caret" aria-hidden="true">{{ isOpen() ? '▾' : '▸' }}</span>
        <span class="title">State</span>
        @if (updatedLabel(); as label) {
          <span class="updated" data-testid="state-panel-updated">{{ label }}</span>
        }
        <of-overdue-chip [session]="session()" />
      </button>
      @if (overdue(); as overdue) {
        <p class="reason">
          @if (overdue.reason === 'fleet_changed') {
            <span class="stale" data-testid="state-panel-stale">stale</span>
          }
          <span data-testid="state-panel-overdue-reason">{{ overdue.explanation }}</span>
        </p>
      }
      @if (isOpen()) {
        <div class="body" [id]="bodyId" role="region" aria-label="Working state" tabindex="0" data-testid="state-panel-body">
          @if (state(); as state) {
            @for (key of sectionKeys; track key) {
              <of-state-section [sectionKey]="key" [heading]="headings[key]" [items]="state[key]" />
            }
          } @else {
            <p class="none" data-testid="state-panel-none">{{ noStateMessage() }}</p>
          }
        </div>
      }
    </div>
  `,
  styles: `
    :host { display: block; flex: none; min-width: 0; }
    .panel { display: flex; flex-direction: column; border-bottom: 1px solid var(--line); background: var(--panel); }
    .toggle {
      display: flex; align-items: center; gap: .5rem; min-width: 0; padding: .375rem 1rem; border: 0;
      background: transparent; color: var(--fg); font: inherit; font-size: .75rem; text-align: left; cursor: pointer;
    }
    .toggle:focus-visible, .body:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
    .caret { flex: none; color: var(--mut); }
    .title { flex: none; font-weight: 600; }
    .updated { flex: 1; min-width: 0; color: var(--mut); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .reason { display: flex; align-items: baseline; gap: .375rem; flex-wrap: wrap; margin: 0; padding: 0 1rem .375rem; font-size: .6875rem; color: var(--mut); overflow-wrap: anywhere; }
    .stale { font-family: var(--mono); font-weight: 600; color: var(--fg); }
    .body {
      display: flex; flex-direction: column; gap: .75rem; max-height: min(40vh, 20rem); overflow-y: auto;
      padding: .5rem 1rem .75rem; border-top: 1px solid var(--line);
    }
    .none { margin: 0; font-size: .75rem; color: var(--mut); }
  `,
})
export class StatePanelComponent {
  readonly session = input.required<Session>();
  private readonly events = inject(FleetEventsService);
  private readonly now = tickingNow();
  private readonly toggleButton = viewChild.required<ElementRef<HTMLButtonElement>>('toggleButton');
  protected readonly bodyId = BODY_ID;
  protected readonly sectionKeys = WORKING_STATE_SECTIONS;
  protected readonly headings = SECTION_HEADINGS;
  protected readonly isOpen = linkedSignal<string, boolean>({ source: () => this.session().id, computation: () => false });
  protected readonly overdue = injectOverdue(() => this.session());
  protected readonly state = computed(() => this.events.workingStates().get(this.session().id));

  protected readonly updatedLabel = computed(() => {
    const state = this.state();
    if (!state) return '';
    const minutes = ageInWholeMinutes(state, this.now());
    return minutes < 1 ? 'updated just now' : `updated ${minutes} min ago`;
  });

  protected readonly noStateMessage = computed(() => {
    if (!this.events.workingStatesReported()) return 'State not reported by this daemon';
    return this.session().state === 'closed' ? 'No state kept for a closed session' : 'No state recorded yet';
  });

  protected closeAndReturnToToggle(): void {
    if (!this.isOpen()) return;
    this.isOpen.set(false);
    this.toggleButton().nativeElement.focus();
  }
}
