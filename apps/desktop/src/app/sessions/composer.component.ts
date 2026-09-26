import { ChangeDetectionStrategy, Component, computed, effect, inject, input, signal } from '@angular/core';
import { FleetApiService } from '../core/fleet-api.service';
import { FleetEventsService } from '../core/fleet-events.service';
import { BannerComponent } from '../design/banner.component';

interface PendingMessage { id: string; deliveredImmediately: boolean }

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
          placeholder="Message this session…"
        ></textarea>
        <button type="button" class="of-btn of-btn--primary" data-testid="composer-send" (click)="send()">Send</button>
        @if (status(); as status) {
          <span class="status" data-testid="composer-status">{{ status }}</span>
        }
      </div>
    }
  `,
  styles: `
    .composer { display: flex; align-items: flex-end; gap: .625rem; }
    .of-input--textarea { flex: 1; }
    .status { font-size: .6875rem; color: var(--mut); }
  `,
})
export class ComposerComponent {
  readonly sessionId = input.required<string>();
  readonly disabledReason = input<string | null>(null);
  private readonly api = inject(FleetApiService);
  private readonly events = inject(FleetEventsService);
  protected readonly draft = signal('');
  private readonly pending = signal<PendingMessage | null>(null);

  constructor() {
    // A route param change reuses this component instance, so a session switch must not leak
    // the previous session's unsent draft or delivery status into the one now shown.
    effect(() => {
      this.sessionId();
      this.draft.set('');
      this.pending.set(null);
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
    this.draft.set('');
    const result = await this.api.sendMessage(this.sessionId(), body);
    this.pending.set({ id: result.messageId, deliveredImmediately: result.status === 'delivered' });
  }
}
