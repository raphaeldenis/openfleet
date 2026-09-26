import { ChangeDetectionStrategy, Component, ElementRef, computed, effect, inject, input, signal, viewChild } from '@angular/core';
import type { SessionState } from '@openfleet/shared';
import { FleetApiService } from '../core/fleet-api.service';

const CLOSE_CONFIRM_BODY = "The session's process stops; the worktree and transcript are kept.";
const CLOSE_CONFIRM_PENDING_SWITCH_WARNING = 'Closing cancels the pending model switch.';
const CLOSE_ERROR = 'Could not close the session — try again.';
const INTERRUPT_ERROR = 'Could not interrupt the session — try again.';
const ESCAPE_KEY = '\x1b';

@Component({
  selector: 'of-session-actions',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="session-actions" data-testid="session-actions">
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
      <div class="close-confirm-overlay" data-testid="close-confirm-overlay" (keydown.escape)="cancelClose()">
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
    .close-confirm-overlay {
      position: fixed; inset: 0; z-index: 30;
      display: flex; align-items: center; justify-content: center;
      background: rgba(0, 0, 0, .45);
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

  constructor() {
    effect(() => {
      if (this.confirmingClose()) this.cancelButton()?.nativeElement.focus();
    });
  }

  requestClose(): void {
    if (this.closing()) return;
    this.confirmingClose.set(true);
  }

  cancelClose(): void {
    this.confirmingClose.set(false);
    this.closeTrigger()?.nativeElement.focus();
  }

  confirmClose(): void {
    this.confirmingClose.set(false);
    void this.close();
  }

  private async close(): Promise<void> {
    if (this.closing()) return;
    this.closing.set(true);
    this.error.set(null);
    try {
      await this.api.closeSession(this.sessionId());
    } catch {
      this.error.set(CLOSE_ERROR);
    } finally {
      this.closing.set(false);
    }
  }

  async interrupt(): Promise<void> {
    if (this.interrupting()) return;
    this.interrupting.set(true);
    this.error.set(null);
    try {
      await this.api.sendInput(this.sessionId(), ESCAPE_KEY);
    } catch {
      this.error.set(INTERRUPT_ERROR);
    } finally {
      this.interrupting.set(false);
    }
  }
}
