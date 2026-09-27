import { ChangeDetectionStrategy, Component, computed, effect, inject, input, signal } from '@angular/core';
import { FleetApiService } from '../core/fleet-api.service';
import { FleetEventsService } from '../core/fleet-events.service';
import { BannerComponent } from '../design/banner.component';

interface PendingMessage { id: string; deliveredImmediately: boolean }

const IDLE_PLACEHOLDER = 'Message this session…';
const BUSY_PLACEHOLDER = 'This session is busy — your message is delivered on the next idle turn';
const SEND_ERROR = 'Could not send — your message is kept.';

@Component({
  selector: 'of-composer',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [BannerComponent],
  template: `
    @if (disabledReason(); as reason) {
      <of-banner variant="reconnecting" title="Composer disabled" [description]="reason" />
    } @else {
      <div class="composer" data-testid="composer">
        <textarea
          class="of-input of-input--textarea"
          data-testid="composer-input"
          [value]="draft()"
          (input)="onInput($event)"
          [placeholder]="placeholder()"
        ></textarea>
        <button type="button" class="of-btn of-btn--primary" data-testid="composer-send" (click)="send()">{{ sendLabel() }}</button>
        @if (status(); as status) {
          <span class="status" data-testid="composer-status">{{ status }}</span>
        }
        @if (sendError(); as error) {
          <span role="alert" data-testid="composer-send-error" class="of-error">✕ {{ error }}</span>
        }
      </div>
    }
  `,
  styles: `
    .composer { display: flex; align-items: flex-end; flex-wrap: wrap; gap: .625rem; padding: .5rem .75rem; }
    .of-input--textarea { flex: 1; }
    .status { font-size: .6875rem; color: var(--mut); flex: 0 1 auto; min-width: 0; }
  `,
})
export class ComposerComponent {
  readonly sessionId = input.required<string>();
  readonly disabledReason = input<string | null>(null);
  readonly busy = input<boolean>(false);
  private readonly api = inject(FleetApiService);
  private readonly events = inject(FleetEventsService);
  protected readonly draft = signal('');
  private readonly pending = signal<PendingMessage | null>(null);
  protected readonly sendError = signal<string | null>(null);
  protected readonly sendLabel = computed(() => (this.busy() ? 'Queue' : 'Send'));
  protected readonly placeholder = computed(() => (this.busy() ? BUSY_PLACEHOLDER : IDLE_PLACEHOLDER));

  constructor() {
    // A route param change reuses this component instance, so a session switch must not leak
    // the previous session's unsent draft, delivery status or send error into the one now shown.
    effect(() => {
      this.sessionId();
      this.draft.set('');
      this.pending.set(null);
      this.sendError.set(null);
    });
  }

  protected readonly status = computed(() => {
    const pending = this.pending();
    if (!pending) return null;
    const delivered = pending.deliveredImmediately || this.events.deliveredMessageIds().has(pending.id);
    return delivered ? 'sent' : 'queued';
  });

  onInput(event: Event): void {
    this.draft.set((event.target as HTMLTextAreaElement).value);
  }

  async send(): Promise<void> {
    const body = this.draft().trim();
    if (!body) return;
    const sessionIdAtSend = this.sessionId();
    this.sendError.set(null);
    try {
      const result = await this.api.sendMessage(sessionIdAtSend, body);
      if (this.sessionId() !== sessionIdAtSend) return;
      this.draft.set('');
      this.pending.set({ id: result.messageId, deliveredImmediately: result.status === 'delivered' });
    } catch {
      if (this.sessionId() !== sessionIdAtSend) return;
      this.sendError.set(SEND_ERROR);
    }
  }
}
