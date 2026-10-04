import { ChangeDetectionStrategy, Component, DestroyRef, ElementRef, Injector, afterNextRender, computed, effect, inject, input, signal, viewChild } from '@angular/core';
import type { CloseHandoffResult, HandoffTarget, SessionState } from '@openfleet/shared';
import { ErrorLineComponent } from '../design/error-line.component';
import { EarlyEscapeHintService } from '../core/early-escape-hint.service';
import { copyFor, INTERRUPT_ERROR } from '../core/error-copy';
import { FleetApiService } from '../core/fleet-api.service';
import { PendingSwitchesService } from '../core/pending-switches.service';
import { SessionRequestsService } from '../core/session-requests';

const CLOSE_CONFIRM_BODY =
  'The process stops. The worktree, branch and transcript are kept; you can reopen it later with its history.';
const CLOSE_CONFIRM_PENDING_SWITCH_WARNING = 'Closing cancels the pending model switch.';
const ESCAPE_KEY = '\x1b';
const NO_DOCS_FOLDER_REASON = 'No handoff: this project has no docs folder yet.';
const DOCS_FOLDER_NOT_WRITABLE_REASON = 'No handoff: the docs folder is not writable.';
const HANDOFF_TARGET_CHECK_FAILED = "Couldn't check the docs folder. Closing still works.";
const FOCUSABLE_IN_DIALOG = 'button:not(:disabled), input:not(:disabled)';

type HandoffTargetState =
  | { status: 'loading' }
  | { status: 'usable'; relativePath: string }
  | { status: 'unavailable'; reason: string }
  | { status: 'check_failed' };

interface HandoffHint {
  text: string;
  isPath: boolean;
  isFailure: boolean;
}

const unavailableReasonOf = (target: HandoffTarget): string =>
  target.reason === 'docs_folder_unusable' ? DOCS_FOLDER_NOT_WRITABLE_REASON : NO_DOCS_FOLDER_REASON;

@Component({
  selector: 'of-session-actions',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ErrorLineComponent],
  template: `
    <div class="session-actions" data-testid="session-actions" [attr.inert]="confirmingClose() ? '' : null">
      @if (!closed()) {
        @if (busy()) {
          <button
            type="button"
            class="of-btn of-btn--secondary interrupt"
            data-testid="session-interrupt"
            title="Interrupt the current turn (esc)"
            [class.of-btn--compact]="isCompact()"
            [disabled]="interrupting() || closing()"
            (click)="interrupt()"
          >
            <span class="interrupt-glyph" aria-hidden="true">◼</span> Interrupt
          </button>
        }
        @if (closeVisible()) {
          <button #closeTrigger type="button" class="of-btn of-btn--secondary" data-testid="session-close" [disabled]="closing()" (click)="requestClose()">
            Close
          </button>
        }
      }
      @if (error(); as error) {
        <of-error-line role="alert" data-testid="session-action-error">{{ error }}</of-error-line>
      }
      @if (handoffNotice(); as notice) {
        <of-error-line role="status" data-testid="close-handoff-notice">{{ notice }}</of-error-line>
      }
    </div>
    @if (confirmingClose()) {
      <div class="close-confirm-overlay" tabindex="-1" data-testid="close-confirm-overlay" (mousedown)="keepFocusOnDialogWhenScrimPressed($event)" (keydown.escape)="cancelClose()" (keydown)="trapTabFocus($event)">
        <div #dialog class="close-confirm" role="dialog" aria-modal="true" aria-labelledby="close-confirm-title" data-testid="close-confirm-dialog">
          <span id="close-confirm-title" class="close-confirm-title">Close {{ sessionName() }}?</span>
          <p class="close-confirm-body">{{ closeConfirmBody }}</p>
          <div class="close-handoff">
            <label class="close-handoff-choice">
              <input
                type="checkbox"
                data-testid="close-handoff-checkbox"
                [checked]="writeHandoff()"
                [disabled]="!canChooseHandoff()"
                [attr.aria-describedby]="handoffHint() ? 'close-handoff-hint' : null"
                (change)="writeHandoff.set($any($event.target).checked)"
              />
              Write a handoff when this session closes
            </label>
            @if (handoffHint(); as hint) {
              <p id="close-handoff-hint" class="close-handoff-hint" [class.close-handoff-path]="hint.isPath" data-testid="close-handoff-hint">
                @if (hint.isFailure) {
                  <of-error-line>{{ hint.text }}</of-error-line>
                } @else {
                  {{ hint.text }}
                }
              </p>
            }
          </div>
          @if (isModelSwitchDeferred()) {
            <p class="close-confirm-warning" role="alert" data-testid="close-confirm-pending-switch"><span class="warning-glyph" aria-hidden="true">!</span> {{ closeConfirmPendingSwitchWarning }}</p>
          }
          <div class="close-confirm-actions">
            <button #cancelButton type="button" class="of-btn of-btn--secondary" data-testid="close-confirm-cancel" (click)="cancelClose()">
              Cancel
            </button>
            <button type="button" class="of-btn of-btn--danger" data-testid="close-confirm-submit" [disabled]="closing()" (click)="confirmClose()">
              Close session
            </button>
          </div>
        </div>
      </div>
    }
  `,
  styles: `
    .session-actions { display: flex; align-items: center; gap: .375rem; }
    .interrupt-glyph { color: var(--state-waiting-permission); }
    .interrupt { border-color: var(--state-waiting-permission); }
    .interrupt.of-btn--compact { background: transparent; }
    .close-confirm-overlay {
      position: fixed; inset: 0; z-index: 30;
      display: flex; align-items: center; justify-content: center;
      background: rgba(0, 0, 0, .45);
      outline: none;
    }
    .close-confirm {
      width: 26rem; display: flex; flex-direction: column; gap: .75rem; padding: 1.125rem;
      border: 1px solid var(--line-2); border-radius: .625rem; background: var(--panel); box-shadow: var(--shadow);
    }
    .close-confirm-title { font-size: .9375rem; font-weight: 600; }
    .close-confirm-body { margin: 0; color: var(--mut); }
    .close-confirm-warning { margin: 0; color: var(--fg); }
    .warning-glyph { font-weight: 700; color: var(--state-waiting-permission); }
    .close-handoff { display: flex; flex-direction: column; gap: .25rem; }
    .close-handoff-choice { display: flex; align-items: center; gap: .5rem; color: var(--fg); }
    .close-handoff-hint { margin: 0; padding-left: 1.5rem; font-size: .75rem; color: var(--mut); }
    .close-handoff-path { font-family: var(--mono); }
    .close-confirm-actions { display: flex; gap: .5rem; justify-content: flex-end; }
  `,
})
export class SessionActionsComponent {
  readonly sessionId = input.required<string>();
  readonly state = input.required<SessionState>();
  readonly stateSince = input.required<string>();
  readonly sessionName = input.required<string>();
  readonly closeVisible = input(true);
  /** Draws Interrupt on the 24px line the collapsed header uses. */
  readonly isCompact = input(false);
  private readonly api = inject(FleetApiService);
  private readonly earlyEscapeHint = inject(EarlyEscapeHintService);
  private readonly pendingSwitches = inject(PendingSwitchesService);
  private readonly requests = inject(SessionRequestsService);
  private readonly injector = inject(Injector);
  private readonly destroyRef = inject(DestroyRef);

  protected readonly closeConfirmBody = CLOSE_CONFIRM_BODY;
  protected readonly closeConfirmPendingSwitchWarning = CLOSE_CONFIRM_PENDING_SWITCH_WARNING;

  protected readonly busy = computed(() => this.state() === 'generating');
  protected readonly closed = computed(() => this.state() === 'closed');
  protected readonly closing = computed(() => this.requests.isBusy(this.sessionId(), 'close'));
  protected readonly interrupting = computed(() => this.requests.isBusy(this.sessionId(), 'interrupt'));
  protected readonly isModelSwitchDeferred = computed(() => this.pendingSwitches.pendingOf(this.sessionId(), 'model')?.status === 'deferred');
  private readonly closeError = computed(() => this.requests.errorOf(this.sessionId(), 'close'));
  private readonly interruptError = computed(() => this.requests.errorOf(this.sessionId(), 'interrupt'));
  protected readonly error = computed(() => this.closeError() ?? this.interruptError());
  protected readonly confirmingClose = signal(false);
  protected readonly writeHandoff = signal(false);
  private readonly handoffTargetState = signal<HandoffTargetState>({ status: 'loading' });
  private readonly handoffFailure = signal<{ sessionId: string; message: string } | null>(null);

  protected readonly canChooseHandoff = computed(() => this.handoffTargetState().status === 'usable');
  protected readonly handoffHint = computed<HandoffHint | null>(() => {
    const target = this.handoffTargetState();
    if (target.status === 'usable') return { text: target.relativePath, isPath: true, isFailure: false };
    if (target.status === 'unavailable') return { text: target.reason, isPath: false, isFailure: false };
    if (target.status === 'check_failed') return { text: HANDOFF_TARGET_CHECK_FAILED, isPath: false, isFailure: true };
    return null;
  });
  protected readonly handoffNotice = computed(() => {
    const failure = this.handoffFailure();
    const concernsThisSession = failure?.sessionId === this.sessionId();
    return failure && concernsThisSession ? `Closed. The handoff was not written: ${failure.message}` : null;
  });

  private readonly closeTrigger = viewChild<ElementRef<HTMLButtonElement>>('closeTrigger');
  private readonly cancelButton = viewChild<ElementRef<HTMLButtonElement>>('cancelButton');
  private readonly dialog = viewChild<ElementRef<HTMLElement>>('dialog');
  private closingSessionId = '';
  private wasClosed = false;

  constructor() {
    effect(() => {
      if (this.confirmingClose()) this.cancelButton()?.nativeElement.focus();
    });
    effect(() => {
      if (this.closed()) this.confirmingClose.set(false);
    });
    effect(() => {
      const isClosed = this.closed();
      const hasBeenReopened = this.wasClosed && !isClosed;
      this.wasClosed = isClosed;
      if (hasBeenReopened) this.handoffFailure.set(null);
    });
    // A route param change reuses this component instance, so a session switch must not leave a stale
    // confirm dialog showing over the new session.
    effect(() => {
      this.sessionId();
      this.confirmingClose.set(false);
    });
  }

  requestClose(): void {
    if (this.closing()) return;
    this.closingSessionId = this.sessionId();
    this.handoffFailure.set(null);
    this.confirmingClose.set(true);
    void this.loadHandoffTarget(this.closingSessionId);
  }

  private async loadHandoffTarget(sessionId: string): Promise<void> {
    this.handoffTargetState.set({ status: 'loading' });
    this.writeHandoff.set(false);
    let target: HandoffTarget | null;
    try {
      target = await this.api.getHandoffTarget(sessionId);
    } catch {
      target = null;
    }
    const dialogHasMovedOn = this.closingSessionId !== sessionId;
    if (dialogHasMovedOn) return;
    if (target === null) return this.handoffTargetState.set({ status: 'check_failed' });
    if (!target.available) return this.handoffTargetState.set({ status: 'unavailable', reason: unavailableReasonOf(target) });
    this.handoffTargetState.set({ status: 'usable', relativePath: target.relativePath ?? '' });
    this.writeHandoff.set(target.writeOnCloseDefault);
  }

  cancelClose(): void {
    this.confirmingClose.set(false);
    this.focusCloseTriggerAfterRender();
  }

  confirmClose(): void {
    const sessionId = this.closingSessionId;
    const shouldWriteHandoff = this.canChooseHandoff() && this.writeHandoff();
    this.confirmingClose.set(false);
    void this.close({ sessionId, shouldWriteHandoff }).then(() => {
      const closeFailedOnCurrentSession = this.closeError() !== null && !this.hasLeftSession(sessionId);
      if (closeFailedOnCurrentSession) this.focusCloseTriggerAfterRender();
    });
  }

  /** Keeps a press on the scrim from moving focus off the dialog button; the scrim still does not dismiss. */
  keepFocusOnDialogWhenScrimPressed(event: MouseEvent): void {
    const isPressOnScrimItself = event.target === event.currentTarget;
    if (isPressOnScrimItself) event.preventDefault();
  }

  // The trigger sits under `[attr.inert]` (and `[disabled]` while closing) until the pending signal writes render.
  // Focus only returns when nothing else took it meanwhile, so a user who moved on is never yanked back.
  private focusCloseTriggerAfterRender(): void {
    if (this.destroyRef.destroyed) return;
    afterNextRender(
      () => {
        const isFocusFree = document.activeElement === null || document.activeElement === document.body;
        if (isFocusFree) this.closeTrigger()?.nativeElement.focus();
      },
      { injector: this.injector },
    );
  }

  /** Keeps Tab cycling over the enabled controls of the dialog, in page order, so focus never reaches what's behind it. */
  trapTabFocus(event: KeyboardEvent): void {
    if (event.key !== 'Tab') return;
    const focusable = Array.from(this.dialog()?.nativeElement.querySelectorAll<HTMLElement>(FOCUSABLE_IN_DIALOG) ?? []);
    if (focusable.length === 0) return;
    event.preventDefault();
    const currentIndex = focusable.indexOf(document.activeElement as HTMLElement);
    const step = event.shiftKey ? -1 : 1;
    const nextIndex = (currentIndex + step + focusable.length) % focusable.length;
    focusable[nextIndex]!.focus();
  }

  // Only the failure of the latest of the two actions is shown.
  private async close({ sessionId, shouldWriteHandoff }: { sessionId: string; shouldWriteHandoff: boolean }): Promise<void> {
    this.requests.clearError(sessionId, 'interrupt');
    const closeErrorFor = (error: unknown) => copyFor(error, { action: 'close' }).text;
    const closeSession = async () => {
      const outcome = shouldWriteHandoff ? await this.api.closeSession(sessionId, { writeHandoff: true }) : await this.api.closeSession(sessionId);
      this.rememberHandoffFailure({ sessionId, handoff: outcome?.handoff });
    };
    await this.requests.run({ sessionId, kind: 'close', message: closeErrorFor, action: closeSession });
  }

  private rememberHandoffFailure({ sessionId, handoff }: { sessionId: string; handoff: CloseHandoffResult | undefined }): void {
    if (handoff?.status !== 'failed') return;
    this.handoffFailure.set({ sessionId, message: handoff.message });
  }

  async interrupt(): Promise<void> {
    const sessionId = this.sessionId();
    // Captured before the request goes out: a turn that ends and a new one that starts while it is
    // pending must not have its hint blamed on this Escape.
    const stateSinceWhenEscapeWasSent = this.stateSince();
    this.requests.clearError(sessionId, 'close');
    const sendEscape = async () => {
      await this.api.sendInput(sessionId, ESCAPE_KEY);
      this.earlyEscapeHint.escapeSent(sessionId, stateSinceWhenEscapeWasSent);
    };
    await this.requests.run({ sessionId, kind: 'interrupt', message: INTERRUPT_ERROR, action: sendEscape });
  }

  private hasLeftSession(sessionId: string): boolean {
    return this.sessionId() !== sessionId;
  }
}
