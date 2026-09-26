import { ChangeDetectionStrategy, Component, computed, inject, input, signal } from '@angular/core';
import type { SessionState } from '@openfleet/shared';
import { FleetApiService } from '../core/fleet-api.service';

const CLOSE_CONFIRM_MESSAGE = 'Close this session? The PTY is terminated; the worktree and transcript are kept.';
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
        <button type="button" class="of-btn of-btn--secondary" data-testid="session-close" [disabled]="closing()" (click)="close()">Close</button>
      }
      @if (error(); as error) {
        <span role="alert" data-testid="session-action-error" class="of-error">✕ {{ error }}</span>
      }
    </div>
  `,
  styles: `
    .session-actions { display: flex; align-items: center; gap: .375rem; }
  `,
})
export class SessionActionsComponent {
  readonly sessionId = input.required<string>();
  readonly state = input.required<SessionState>();
  private readonly api = inject(FleetApiService);

  protected readonly busy = computed(() => this.state() === 'generating');
  protected readonly closed = computed(() => this.state() === 'closed');
  protected readonly closing = signal(false);
  protected readonly interrupting = signal(false);
  protected readonly error = signal<string | null>(null);

  async close(): Promise<void> {
    if (this.closing()) return;
    if (!window.confirm(CLOSE_CONFIRM_MESSAGE)) return;
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
