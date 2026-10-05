import { ChangeDetectionStrategy, Component, ElementRef, Injector, computed, effect, inject, input, signal, untracked, viewChild } from '@angular/core';
import type { Session } from '@openfleet/shared';
import { copyFor } from '../core/error-copy';
import { FleetApiService } from '../core/fleet-api.service';
import { SessionRequestsService } from '../core/session-requests';
import { ErrorLineComponent } from '../design/error-line.component';
import { StateChipComponent } from '../design/state-chip.component';
import { closedSessionPresentationFor } from './closed-session-presentation';
import { ModelSelectorComponent } from './model-selector.component';
import { PermissionModePickerComponent } from './permission-mode-picker.component';
import { SessionActionsComponent } from './session-actions.component';
import { restoreFocusWhenFree } from './handoff/handoff-focus';
import { HandoffPreviewHostComponent } from './handoff/handoff-preview-host.component';
import { closeStatusFor } from './session-close-status';
import { clockTimeOf } from '../core/clock-time';

/** Who the session is and what can be done to it: rename, model, permission mode, handoff, close. */
@Component({
  selector: 'of-session-details',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ErrorLineComponent, StateChipComponent, ModelSelectorComponent, PermissionModePickerComponent, SessionActionsComponent, HandoffPreviewHostComponent],
  template: `
    <section class="session-details" data-testid="session-details" aria-label="Session details">
      <div class="card" data-testid="session-details-identity">
        <div class="identity-row">
          <input
            #emojiInput
            class="emoji"
            data-testid="session-emoji-input"
            title="Change emoji"
            maxlength="8"
            [value]="session().emoji"
            (change)="renameEmoji(emojiInput.value)"
            (keydown.escape)="cancelEmojiEdit(emojiInput)"
          />
          <input
            #nameInput
            class="name"
            data-testid="session-name-input"
            aria-label="Session name"
            [attr.title]="session().name"
            [value]="session().name"
            (change)="renameName(nameInput.value)"
            (keydown.escape)="cancelNameEdit(nameInput)"
          />
        </div>
        @if (renameError(); as error) {
          <of-error-line role="alert" data-testid="session-rename-error">{{ error }}</of-error-line>
        }
        <div class="chips-row">
          <of-state-chip [state]="session().state" [since]="runningSince()" [detail]="exitDetail()" [isFailure]="isFailedExit()" />
          @if (closedMeta(); as meta) {
            <span class="closed-meta" data-testid="session-exit-code">{{ meta }}</span>
          }
          @if (session().modelDriftedFrom; as previousModel) {
            <span class="drift-chip" data-testid="session-drift-chip" [attr.title]="'The model changed under this session; it was ' + previousModel"><span class="drift-glyph" aria-hidden="true">⇄</span> drift</span>
          }
        </div>
      </div>
      <div class="card facts" data-testid="session-facts">
        <div class="fact">
          <span class="fact-label">Harness</span>
          <span class="fact-value" data-testid="session-harness">{{ session().harness }}</span>
        </div>
        <div class="fact">
          <span class="fact-label">Directory</span>
          <span class="fact-value directory" data-testid="session-directory" [attr.title]="session().directory">{{ session().directory }}</span>
        </div>
        <div class="fact fact--field">
          <span class="fact-label">Model</span>
          <of-model-selector [sessionId]="session().id" />
        </div>
        <div class="fact fact--field">
          <span class="fact-label">Permission</span>
          <of-permission-mode-picker [sessionId]="session().id" [currentMode]="session().permissionMode" />
        </div>
      </div>
      <div class="actions-row">
        <button
          #handoffButton
          type="button"
          class="of-btn of-btn--secondary"
          data-testid="session-write-handoff"
          [attr.aria-expanded]="isHandoffOpen()"
          [attr.aria-controls]="handoffPanelId()"
          (click)="toggleHandoff()"
        >
          Write handoff
        </button>
        @if (isResumeOffered()) {
          <button type="button" class="of-btn of-btn--primary" data-testid="session-details-resume" [disabled]="isResuming()" (click)="resume()">
            ↻ Resume
          </button>
        }
        <of-session-actions
          [sessionId]="session().id"
          [state]="session().state"
          [stateSince]="session().stateSince"
          [sessionName]="session().name"
          [interruptVisible]="false"
        />
      </div>
      @if (isHandoffOpen()) {
        <div [id]="handoffPanelId()" data-testid="session-handoff-panel">
          <of-handoff-preview [sessionId]="session().id" density="compact" (dismissed)="closeHandoff()" />
        </div>
      }
    </section>
  `,
  styles: `
    :host { display: block; min-width: 0; }
    .session-details { display: flex; flex-direction: column; gap: .625rem; padding: .625rem; }
    .card { display: flex; flex-direction: column; gap: .5rem; min-width: 0; padding: .625rem .75rem; border: 1px solid var(--line); border-radius: .625rem; background: var(--panel); }
    .identity-row, .chips-row, .actions-row { display: flex; align-items: center; gap: .5rem; flex-wrap: wrap; min-width: 0; }
    .chips-row { gap: .375rem; }
    .emoji, .name { border: 1px solid transparent; background: transparent; color: var(--fg); font-family: inherit; }
    .emoji {
      flex: none; width: 2rem; height: 2rem; padding: 0; text-align: center; font-size: 1rem;
      border-color: var(--line); border-radius: .5rem; background: var(--sunk);
    }
    .name { flex: 1; min-width: 0; height: 1.75rem; padding: 0 .375rem; border-radius: .375rem; font-weight: 600; font-size: .9375rem; text-overflow: ellipsis; }
    .name:hover { border-color: var(--line); }
    .name:focus { border-color: var(--accent); background: var(--sunk); outline: 0; }
    .emoji:focus { border-color: var(--accent); outline: 0; }
    .drift-chip {
      height: 1.5rem; display: inline-flex; align-items: center; gap: .3125rem; padding: 0 .5rem; border: 1px solid var(--line); border-radius: .375rem;
      background: var(--sunk); color: var(--fg); font-size: .6875rem;
    }
    .drift-glyph { color: var(--state-waiting-permission); }
    .closed-meta { font-family: var(--mono); font-size: .75rem; color: var(--mut); }
    .facts { gap: .375rem; font-size: .75rem; }
    .fact { display: flex; align-items: flex-start; gap: .5rem; min-width: 0; }
    .fact-label { flex: none; width: 5.5rem; color: var(--mut); }
    .fact--field .fact-label { display: flex; align-items: center; height: 1.75rem; }
    .fact-value { min-width: 0; }
    .directory { font-family: var(--mono); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    of-model-selector, of-permission-mode-picker { flex: 1; min-width: 0; }
  `,
})
export class SessionDetailsComponent {
  readonly session = input.required<Session>();
  private readonly api = inject(FleetApiService);
  private readonly requests = inject(SessionRequestsService);
  // A name edit and an emoji edit are independent requests, so one in flight must not guard-block the other.
  protected readonly renameError = computed(() => {
    const sessionId = this.session().id;
    return this.requests.errorOf(sessionId, 'renameName') ?? this.requests.errorOf(sessionId, 'renameEmoji');
  });

  private readonly sessionId = computed(() => this.session().id);
  /** A closed session is not running, so its chip shows no timer. */
  protected readonly runningSince = computed(() => (this.session().state === 'closed' ? undefined : this.session().stateSince));
  private readonly closeStatus = computed(() => (this.session().state === 'closed' ? closeStatusFor(this.session().exitCode) : undefined));
  protected readonly exitDetail = computed(() => {
    const status = this.closeStatus();
    const hasExitCode = status !== undefined && status.kind !== 'unknown';
    return hasExitCode ? `exit ${status.exitCode}` : undefined;
  });
  protected readonly isFailedExit = computed(() => this.closeStatus()?.kind === 'failed');
  protected readonly closedMeta = computed(() => {
    const exitDetail = this.exitDetail();
    if (!exitDetail) return undefined;
    const closedAt = clockTimeOf(this.session().stateSince);
    return closedAt ? `${exitDetail} · ${closedAt}` : exitDetail;
  });
  protected readonly isResuming = computed(() => this.requests.isBusy(this.sessionId(), 'resume'));
  protected readonly isResumeOffered = computed(() => {
    const { state, exitCode, closeReason } = this.session();
    if (state !== 'closed') return false;
    const resumeRequestError = this.requests.errorOf(this.sessionId(), 'resume') ?? undefined;
    return closedSessionPresentationFor({ exitCode, reason: closeReason, resumeRequestError }).isResumeOffered;
  });
  protected readonly isHandoffOpen = signal(false);
  protected readonly handoffPanelId = computed(() => `session-handoff-panel-${this.sessionId()}`);
  private readonly handoffButton = viewChild<ElementRef<HTMLButtonElement>>('handoffButton');
  private readonly injector = inject(Injector);

  constructor() {
    // A route param change reuses this component instance: a preview collected for one session must not stay over another.
    effect(() => {
      this.sessionId();
      untracked(() => this.isHandoffOpen.set(false));
    });
  }

  protected async resume(): Promise<void> {
    const sessionId = this.sessionId();
    const resumeErrorFor = (error: unknown) => copyFor(error, { action: 'resume' }).text;
    await this.requests.run({ sessionId, kind: 'resume', message: resumeErrorFor, action: () => this.api.reopenSession(sessionId) });
  }

  protected toggleHandoff(): void {
    if (this.isHandoffOpen()) return this.closeHandoff();
    this.isHandoffOpen.set(true);
  }

  protected closeHandoff(): void {
    this.isHandoffOpen.set(false);
    restoreFocusWhenFree({ target: () => this.handoffButton()?.nativeElement, injector: this.injector });
  }

  renameName(value: string): void {
    const trimmed = value.trim();
    if (!trimmed || trimmed === this.session().name) return;
    void this.rename('renameName', { name: trimmed });
  }

  renameEmoji(value: string): void {
    const trimmed = value.trim();
    if (!trimmed || trimmed === this.session().emoji) return;
    void this.rename('renameEmoji', { emoji: trimmed });
  }

  protected cancelNameEdit(input: HTMLInputElement): void {
    input.value = this.session().name;
    input.blur();
  }

  protected cancelEmojiEdit(input: HTMLInputElement): void {
    input.value = this.session().emoji;
    input.blur();
  }

  private async rename(kind: 'renameName' | 'renameEmoji', patch: { name?: string; emoji?: string }): Promise<void> {
    const sessionId = this.session().id;
    const otherKind = kind === 'renameName' ? 'renameEmoji' : 'renameName';
    this.requests.clearError(sessionId, otherKind);
    const renameErrorFor = (error: unknown) => copyFor(error, { action: 'rename' }).text;
    await this.requests.run({ sessionId, kind, message: renameErrorFor, action: () => this.api.renameSession(sessionId, patch) });
  }
}
