import { NgTemplateOutlet } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { ApiError, FleetApiService } from '../core/fleet-api.service';
import { FleetEventsService } from '../core/fleet-events.service';
import { runGuarded } from '../core/run-guarded';
import { ComposerComponent } from './composer.component';
import { PermissionGateCardComponent } from './permission-gate-card.component';
import { type ClosedStripCopy, closedStripCopyFor, reopenErrorMessage, resumeFailureReasonFor } from './session-close-status';
import { SessionHeaderComponent } from './session-header.component';
import { TerminalComponent } from './terminal.component';

const REOPEN_FRESH_UNAVAILABLE_REASON = 'Not available yet — the daemon cannot relaunch a session without its previous conversation.';

type LifecycleBanner = { kind: 'resuming' } | { kind: 'resume_failed'; reason: string };

type ClosedStrip = ClosedStripCopy & { role: 'alert' | null };

@Component({
  selector: 'of-session-view',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [NgTemplateOutlet, SessionHeaderComponent, TerminalComponent, PermissionGateCardComponent, ComposerComponent],
  template: `
    @if (session(); as s) {
      <div class="session-view" data-testid="session-view">
        <ng-template #reopenFreshUnavailable let-testId>
          <span class="reopen-fresh">
            <button type="button" class="of-btn of-btn--secondary" [attr.data-testid]="testId" aria-disabled="true" [attr.aria-describedby]="testId + '-reason'">
              Reopen fresh
            </button>
            <span class="reopen-fresh-reason" [id]="testId + '-reason'">{{ reopenFreshUnavailableReason }}</span>
          </span>
        </ng-template>
        <of-session-header [session]="s" />
        <div class="lifecycle-live-region" data-testid="lifecycle-live-region" aria-live="polite">
          @if (lifecycleBanner()?.kind === 'resuming') {
            <div class="lifecycle-banner" data-testid="lifecycle-banner" data-variant="resuming">
              <span class="lifecycle-title">↻ Resuming…</span>
              <span class="lifecycle-body">Reattaching to the same conversation in the same worktree.</span>
            </div>
          }
        </div>
        @if (lifecycleBanner(); as banner) {
          @if (banner.kind === 'resume_failed') {
            <div class="lifecycle-banner" data-testid="lifecycle-banner" data-variant="error" role="alert">
              <span class="lifecycle-title">✕ Resume failed</span>
              <span class="lifecycle-body" data-testid="resume-error">{{ banner.reason }}</span>
              <button type="button" class="of-btn of-btn--primary" data-testid="resume-retry" (click)="resume(s.id)">↻ Retry</button>
              <ng-container [ngTemplateOutlet]="reopenFreshUnavailable" [ngTemplateOutletContext]="{ $implicit: 'resume-failed-reopen-fresh' }" />
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
          @let strip = closedStrip();
          <div
            class="closed-footer"
            data-testid="session-closed-footer"
            [class.closed-footer--strip]="!!strip"
            [attr.data-variant]="strip?.variant ?? null"
            [attr.role]="strip?.role ?? null"
          >
            @if (strip) {
              <span class="closed-title">{{ strip.title }}</span>
              <span class="closed-body">{{ strip.description }}</span>
            }
            <button type="button" class="of-btn of-btn--primary" data-testid="resume-session" [disabled]="resuming()" (click)="resume(s.id)">
              ↻ Resume in worktree
            </button>
            @if (strip) {
              <ng-container [ngTemplateOutlet]="reopenFreshUnavailable" [ngTemplateOutletContext]="{ $implicit: 'reopen-fresh-session' }" />
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
    .reopen-fresh { position: relative; display: inline-flex; flex: none; }
    .reopen-fresh .of-btn[aria-disabled='true'] { border-color: var(--line); background: var(--sunk); color: var(--faint); cursor: not-allowed; }
    .reopen-fresh-reason {
      position: absolute; right: 0; z-index: 1; width: max-content; max-width: 18rem; padding: .375rem .5rem;
      border: 1px solid var(--line-2); border-radius: .375rem; background: var(--panel); color: var(--mut);
      font-size: .6875rem; font-weight: 400; white-space: normal; visibility: hidden;
    }
    .closed-footer .reopen-fresh-reason { bottom: calc(100% + .25rem); }
    .lifecycle-banner .reopen-fresh-reason { top: calc(100% + .25rem); }
    .reopen-fresh:hover .reopen-fresh-reason, .reopen-fresh:focus-within .reopen-fresh-reason { visibility: visible; }
  `,
})
export class SessionViewComponent {
  readonly sessionId = input.required<string>();
  private readonly events = inject(FleetEventsService);
  private readonly api = inject(FleetApiService);
  protected readonly resuming = signal(false);
  protected readonly resumeError = signal<string | null>(null);

  protected readonly session = computed(() => this.events.sessions().find((s) => s.id === this.sessionId()));

  protected readonly reopenFreshUnavailableReason = REOPEN_FRESH_UNAVAILABLE_REASON;

  // The session the user has seen open since it was shown: only its close is news worth an alert,
  // a session that was already closed when opened is not.
  private readonly watchedOpenSessionId = signal<string | undefined>(undefined);

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

  protected readonly closedStrip = computed<ClosedStrip | undefined>(() => {
    const session = this.session();
    if (!session || session.state !== 'closed' || this.lifecycleBanner()) return undefined;
    const copy = closedStripCopyFor(session.exitCode);
    const isFailureJustSeen = copy.variant === 'error' && this.watchedOpenSessionId() === session.id;
    return { ...copy, role: isFailureJustSeen ? 'alert' : null };
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
    // A resume error belongs to the closed session it failed on: a rejection that lands once the session is
    // starting or live again (a slow reply, a 409 from another client's reopen) must not resurface on a later close.
    effect(() => {
      const isSessionStillClosed = this.session()?.state === 'closed';
      const hasResumeError = this.resumeError() !== null;
      if (!isSessionStillClosed && hasResumeError) this.resumeError.set(null);
    });
    effect(() => {
      const session = this.session();
      if (!session) return this.watchedOpenSessionId.set(undefined);
      const isOpen = session.state !== 'closed';
      const isClosingWhileWatched = untracked(this.watchedOpenSessionId) === session.id;
      this.watchedOpenSessionId.set(isOpen || isClosingWhileWatched ? session.id : undefined);
    });
  }

  // This component instance is reused across a route param change, so a reopen that settles after the user
  // navigated away leaves `resuming`/`resumeError` alone: they belong to whichever session is current by then.
  async resume(sessionId: string): Promise<void> {
    const reopenErrorFor = (error: unknown) => reopenErrorMessage(error instanceof ApiError ? error.code : undefined);
    const hasNavigatedAway = () => this.sessionId() !== sessionId;
    await runGuarded(this.resuming, this.resumeError, reopenErrorFor, () => this.api.reopenSession(sessionId), { isStale: hasNavigatedAway });
  }
}
