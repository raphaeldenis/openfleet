import { ChangeDetectionStrategy, Component, computed, inject, input, resource } from '@angular/core';
import { WORKING_STATE_SECTIONS, type Session } from '@openfleet/shared';
import { clockTimeOf } from '../core/clock-time';
import { FleetApiService } from '../core/fleet-api.service';
import { FleetEventsService } from '../core/fleet-events.service';
import { StateSectionComponent } from './state-section.component';
import { SECTION_HEADINGS, ageInWholeMinutes, hasReadableUpdatedAt, tickingNow } from './working-state-freshness';
import { injectOverdue } from './working-state-overdue';

const lowercaseFirstLetter = (text: string): string => text.charAt(0).toLowerCase() + text.slice(1);

/** The State card of the Session tab: the six sections of the session's working state, with how fresh they are. */
@Component({
  selector: 'of-state-panel',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [StateSectionComponent],
  template: `
    <section class="panel" data-testid="state-panel" aria-label="State">
      <div class="head">
        <span class="title">State</span>
        @if (meta(); as meta) {
          <span class="meta" data-testid="state-panel-updated">{{ meta }}</span>
        }
      </div>
      @if (overdue(); as overdue) {
        <div class="callout" role="status" data-testid="state-panel-overdue">
          <span class="callout-glyph" aria-hidden="true">!</span>
          <span>
            @if (overdue.reason === 'fleet_changed') {
              <span class="stale" data-testid="state-panel-stale">stale</span>
            }
            state overdue — <span data-testid="state-panel-overdue-reason">{{ lowercaseFirstLetter(overdue.explanation) }}</span>
          </span>
        </div>
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
    </section>
  `,
  styles: `
    :host { display: block; min-width: 0; padding: 0 .625rem .625rem; }
    .panel { display: flex; flex-direction: column; gap: .5rem; padding: .625rem .75rem; border: 1px solid var(--line); border-radius: .625rem; background: var(--panel); }
    .head { display: flex; align-items: baseline; gap: .5rem; min-width: 0; }
    .title { flex: none; font-size: .8125rem; font-weight: 600; }
    .meta { flex: 1; min-width: 0; text-align: right; font-size: .6875rem; color: var(--mut); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .callout {
      display: flex; gap: .375rem; padding: .375rem .5rem; font-size: .75rem; color: var(--fg); text-wrap: pretty; overflow-wrap: anywhere;
      border: 1px solid color-mix(in oklch, var(--state-waiting-permission) 45%, transparent); border-radius: .375rem;
      background: color-mix(in oklch, var(--state-waiting-permission) 10%, var(--panel));
    }
    .callout-glyph { flex: none; color: var(--state-waiting-permission); }
    .stale { font-family: var(--mono); font-weight: 600; margin-right: .375rem; }
    .body { display: flex; flex-direction: column; gap: .5rem; }
    .none { margin: 0; font-size: .75rem; color: var(--mut); text-wrap: pretty; }
  `,
})
export class StatePanelComponent {
  readonly session = input.required<Session>();
  private readonly events = inject(FleetEventsService);
  private readonly api = inject(FleetApiService);
  private readonly now = tickingNow();
  protected readonly sectionKeys = WORKING_STATE_SECTIONS;
  protected readonly headings = SECTION_HEADINGS;
  protected readonly lowercaseFirstLetter = lowercaseFirstLetter;
  protected readonly overdue = injectOverdue(() => this.session());
  private readonly isClosed = computed(() => this.session().state === 'closed');
  /** The daemon keeps the last state of a closed session but leaves it out of the live feed. */
  private readonly lastStateOfClosedSession = resource({
    params: () => (this.isClosed() ? this.session().id : undefined),
    loader: ({ params: sessionId }) => this.api.getWorkingState(sessionId),
  });
  protected readonly state = computed(() => {
    const liveState = this.events.workingStates().get(this.session().id);
    if (liveState) return liveState;
    const hasLastState = this.isClosed() && this.lastStateOfClosedSession.hasValue();
    return hasLastState ? this.lastStateOfClosedSession.value() : undefined;
  });

  protected readonly meta = computed(() => {
    const state = this.state();
    if (!state) return '';
    if (this.isClosed()) return this.closedMetaOf(state.updatedAt);
    if (!hasReadableUpdatedAt(state)) return 'updated time unknown';
    const minutes = ageInWholeMinutes(state, this.now());
    return minutes < 1 ? 'updated just now' : `updated ${minutes} min ago`;
  });

  protected readonly noStateMessage = computed(() => {
    if (!this.events.workingStatesReported()) return 'State not reported by this daemon';
    if (!this.isClosed()) return 'No state recorded yet';
    if (this.lastStateOfClosedSession.isLoading()) return 'Loading the last state…';
    if (this.lastStateOfClosedSession.error()) return 'The last state could not be read.';
    return 'No state was recorded before this session closed.';
  });

  private closedMetaOf(updatedAt: string): string {
    const writtenAt = clockTimeOf(updatedAt);
    return writtenAt ? `last state · read-only · ${writtenAt}` : 'last state · read-only';
  }
}
