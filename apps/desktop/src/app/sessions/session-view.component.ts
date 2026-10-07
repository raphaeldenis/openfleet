import { ChangeDetectionStrategy, Component, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { detailsTextOf } from '../core/copy-details';
import { EarlyEscapeHintService } from '../core/early-escape-hint.service';
import { CopyDetailsButtonComponent } from '../design/copy-details-button.component';
import { copyFor } from '../core/error-copy';
import { FleetApiService } from '../core/fleet-api.service';
import { FleetEventsService } from '../core/fleet-events.service';
import { SessionRequestsService } from '../core/session-requests';
import { PermissionGateCardComponent } from './permission-gate-card.component';
import { type LifecycleStrip, closedSessionPresentationFor } from './closed-session-presentation';
import { SessionActionsComponent } from './session-actions.component';
import { TerminalComponent } from './terminal.component';
import { RightPanelSessionToggleComponent } from './right-panel-session-toggle.component';

const FRESH_CONFIRM_QUESTION = 'Start a new conversation? The previous one is not resumed.';

type LifecycleBanner = { kind: 'resuming'; isFresh: boolean } | { kind: 'strip'; strip: LifecycleStrip; role: 'alert' | null };

@Component({
  selector: 'of-session-view',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [SessionActionsComponent, TerminalComponent, PermissionGateCardComponent, RightPanelSessionToggleComponent, CopyDetailsButtonComponent],
  template: `
    @if (session(); as s) {
      <div class="session-view" data-testid="session-view">
        <div class="lifecycle-live-region" data-testid="lifecycle-live-region" aria-live="polite">
          @if (resumingBanner(); as reopenBanner) {
            <div class="lifecycle-banner" data-testid="lifecycle-banner" data-variant="resuming">
              @if (reopenBanner.isFresh) {
                <span class="lifecycle-title"><span class="glyph" aria-hidden="true">↻</span> Starting…</span>
                <span class="lifecycle-body">Starting a new conversation in the same worktree.</span>
              } @else {
                <span class="lifecycle-title"><span class="glyph" aria-hidden="true">↻</span> Resuming…</span>
                <span class="lifecycle-body">Reattaching to the same conversation in the same worktree.</span>
              }
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
        <div class="terminal-area">
          <div class="terminal-overlay-controls" data-testid="terminal-tab-bar">
            <of-session-actions
              [sessionId]="s.id"
              [state]="s.state"
              [stateSince]="s.stateSince"
              [sessionName]="s.name"
              [closeVisible]="false"
              [isCompact]="true"
            />
            <of-right-panel-session-toggle />
          </div>
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
              <button type="button" class="of-btn of-btn--secondary" data-testid="reopen-fresh-session" [disabled]="resuming()" (click)="askToStartFresh()">
                Reopen fresh
              </button>
            </span>
            @if (isConfirmingFresh()) {
              <div class="fresh-confirm" role="group" aria-label="Confirm a fresh start" data-testid="reopen-fresh-confirm">
                <span class="fresh-confirm-text" data-testid="reopen-fresh-confirm-text">{{ freshConfirmText() }}</span>
                <button type="button" class="of-btn of-btn--primary" data-testid="reopen-fresh-confirm-accept" (click)="startFresh(s.id)">Start new conversation</button>
                <button type="button" class="of-btn of-btn--secondary" data-testid="reopen-fresh-confirm-cancel" (click)="cancelFresh()">Cancel</button>
              </div>
            }
          </div>
        }
      </div>
    } @else {
      <p data-testid="session-view-not-found">Session not found.</p>
    }
  `,
  styles: `
    :host { display: flex; flex: 1; min-width: 0; min-height: 0; }
    .session-view { flex: 1; min-width: 0; display: flex; flex-direction: column; height: 100%; min-height: 0; }
    .terminal-area { position: relative; flex: 1; min-height: 0; display: flex; flex-direction: column; gap: .625rem; padding: 0 .5rem; }
    .terminal-overlay-controls {
      position: absolute; top: .5rem; right: 1rem; z-index: 2; display: flex; align-items: center; gap: .5rem;
      color: var(--term-fg); opacity: .35; pointer-events: none;
    }
    .terminal-overlay-controls:hover, .terminal-overlay-controls:focus-within { opacity: 1; }
    .terminal-overlay-controls > * { pointer-events: auto; }
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
    .closed-card { flex-wrap: wrap; }
    .fresh-confirm { display: flex; align-items: center; flex-wrap: wrap; gap: .5rem; flex-basis: 100%; }
    .fresh-confirm-text { flex: 1; min-width: 0; color: var(--fg); }
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

  private readonly confirmingFreshOfSessionId = signal<string | undefined>(undefined);
  private readonly freshStartOfSessionId = signal<string | undefined>(undefined);

  protected readonly isConfirmingFresh = computed(() => this.confirmingFreshOfSessionId() === this.sessionId());

  protected readonly freshConfirmText = computed(() => {
    const liveChildrenCount = this.events.sessions().filter((other) => other.parentId === this.sessionId() && other.state !== 'closed').length;
    if (liveChildrenCount === 0) return FRESH_CONFIRM_QUESTION;
    const childrenNoun = liveChildrenCount === 1 ? 'live child keeps' : 'live children keep';
    return `${FRESH_CONFIRM_QUESTION} ${liveChildrenCount} ${childrenNoun} running.`;
  });

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
    const isFreshStart = this.freshStartOfSessionId() === session.id;
    if (isReopenRequestInFlight || isClosedSessionRelaunching) return { kind: 'resuming', isFresh: isFreshStart };
    const strip = this.closedPresentation()?.strip;
    if (!strip) return undefined;
    const isFailureJustSeen = strip.variant === 'error' && this.watchedOpenSessionId() === session.id;
    const isAnnounced = strip.isResumeFailure || isFailureJustSeen;
    return { kind: 'strip', strip, role: isAnnounced && strip.variant === 'error' ? 'alert' : null };
  });

  protected readonly resumingBanner = computed(() => {
    const banner = this.lifecycleBanner();
    return banner?.kind === 'resuming' ? banner : undefined;
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
    this.freshStartOfSessionId.set(undefined);
    const reopenErrorFor = (error: unknown) => copyFor(error, { action: 'resume' }).text;
    await this.requests.run({ sessionId, kind: 'resume', message: reopenErrorFor, action: () => this.api.reopenSession(sessionId) });
  }

  protected askToStartFresh(): void {
    this.confirmingFreshOfSessionId.set(this.sessionId());
  }

  protected cancelFresh(): void {
    this.confirmingFreshOfSessionId.set(undefined);
  }

  protected async startFresh(sessionId: string): Promise<void> {
    this.confirmingFreshOfSessionId.set(undefined);
    this.freshStartOfSessionId.set(sessionId);
    const reopenErrorFor = (error: unknown) => copyFor(error, { action: 'resume' }).text;
    await this.requests.run({ sessionId, kind: 'resume', message: reopenErrorFor, action: () => this.api.reopenSession(sessionId, 'fresh') });
    const isRefused = this.requests.errorOf(sessionId, 'resume') !== null;
    if (isRefused) this.freshStartOfSessionId.set(undefined);
  }
}
