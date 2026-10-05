import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { WORKING_STATE_SECTIONS, type Session } from '@openfleet/shared';
import { FleetEventsService } from '../core/fleet-events.service';
import { OverdueChipComponent } from './overdue-chip.component';
import { StateSectionComponent } from './state-section.component';
import { SECTION_HEADINGS, ageInWholeMinutes, hasReadableUpdatedAt, tickingNow } from './working-state-freshness';
import { injectOverdue } from './working-state-overdue';

@Component({
  selector: 'of-state-panel',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [OverdueChipComponent, StateSectionComponent],
  template: `
    <div class="panel" data-testid="state-panel">
      <div class="head">
        <span class="title">State</span>
        @if (updatedLabel(); as label) {
          <span class="updated" data-testid="state-panel-updated">{{ label }}</span>
        }
        <of-overdue-chip [session]="session()" />
      </div>
      @if (overdue(); as overdue) {
        <p class="reason">
          @if (overdue.reason === 'fleet_changed') {
            <span class="stale" data-testid="state-panel-stale">stale</span>
          }
          <span data-testid="state-panel-overdue-reason">{{ overdue.explanation }}</span>
        </p>
      }
      <div class="body" role="region" aria-label="Working state" data-testid="state-panel-body">
        @if (state(); as state) {
          @for (key of sectionKeys; track key) {
            <of-state-section [sectionKey]="key" [heading]="headings[key]" [items]="state[key]" />
          }
        } @else {
          <p class="none" data-testid="state-panel-none">{{ noStateMessage() }}</p>
        }
      </div>
    </div>
  `,
  styles: `
    :host { display: block; min-width: 0; }
    .panel { display: flex; flex-direction: column; background: var(--panel); }
    .head { display: flex; align-items: center; gap: .5rem; min-width: 0; padding: .5rem .75rem; font-size: .75rem; }
    .title { flex: none; font-weight: 600; }
    .updated { flex: 1; min-width: 0; color: var(--mut); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .reason { display: flex; align-items: baseline; gap: .375rem; flex-wrap: wrap; margin: 0; padding: 0 .75rem .375rem; font-size: .6875rem; color: var(--mut); overflow-wrap: anywhere; }
    .stale { font-family: var(--mono); font-weight: 600; color: var(--fg); }
    .body { display: flex; flex-direction: column; gap: .75rem; padding: .5rem .75rem .75rem; border-top: 1px solid var(--line); }
    .none { margin: 0; font-size: .75rem; color: var(--mut); }
  `,
})
export class StatePanelComponent {
  readonly session = input.required<Session>();
  private readonly events = inject(FleetEventsService);
  private readonly now = tickingNow();
  protected readonly sectionKeys = WORKING_STATE_SECTIONS;
  protected readonly headings = SECTION_HEADINGS;
  protected readonly overdue = injectOverdue(() => this.session());
  protected readonly state = computed(() => this.events.workingStates().get(this.session().id));

  protected readonly updatedLabel = computed(() => {
    const state = this.state();
    if (!state) return '';
    if (!hasReadableUpdatedAt(state)) return 'updated time unknown';
    const minutes = ageInWholeMinutes(state, this.now());
    return minutes < 1 ? 'updated just now' : `updated ${minutes} min ago`;
  });

  protected readonly noStateMessage = computed(() => {
    if (!this.events.workingStatesReported()) return 'State not reported by this daemon';
    return this.session().state === 'closed' ? 'State not shown for a closed session' : 'No state recorded yet';
  });
}
