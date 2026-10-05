import { ChangeDetectionStrategy, Component, computed, effect, inject, input, signal } from '@angular/core';
import { copyFor } from '../core/error-copy';
import { FleetApiService } from '../core/fleet-api.service';
import { BannerComponent } from '../design/banner.component';
import { ErrorLineComponent } from '../design/error-line.component';
import { AnsweredRepliesStore } from '../working-state/answered-replies.store';
import { ReplyDraftStore } from './reply-draft.store';
import { REPLY_DELIVERED_COPY } from './reply-delivered-copy';

interface PendingMessage { id: string }

const DEFAULT_PLACEHOLDER = 'Your answer goes to the session as a message · Enter sends, Shift+Enter for a new line';
const WORKING_ON_REPLY_PLACEHOLDER = REPLY_DELIVERED_COPY;
const BUSY_NOTE = 'This session is mid-turn — your message is delivered next turn.';

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
        <div class="actions">
          <button type="button" class="of-btn of-btn--primary" data-testid="composer-send" [attr.aria-disabled]="isSending() ? 'true' : null" [attr.aria-busy]="isSending()" (click)="send()">{{ sendLabel() }}</button>
          @if (busy()) {
            <span class="status" data-testid="composer-busy-note">{{ busyNote }}</span>
          }
          @if (status(); as status) {
            <span class="status" data-testid="composer-status">{{ status }}</span>
          }
        </div>
        @if (sendError(); as error) {
          <of-error-line role="alert" data-testid="composer-send-error">{{ error }}</of-error-line>
        }
      </div>
    }
  `,
  styles: `
    .composer { display: flex; flex-direction: column; align-items: stretch; gap: .5rem; padding: .5rem .75rem; }
    .actions { display: flex; align-items: center; flex-wrap: wrap; gap: .625rem; }
    .status { font-size: .6875rem; color: var(--mut); flex: 0 1 auto; min-width: 0; }
  `,
})
export class ComposerComponent {
  readonly sessionId = input.required<string>();
  readonly disabledReason = input<string | null>(null);
  readonly busy = input<boolean>(false);
  private readonly api = inject(FleetApiService);
  private readonly replies = inject(ReplyDraftStore);
  private readonly answeredReplies = inject(AnsweredRepliesStore);
  protected readonly draft = computed(() => this.replies.draftOf(this.sessionId()));
  private readonly pending = signal<PendingMessage | null>(null);
  protected readonly sendError = computed(() => this.replies.failureOf(this.sessionId()) ?? null);
  protected readonly isSending = computed(() => this.replies.isSending(this.sessionId()));
  protected readonly sendLabel = computed(() => {
    if (this.isSending()) return 'Sending…';
    return this.busy() ? 'Queue' : 'Send answer';
  });
  protected readonly busyNote = BUSY_NOTE;
  protected readonly placeholder = computed(() => {
    const isWorkingOnDeliveredReply = this.busy() && this.status() === 'sent';
    return isWorkingOnDeliveredReply ? WORKING_ON_REPLY_PLACEHOLDER : DEFAULT_PLACEHOLDER;
  });

  constructor() {
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
    const isDelivered = this.answeredReplies.isReplyDelivered(pending.id);
    return isDelivered ? 'sent' : 'queued';
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
    const answeredLines = this.answeredReplies.linesAskedNow(sessionIdAtSend);
    try {
      const result = await this.api.sendMessage(sessionIdAtSend, body, messageId);
      this.replies.confirmSent(sessionIdAtSend);
      this.replies.clearSentText(sessionIdAtSend, draftAtSend);
      this.answeredReplies.trackSentReply(result.messageId, { sessionId: sessionIdAtSend, replyText: body, answeredLines, isDeliveredImmediately: result.status === 'delivered' });
      if (this.sessionId() === sessionIdAtSend) this.pending.set({ id: result.messageId });
    } catch (error) {
      if (this.sessionId() === sessionIdAtSend) this.pending.set(null);
      this.replies.markFailed(sessionIdAtSend, copyFor(error, { action: 'send' }).text);
    } finally {
      this.replies.markSending(sessionIdAtSend, false);
    }
  }
}
