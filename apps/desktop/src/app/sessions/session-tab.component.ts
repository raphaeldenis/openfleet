import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { FleetEventsService } from '../core/fleet-events.service';
import { StatePanelComponent } from '../working-state/state-panel.component';
import { SessionDetailsComponent } from './session-details.component';

/** The right panel's Session tab: the selected session's identity and actions, then its working state. */
@Component({
  selector: 'of-session-tab',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [SessionDetailsComponent, StatePanelComponent],
  template: `
    <div class="tab" role="region" aria-label="Session" data-testid="session-tab">
      @if (session(); as s) {
        <of-session-details [session]="s" />
        <of-state-panel [session]="s" />
      } @else {
        <p class="message" data-testid="session-tab-no-session">Select a session to see its details.</p>
      }
    </div>
  `,
  styles: `
    :host { flex: 1; min-height: 0; display: flex; flex-direction: column; }
    .tab { flex: 1; min-height: 0; overflow-y: auto; }
    .message { margin: 0; padding: .75rem; font-size: .8125rem; color: var(--mut); }
  `,
})
export class SessionTabComponent {
  readonly sessionId = input<string | undefined>();
  private readonly events = inject(FleetEventsService);
  protected readonly session = computed(() => this.events.sessions().find((session) => session.id === this.sessionId()));
}
