import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import type { Session } from '@openfleet/shared';
import { FleetEventsService } from '../core/fleet-events.service';
import { BannerComponent } from '../design/banner.component';
import { ComposerComponent } from './composer.component';
import { PermissionGateCardComponent } from './permission-gate-card.component';
import { SessionHeaderComponent } from './session-header.component';
import { TerminalComponent } from './terminal.component';

// Resuming a closed session has no REST route yet (checked against packages/core/src/api/restHandlers.ts
// on 2026-09-26 — only /close exists, nothing re-launches a closed one). The Resume action renders
// disabled with this explanation until that route exists.
const RESUME_TOOLTIP = "Resuming a closed session isn't available yet — no backend route for it.";

@Component({
  selector: 'of-session-view',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [SessionHeaderComponent, TerminalComponent, PermissionGateCardComponent, ComposerComponent, BannerComponent],
  template: `
    @if (session(); as s) {
      <div class="session-view" data-testid="session-view">
        <of-session-header [session]="s" />
        <div class="terminal-area">
          <of-terminal [sessionId]="s.id" />
          @if (pendingApproval(); as approval) {
            <of-permission-gate-card [approval]="approval" />
          }
        </div>
        @if (s.state === 'closed') {
          <div class="closed-footer" data-testid="session-closed-footer">
            <of-banner [variant]="s.exitCode === 0 ? 'done' : 'error'" [title]="closedTitle(s)" [description]="closedDescription(s)" />
            <button type="button" class="of-btn of-btn--secondary" data-testid="resume-session" disabled [title]="resumeTooltip">
              ↻ Resume
            </button>
          </div>
        } @else {
          <of-composer [sessionId]="s.id" />
        }
      </div>
    } @else {
      <p data-testid="session-view-not-found">Session not found.</p>
    }
  `,
  styles: `
    .session-view { display: flex; flex-direction: column; height: 100%; min-height: 0; }
    .terminal-area { flex: 1; min-height: 0; display: flex; flex-direction: column; gap: .625rem; padding: .5rem; }
    .closed-footer { display: flex; align-items: center; gap: .625rem; padding: .5rem .75rem; }
  `,
})
export class SessionViewComponent {
  readonly sessionId = input.required<string>();
  private readonly events = inject(FleetEventsService);
  protected readonly resumeTooltip = RESUME_TOOLTIP;

  protected readonly session = computed(() => this.events.sessions().find((s) => s.id === this.sessionId()));

  protected readonly pendingApproval = computed(() => {
    const session = this.session();
    if (!session || session.state !== 'waiting_permission') return undefined;
    return this.events.approvals().find((a) => a.sessionId === session.id && a.status === 'pending');
  });

  protected closedTitle(session: Session): string {
    return session.exitCode === 0 ? '■ Closed · exit 0' : `■ Closed · exit ${session.exitCode ?? 1}`;
  }

  protected closedDescription(session: Session): string {
    return session.exitCode === 0
      ? 'Closed · worktree kept · transcript is read-only.'
      : 'The session exited with an error · worktree kept · transcript is read-only.';
  }
}
