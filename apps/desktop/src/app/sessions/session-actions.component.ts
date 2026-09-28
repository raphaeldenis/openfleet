import { ChangeDetectionStrategy, Component, DestroyRef, ElementRef, Injector, afterNextRender, computed, effect, inject, input, signal, viewChild } from '@angular/core';
import type { SessionState } from '@openfleet/shared';
import { FleetApiService } from '../core/fleet-api.service';
import { runGuarded } from '../core/run-guarded';

const CLOSE_CONFIRM_BODY =
  'The process stops. The worktree, branch and transcript are kept; you can reopen it later with its history.';
const CLOSE_CONFIRM_PENDING_SWITCH_WARNING = 'Closing cancels the pending model switch.';
const CLOSE_ERROR = 'Could not close the session — try again.';
const INTERRUPT_ERROR = 'Could not interrupt the session — try again.';
const ESCAPE_KEY = '\x1b';

@Component({
  selector: 'of-session-actions',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="session-actions" data-testid="session-actions" [attr.inert]="confirmingClose() ? '' : null">
      @if (!closed()) {
        @if (busy()) {
          <button type="button" class="of-btn of-btn--secondary" data-testid="session-interrupt" [disabled]="interrupting()" (click)="interrupt()">
            Interrupt
          </button>
        }
        <button #closeTrigger type="button" class="of-btn of-btn--secondary" data-testid="session-close" [disabled]="closing()" (click)="requestClose()">
          Close
        </button>
      }
      @if (error(); as error) {
        <span role="alert" data-testid="session-action-error" class="of-error">✕ {{ error }}</span>
      }
    </div>
    @if (confirmingClose()) {
      <div class="close-confirm-overlay" tabindex="-1" data-testid="close-confirm-overlay" (mousedown)="keepFocusOnDialogWhenScrimPressed($event)" (keydown.escape)="cancelClose()" (keydown)="trapTabFocus($event)">
        <div class="close-confirm" role="dialog" aria-modal="true" aria-labelledby="close-confirm-title" data-testid="close-confirm-dialog">
          <span id="close-confirm-title" class="close-confirm-title">Close {{ sessionName() }}?</span>
          <p class="close-confirm-body">{{ closeConfirmBody }}</p>
          @if (modelSwitchPending()) {
            <p class="close-confirm-warning" role="alert" data-testid="close-confirm-pending-switch">{{ closeConfirmPendingSwitchWarning }}</p>
          }
          <div class="close-confirm-actions">
            <button #cancelButton type="button" class="of-btn of-btn--secondary" data-testid="close-confirm-cancel" (click)="cancelClose()">
              Cancel
            </button>
            <button #submitButton type="button" class="of-btn of-btn--danger" data-testid="close-confirm-submit" [disabled]="closing()" (click)="confirmClose()">
              Close session
            </button>
          </div>
        </div>
      </div>
    }
  `,
  styles: `
    .session-actions { display: flex; align-items: center; gap: .375rem; }
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
    .close-confirm-warning { margin: 0; color: var(--state-waiting-permission); }
    .close-confirm-actions { display: flex; gap: .5rem; justify-content: flex-end; }
  `,
})
export class SessionActionsComponent {
  readonly sessionId = input.required<string>();
  readonly state = input.required<SessionState>();
  readonly sessionName = input.required<string>();
  readonly modelSwitchPending = input(false);
  private readonly api = inject(FleetApiService);
  private readonly injector = inject(Injector);
  private readonly destroyRef = inject(DestroyRef);

  protected readonly closeConfirmBody = CLOSE_CONFIRM_BODY;
  protected readonly closeConfirmPendingSwitchWarning = CLOSE_CONFIRM_PENDING_SWITCH_WARNING;

  protected readonly busy = computed(() => this.state() === 'generating');
  protected readonly closed = computed(() => this.state() === 'closed');
  protected readonly closing = signal(false);
  protected readonly interrupting = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly confirmingClose = signal(false);

  private readonly closeTrigger = viewChild<ElementRef<HTMLButtonElement>>('closeTrigger');
  private readonly cancelButton = viewChild<ElementRef<HTMLButtonElement>>('cancelButton');
  private readonly submitButton = viewChild<ElementRef<HTMLButtonElement>>('submitButton');
  private closingSessionId = '';

  constructor() {
    effect(() => {
      if (this.confirmingClose()) this.cancelButton()?.nativeElement.focus();
    });
    effect(() => {
      if (this.closed()) this.confirmingClose.set(false);
    });
    // A route param change reuses this component instance, so a session switch must not leave a
    // stale confirm dialog, close error or in-flight flag showing over the new session.
    effect(() => {
      this.sessionId();
      this.confirmingClose.set(false);
      this.closing.set(false);
      this.interrupting.set(false);
      this.error.set(null);
    });
  }

  requestClose(): void {
    if (this.closing()) return;
    this.closingSessionId = this.sessionId();
    this.confirmingClose.set(true);
  }

  cancelClose(): void {
    this.confirmingClose.set(false);
    this.focusCloseTriggerAfterRender();
  }

  confirmClose(): void {
    const sessionId = this.closingSessionId;
    this.confirmingClose.set(false);
    void this.close(sessionId).then(() => {
      const closeFailedOnCurrentSession = this.error() !== null && !this.hasLeftSession(sessionId);
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

  /** Keeps Tab cycling between Cancel and Close session only, so focus never reaches what's behind the dialog. */
  trapTabFocus(event: KeyboardEvent): void {
    if (event.key !== 'Tab') return;
    const focusable = [this.cancelButton()?.nativeElement, this.submitButton()?.nativeElement].filter(
      (el): el is HTMLButtonElement => el !== undefined,
    );
    if (focusable.length === 0) return;
    event.preventDefault();
    const currentIndex = focusable.indexOf(document.activeElement as HTMLButtonElement);
    const step = event.shiftKey ? -1 : 1;
    const nextIndex = (currentIndex + step + focusable.length) % focusable.length;
    focusable[nextIndex]!.focus();
  }

  private async close(sessionId: string): Promise<void> {
    await runGuarded(this.closing, this.error, CLOSE_ERROR, () => this.api.closeSession(sessionId), {
      isStale: () => this.hasLeftSession(sessionId),
    });
  }

  async interrupt(): Promise<void> {
    const sessionId = this.sessionId();
    await runGuarded(this.interrupting, this.error, INTERRUPT_ERROR, () => this.api.sendInput(sessionId, ESCAPE_KEY), {
      isStale: () => this.hasLeftSession(sessionId),
    });
  }

  private hasLeftSession(sessionId: string): boolean {
    return this.sessionId() !== sessionId;
  }
}
