import { ChangeDetectionStrategy, Component, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { detailsTextOf } from '../core/copy-details';
import { EarlyEscapeHintService } from '../core/early-escape-hint.service';
import { CopyDetailsButtonComponent } from '../design/copy-details-button.component';
import { copyFor } from '../core/error-copy';
import { FleetApiService } from '../core/fleet-api.service';
import { FleetEventsService } from '../core/fleet-events.service';
import { SessionRequestsService } from '../core/session-requests';
import { ComposerComponent } from './composer.component';
import { PermissionGateCardComponent } from './permission-gate-card.component';
import { type LifecycleStrip, closedSessionPresentationFor } from './closed-session-presentation';
import { SessionHeaderComponent } from './session-header.component';
import { TerminalComponent } from './terminal.component';
import { RightPanelSessionToggleComponent } from './right-panel-session-toggle.component';
import { StatePanelComponent } from '../working-state/state-panel.component';

const REOPEN_FRESH_UNAVAILABLE_REASON = 'Not available yet — the daemon cannot relaunch a session without its previous conversation.';

type LifecycleBanner = { kind: 'resuming' } | { kind: 'strip'; strip: LifecycleStrip; role: 'alert' | null };

@Component({
  selector: 'of-session-view',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [SessionHeaderComponent, StatePanelComponent, TerminalComponent, PermissionGateCardComponent, ComposerComponent, RightPanelSessionToggleComponent, CopyDetailsButtonComponent],
  template: `
    @if (session(); as s) {
      <div class="session-view" data-testid="session-view">
        <of-session-header [session]="s" />
        <of-state-panel [session]="s" />
        <div class="lifecycle-live-region" data-testid="lifecycle-live-region" aria-live="polite">
          @if (lifecycleBanner()?.kind === 'resuming') {
            <div class="lifecycle-banner" data-testid="lifecycle-banner" data-variant="resuming">
              <span class="lifecycle-title"><span class="glyph" aria-hidden="true">↻</span> Resuming…</span>
              <span class="lifecycle-body">Reattaching to the same conversation in the same worktree.</span>
            </div>
          }
          @if (isEarlyEscapeHintShown()) {
            <div class="lifecycle-banner" data-testid="early-escape-hint" data-variant="hint">
              <span class="lifecycle-title"><span class="glyph" aria-hidden="true">↩</span> Cancelled before a reply?</span>
              <span class="lifecycle-body">Claude may have put your prompt back — press Enter in the terminal to resend it, or edit it first.</span>
            </div>
          }
        </div>
        @if (lifecycleBanner(); as banner) {
          @if (banner.kind === 'strip') {
            <div class="lifecycle-banner" data-testid="lifecycle-banner" [attr.data-variant]="banner.strip.variant" [attr.role]="banner.role">
              <span class="lifecycle-title" data-testid="lifecycle-title"><span class="glyph" aria-hidden="true">{{ banner.strip.icon }}</span> {{ banner.strip.title }}</span>
              <span class="lifecycle-body" data-testid="lifecycle-message">{{ banner.strip.message }}</span>
              @if (stripDetailsText(); as detailsText) {
                <of-copy-details-button testId="lifecycle-copy-details" [text]="detailsText" [isCompact]="true" />
              }
            </div>
          }
        }
        <div class="terminal-tab-bar" data-testid="terminal-tab-bar">
          <of-right-panel-session-toggle />
        </div>
        <div class="terminal-area">
          <of-terminal [sessionId]="s.id" />
          @if (pendingApproval(); as approval) {
            <of-permission-gate-card [approval]="approval" />
          }
        </div>
        @if (closedPresentation(); as closed) {
          <div class="closed-card" data-testid="session-closed-footer" [attr.data-variant]="closed.cardTone">
            <span class="closed-title" data-testid="session-closed-title"><span class="glyph" aria-hidden="true">■</span> {{ closed.cardTitle }}</span>
            @if (closed.cardBody) {
              <span class="closed-body">{{ closed.cardBody }}</span>
            }
            <span class="closed-actions">
              @if (closed.isResumeOffered) {
                <button type="button" class="of-btn of-btn--primary" data-testid="resume-session" [disabled]="resuming()" (click)="resume(s.id)">
                  ↻ Resume in worktree
                </button>
              }
              <span class="reopen-fresh">
                <button type="button" class="of-btn of-btn--secondary" data-testid="reopen-fresh-session" aria-disabled="true" aria-describedby="reopen-fresh-session-reason">
                  Reopen fresh
                </button>
                <span class="reopen-fresh-reason" id="reopen-fresh-session-reason">{{ reopenFreshUnavailableReason }}</span>
              </span>
            </span>
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
    :host { display: flex; flex: 1; min-width: 0; min-height: 0; }
    .session-view { flex: 1; min-width: 0; display: flex; flex-direction: column; height: 100%; min-height: 0; }
    .terminal-area { flex: 1; min-height: 0; display: flex; flex-direction: column; gap: .625rem; padding: .5rem; }
    .terminal-tab-bar { flex: none; display: flex; align-items: center; justify-content: flex-end; padding: .25rem .5rem; background: var(--term-bg); color: var(--term-fg); }
    .closed-card {
      display: flex; align-items: center; gap: .75rem; margin: 0 1rem 1rem; padding: .75rem 1rem;
      border: 1px solid var(--line-2); border-radius: .5rem; background: var(--panel); font-size: .8125rem; --closed-color: var(--state-closed);
    }
    .closed-card[data-variant='error'] { --closed-color: var(--state-error); border-color: color-mix(in oklch, var(--state-error) 55%, transparent); }
    .closed-title { color: var(--fg); font-weight: 600; }
    .closed-title .glyph { color: var(--closed-color); }
    .closed-body { flex: 1; min-width: 0; color: var(--mut); }
    .closed-actions { display: flex; align-items: center; gap: .75rem; margin-left: auto; }
    .closed-card .of-btn { white-space: nowrap; }
    .lifecycle-banner {
      display: flex; align-items: center; gap: .75rem; padding: .5rem 1rem;
      border-bottom: 1px solid var(--line); font-size: .75rem;
      --lifecycle-color: var(--state-generating);
      background: color-mix(in oklch, var(--lifecycle-color) 10%, var(--panel));
    }
    .lifecycle-banner[data-variant='error'] { --lifecycle-color: var(--state-error); }
    .lifecycle-banner[data-variant='attention'] { --lifecycle-color: var(--state-waiting-permission); }
    .lifecycle-title { flex: none; color: var(--fg); font-weight: 600; font-family: var(--mono); }
    .lifecycle-title .glyph { color: var(--lifecycle-color); }
    .lifecycle-body { flex: 1; min-width: 0; }
    .reopen-fresh { position: relative; display: inline-flex; flex: none; }
    .reopen-fresh-reason {
      position: absolute; right: 0; z-index: 1; width: max-content; max-width: 18rem; padding: .375rem .5rem;
      border: 1px solid var(--line-2); border-radius: .375rem; background: var(--panel); color: var(--mut);
      font-size: .6875rem; font-weight: 400; white-space: normal; visibility: hidden;
    }
    .closed-card .reopen-fresh-reason { bottom: calc(100% + .25rem); }
    .reopen-fresh:hover .reopen-fresh-reason, .reopen-fresh:focus-within .reopen-fresh-reason { visibility: visible; }
  `,
})
export class SessionViewComponent {
  readonly sessionId = input.required<string>();
  private readonly events = inject(FleetEventsService);
  private readonly api = inject(FleetApiService);
  private readonly requests = inject(SessionRequestsService);
  private readonly earlyEscapeHint = inject(EarlyEscapeHintService);
  protected readonly resuming = computed(() => this.requests.isBusy(this.sessionId(), 'resume'));
  protected readonly resumeError = computed(() => this.requests.errorOf(this.sessionId(), 'resume'));

  protected readonly session = computed(() => this.events.sessions().find((s) => s.id === this.sessionId()));

  protected readonly reopenFreshUnavailableReason = REOPEN_FRESH_UNAVAILABLE_REASON;

  // The session the user has seen open since it was shown: only its close is news worth an alert,
  // a session that was already closed when opened is not.
  private readonly watchedOpenSessionId = signal<string | undefined>(undefined);

  protected readonly closedPresentation = computed(() => {
    const session = this.session();
    if (!session || session.state !== 'closed') return undefined;
    return closedSessionPresentationFor({ exitCode: session.exitCode, reason: session.closeReason, resumeRequestError: this.resumeError() ?? undefined });
  });

  protected readonly lifecycleBanner = computed<LifecycleBanner | undefined>(() => {
    const session = this.session();
    if (!session) return undefined;
    const isReopenRequestInFlight = this.resuming();
    const isClosedSessionRelaunching = session.state === 'starting' && session.closedAt !== undefined;
    if (isReopenRequestInFlight || isClosedSessionRelaunching) return { kind: 'resuming' };
    const strip = this.closedPresentation()?.strip;
    if (!strip) return undefined;
    const isFailureJustSeen = strip.variant === 'error' && this.watchedOpenSessionId() === session.id;
    const isAnnounced = strip.isResumeFailure || isFailureJustSeen;
    return { kind: 'strip', strip, role: isAnnounced && strip.variant === 'error' ? 'alert' : null };
  });

  /** What a user pastes into a bug report for the strip on screen: the session as ref, the close reason as code, no daemon words. */
  protected readonly stripDetailsText = computed(() => {
    const session = this.session();
    const banner = this.lifecycleBanner();
    if (!session || banner?.kind !== 'strip') return undefined;
    const code = banner.strip.copyableCode;
    if (code === undefined) return undefined;
    return detailsTextOf({ ref: session.id, code, at: session.closedAt ?? session.stateSince });
  });

  protected readonly isEarlyEscapeHintShown = computed(() => {
    const session = this.session();
    return session !== undefined && this.earlyEscapeHint.isHinting(session);
  });

  protected readonly pendingApproval = computed(() => {
    const session = this.session();
    if (!session || session.state !== 'waiting_permission') return undefined;
    return this.events.approvals().find((a) => a.sessionId === session.id && a.status === 'pending');
  });

  constructor() {
    effect(() => {
      const session = this.session();
      if (!session) return this.watchedOpenSessionId.set(undefined);
      const isOpen = session.state !== 'closed';
      const isClosingWhileWatched = untracked(this.watchedOpenSessionId) === session.id;
      this.watchedOpenSessionId.set(isOpen || isClosingWhileWatched ? session.id : undefined);
    });
  }

  async resume(sessionId: string): Promise<void> {
    const reopenErrorFor = (error: unknown) => copyFor(error, { action: 'resume' }).text;
    await this.requests.run({ sessionId, kind: 'resume', message: reopenErrorFor, action: () => this.api.reopenSession(sessionId) });
  }
}
