import { ChangeDetectionStrategy, Component, computed, effect, inject, input, signal } from '@angular/core';
import type { Session } from '@openfleet/shared';
import { ApiError, FleetApiService } from '../core/fleet-api.service';
import { FleetEventsService } from '../core/fleet-events.service';
import { runGuarded } from '../core/run-guarded';
import { BannerComponent, BannerVariant } from '../design/banner.component';
import { ComposerComponent } from './composer.component';
import { PermissionGateCardComponent } from './permission-gate-card.component';
import { closeStatusFor, reopenErrorMessage } from './session-close-status';
import { SessionHeaderComponent } from './session-header.component';
import { TerminalComponent } from './terminal.component';

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
            <of-banner [variant]="closedVariant(s)" [title]="closedTitle(s)" [description]="closedDescription(s)" />
            <button type="button" class="of-btn of-btn--secondary" data-testid="resume-session" [disabled]="resuming()" (click)="resume(s.id)">
              ↻ Resume
            </button>
            @if (resumeError(); as error) {
              <span role="alert" data-testid="resume-error" class="of-error">✕ {{ error }}</span>
            }
          </div>
        } @else {
          <of-composer [sessionId]="s.id" [busy]="s.state === 'generating'" />
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
  private readonly api = inject(FleetApiService);
  protected readonly resuming = signal(false);
  protected readonly resumeError = signal<string | null>(null);

  protected readonly session = computed(() => this.events.sessions().find((s) => s.id === this.sessionId()));

  protected readonly pendingApproval = computed(() => {
    const session = this.session();
    if (!session || session.state !== 'waiting_permission') return undefined;
    return this.events.approvals().find((a) => a.sessionId === session.id && a.status === 'pending');
  });

  constructor() {
    // A route param change reuses this component instance, so a session switch must not leak the
    // previous session's in-flight resume or resume error into the one now shown.
    effect(() => {
      this.sessionId();
      this.resuming.set(false);
      this.resumeError.set(null);
    });
  }

  async resume(sessionId: string): Promise<void> {
    await runGuarded(
      this.resuming,
      this.resumeError,
      (error) => reopenErrorMessage(error instanceof ApiError ? error.code : undefined),
      async () => { await this.api.reopenSession(sessionId); },
    );
  }

  protected closedVariant(session: Session): BannerVariant {
    return closeStatusFor(session.exitCode).kind === 'failed' ? 'error' : 'done';
  }

  protected closedTitle(session: Session): string {
    const status = closeStatusFor(session.exitCode);
    if (status.kind === 'unknown') return '■ Session closed';
    return status.kind === 'clean' ? '■ Closed · exit 0' : `■ Closed · exit ${status.exitCode}`;
  }

  protected closedDescription(session: Session): string {
    const status = closeStatusFor(session.exitCode);
    if (status.kind === 'unknown') return 'Session closed · worktree kept · transcript is read-only.';
    return status.kind === 'clean'
      ? 'Closed · worktree kept · transcript is read-only.'
      : 'The session exited with an error · worktree kept · transcript is read-only.';
  }
}
