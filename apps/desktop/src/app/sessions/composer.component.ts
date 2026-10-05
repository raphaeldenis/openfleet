import { ChangeDetectionStrategy, Component, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { copyFor } from '../core/error-copy';
import { FleetApiService } from '../core/fleet-api.service';
import { FleetEventsService } from '../core/fleet-events.service';
import { BannerComponent } from '../design/banner.component';
import { ErrorLineComponent } from '../design/error-line.component';
import { AnsweredRepliesStore } from '../working-state/answered-replies.store';
import { ReplyDraftStore } from './reply-draft.store';

interface PendingMessage { id: string; deliveredImmediately: boolean }

const IDLE_PLACEHOLDER = 'Message this session…';
const WORKING_ON_REPLY_PLACEHOLDER = 'Reply delivered — this session is working on it';
const BUSY_PLACEHOLDER = 'This session is busy — your message is delivered on the next idle turn';

@Component({
  selector: 'of-composer',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [BannerComponent, ErrorLineComponent],
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
          (keydown.enter)="onEnter($any($event))"
          aria-label="Message this session"
          [placeholder]="placeholder()"
        ></textarea>
        <button type="button" class="of-btn of-btn--primary" data-testid="composer-send" [attr.aria-disabled]="isSending() ? 'true' : null" [attr.aria-busy]="isSending()" (click)="send()">{{ sendLabel() }}</button>
        @if (status(); as status) {
          <span class="status" data-testid="composer-status">{{ status }}</span>
        }
        @if (sendError(); as error) {
          <of-error-line role="alert" data-testid="composer-send-error">{{ error }}</of-error-line>
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
  private readonly replies = inject(ReplyDraftStore);
  private readonly answeredReplies = inject(AnsweredRepliesStore);
  protected readonly draft = computed(() => this.replies.draftOf(this.sessionId()));
  private readonly pending = signal<PendingMessage | null>(null);
  protected readonly sendError = computed(() => this.replies.failureOf(this.sessionId()) ?? null);
  protected readonly isSending = computed(() => this.replies.isSending(this.sessionId()));
  protected readonly sendLabel = computed(() => {
    if (this.isSending()) return 'Sending…';
    return this.busy() ? 'Queue' : 'Send';
  });
  protected readonly placeholder = computed(() => {
    if (!this.busy()) return IDLE_PLACEHOLDER;
    return this.status() === 'sent' ? WORKING_ON_REPLY_PLACEHOLDER : BUSY_PLACEHOLDER;
  });

  constructor() {
    effect(() => {
      const isReplyDelivered = this.status() === 'sent';
      if (isReplyDelivered) untracked(() => this.answeredReplies.markReplyDelivered(this.sessionId(), new Date().toISOString()));
    });

    // A route param change reuses this component instance, so a session switch must not leak
    // the previous session's delivery status into the one now shown (drafts and errors are keyed by session).
    effect(() => {
      this.sessionId();
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
    this.replies.setDraft(this.sessionId(), (event.target as HTMLTextAreaElement).value);
  }

  onEnter(event: KeyboardEvent): void {
    const isNewlineRequest = event.shiftKey;
    const isConfirmingImeCandidate = event.isComposing;
    if (isNewlineRequest || isConfirmingImeCandidate) return;
    event.preventDefault();
    void this.send();
  }

  async send(): Promise<void> {
    const sessionIdAtSend = this.sessionId();
    const draftAtSend = this.draft();
    const body = draftAtSend.trim();
    const isAlreadySending = this.replies.isSending(sessionIdAtSend);
    if (!body || isAlreadySending) return;
    this.replies.dismissFailure(sessionIdAtSend);
    this.replies.markSending(sessionIdAtSend, true);
    this.pending.set(null);
    const messageId = this.replies.messageIdFor(sessionIdAtSend, body);
    try {
      const result = await this.api.sendMessage(sessionIdAtSend, body, messageId);
      this.replies.confirmSent(sessionIdAtSend);
      this.replies.clearSentText(sessionIdAtSend, draftAtSend);
      if (this.sessionId() === sessionIdAtSend) this.pending.set({ id: result.messageId, deliveredImmediately: result.status === 'delivered' });
    } catch (error) {
      if (this.sessionId() === sessionIdAtSend) this.pending.set(null);
      this.replies.markFailed(sessionIdAtSend, copyFor(error, { action: 'send' }).text);
    } finally {
      this.replies.markSending(sessionIdAtSend, false);
    }
  }
}
