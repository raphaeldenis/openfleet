import { ChangeDetectionStrategy, Component, computed, effect, inject, input, signal } from '@angular/core';
import type { Session } from '@openfleet/shared';
import { ApiError, FleetApiService } from '../core/fleet-api.service';
import { FleetEventsService } from '../core/fleet-events.service';
import { ComposerComponent } from './composer.component';
import { PermissionGateCardComponent } from './permission-gate-card.component';
import { closeStatusFor, reopenErrorMessage, resumeFailureReasonFor } from './session-close-status';
import { SessionHeaderComponent } from './session-header.component';
import { TerminalComponent } from './terminal.component';

const REOPEN_FRESH_UNAVAILABLE_TOOLTIP = 'Not available yet — the daemon cannot relaunch a session without its previous conversation.';

type LifecycleBanner = { kind: 'resuming' } | { kind: 'resume_failed'; reason: string };

@Component({
  selector: 'of-session-view',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [SessionHeaderComponent, TerminalComponent, PermissionGateCardComponent, ComposerComponent],
  template: `
    @if (session(); as s) {
      <div class="session-view" data-testid="session-view">
        <of-session-header [session]="s" />
        @if (lifecycleBanner(); as banner) {
          @if (banner.kind === 'resuming') {
            <div class="lifecycle-banner" data-testid="lifecycle-banner" data-variant="resuming" role="status">
              <span class="lifecycle-title">↻ Resuming…</span>
              <span class="lifecycle-body">Reattaching to the same conversation in the same worktree.</span>
            </div>
          } @else {
            <div class="lifecycle-banner" data-testid="lifecycle-banner" data-variant="error" role="alert">
              <span class="lifecycle-title">✕ Resume failed</span>
              <span class="lifecycle-body" data-testid="resume-error">{{ banner.reason }}</span>
              <button type="button" class="of-btn of-btn--primary" data-testid="resume-retry" (click)="resume(s.id)">↻ Retry</button>
              <button type="button" class="of-btn of-btn--secondary" data-testid="resume-failed-reopen-fresh" disabled [attr.title]="reopenFreshUnavailableTooltip">
                Reopen fresh
              </button>
            </div>
          }
        }
        <div class="terminal-area">
          <of-terminal [sessionId]="s.id" />
          @if (pendingApproval(); as approval) {
            <of-permission-gate-card [approval]="approval" />
          }
        </div>
        @if (s.state === 'closed') {
          @let showsCloseStatus = !lifecycleBanner();
          <div
            class="closed-footer"
            data-testid="session-closed-footer"
            [class.closed-footer--strip]="showsCloseStatus"
            [attr.data-variant]="showsCloseStatus ? closedVariant(s) : null"
            [attr.role]="showsCloseStatus ? closedRole(s) : null"
          >
            @if (showsCloseStatus) {
              <span class="closed-title">{{ closedTitle(s) }}</span>
              <span class="closed-body">{{ closedDescription(s) }}</span>
            }
            <button type="button" class="of-btn of-btn--primary" data-testid="resume-session" [disabled]="resuming()" (click)="resume(s.id)">
              ↻ Resume in worktree
            </button>
            @if (showsCloseStatus) {
              <button type="button" class="of-btn of-btn--secondary" data-testid="reopen-fresh-session" disabled [attr.title]="reopenFreshUnavailableTooltip">
                Reopen fresh
              </button>
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
    .closed-footer { display: flex; align-items: center; justify-content: flex-end; gap: .75rem; margin: 0 1rem 1rem; }
    .closed-footer--strip {
      justify-content: flex-start; padding: .75rem 1rem; border: 1px solid var(--line-2); border-radius: .5rem;
      background: var(--panel); font-size: .8125rem; --closed-color: var(--state-closed);
    }
    .closed-footer--strip[data-variant='error'] { --closed-color: var(--state-error); border-color: color-mix(in oklch, var(--state-error) 55%, transparent); }
    .closed-title { color: var(--closed-color); font-weight: 600; }
    .closed-body { flex: 1; min-width: 0; color: var(--mut); }
    .closed-footer .of-btn { height: 1.75rem; padding: 0 .75rem; font-size: .75rem; white-space: nowrap; }
    .lifecycle-banner .of-btn { flex: none; height: 1.5rem; padding: 0 .625rem; font-size: .6875rem; white-space: nowrap; }
    .lifecycle-banner {
      display: flex; align-items: center; gap: .75rem; padding: .5rem 1rem;
      border-bottom: 1px solid var(--line); font-size: .75rem;
      --lifecycle-color: var(--state-generating);
      background: color-mix(in oklch, var(--lifecycle-color) 10%, var(--panel));
    }
    .lifecycle-banner[data-variant='error'] { --lifecycle-color: var(--state-error); }
    .lifecycle-title { flex: none; color: var(--lifecycle-color); font-weight: 600; font-family: var(--mono); }
    .lifecycle-body { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  `,
})
export class SessionViewComponent {
  readonly sessionId = input.required<string>();
  private readonly events = inject(FleetEventsService);
  private readonly api = inject(FleetApiService);
  protected readonly resuming = signal(false);
  protected readonly resumeError = signal<string | null>(null);

  protected readonly session = computed(() => this.events.sessions().find((s) => s.id === this.sessionId()));

  protected readonly reopenFreshUnavailableTooltip = REOPEN_FRESH_UNAVAILABLE_TOOLTIP;

  protected readonly lifecycleBanner = computed<LifecycleBanner | undefined>(() => {
    const session = this.session();
    if (!session) return undefined;
    const isReopenRequestInFlight = this.resuming();
    const isClosedSessionRelaunching = session.state === 'starting' && session.closedAt !== undefined;
    if (isReopenRequestInFlight || isClosedSessionRelaunching) return { kind: 'resuming' };
    if (session.state !== 'closed') return undefined;
    const reason = this.resumeError() ?? resumeFailureReasonFor(session.exitCode);
    return reason ? { kind: 'resume_failed', reason } : undefined;
  });

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
    // A resume error belongs to the closed session it failed on: once the session is live again it
    // must not resurface on a later, clean close.
    effect(() => {
      const isLiveAgain = this.isLive(this.session());
      if (isLiveAgain) this.resumeError.set(null);
    });
  }

  private isLive(session: Session | undefined): boolean {
    return session !== undefined && session.state !== 'closed' && session.state !== 'starting';
  }

  // Ignores a reopen response for a session the user has since navigated away from: no error shown, and
  // (unlike runGuarded) no busy-flag reset — this component instance is reused across a route param
  // change, so `resuming`/`resumeError` already belong to whichever session is current by the time this
  // settles, and a stale settle must not touch state that may now belong to that session's own in-flight resume.
  async resume(sessionId: string): Promise<void> {
    if (this.resuming()) return;
    this.resuming.set(true);
    this.resumeError.set(null);
    try {
      await this.api.reopenSession(sessionId);
    } catch (error) {
      if (this.sessionId() !== sessionId) return;
      this.resumeError.set(reopenErrorMessage(error instanceof ApiError ? error.code : undefined));
      this.resuming.set(false);
      return;
    }
    if (this.sessionId() !== sessionId) return;
    this.resuming.set(false);
  }

  protected closedVariant(session: Session): 'error' | 'neutral' {
    return closeStatusFor(session.exitCode).kind === 'failed' ? 'error' : 'neutral';
  }

  protected closedRole(session: Session): 'alert' | 'status' {
    return this.closedVariant(session) === 'error' ? 'alert' : 'status';
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
