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
import { exitCodeLabel } from './session-close-status';

/** Who the session is and what can be done to it: rename, model, permission mode, handoff, close. */
@Component({
  selector: 'of-session-details',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ErrorLineComponent, StateChipComponent, ModelSelectorComponent, PermissionModePickerComponent, SessionActionsComponent, HandoffPreviewHostComponent],
  template: `
    <section class="session-details" data-testid="session-details" aria-label="Session details">
      <div class="identity-row" data-testid="session-details-identity">
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
      <div class="facts-row">
        <of-state-chip [state]="session().state" [since]="runningSince()" />
        @if (session().state === 'closed') {
          <span class="exit-code" data-testid="session-exit-code">{{ exitCodeLabel(session().exitCode) }}</span>
        }
        @if (session().modelDriftedFrom; as previousModel) {
          <span class="drift-chip" data-testid="session-drift-chip" [attr.title]="'The model changed under this session; it was ' + previousModel">⇄ drift</span>
        }
        <span class="harness" data-testid="session-harness" title="Harness">{{ session().harness }}</span>
      </div>
      <span class="directory" data-testid="session-directory" [attr.title]="session().directory">{{ session().directory }}</span>
      <div class="controls-row">
        <of-model-selector [sessionId]="session().id" />
        <of-permission-mode-picker [sessionId]="session().id" [currentMode]="session().permissionMode" />
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
    .session-details { display: flex; flex-direction: column; gap: .5rem; padding: .75rem; border-bottom: 1px solid var(--line); background: var(--panel); }
    .identity-row, .facts-row, .controls-row, .actions-row { display: flex; align-items: center; gap: .5rem; flex-wrap: wrap; min-width: 0; }
    .emoji, .name {
      border: 1px solid transparent; border-radius: .375rem; background: transparent; color: var(--fg);
      font-family: inherit; padding: 0 .25rem; height: 2rem;
    }
    .emoji:hover, .name:hover { border-color: var(--line); }
    .emoji:focus, .name:focus { border-color: var(--accent); outline: 0; }
    .emoji { font-size: 1.125rem; width: 2.25rem; text-align: center; }
    .name { flex: 1; min-width: 0; font-weight: 600; font-size: 1rem; text-overflow: ellipsis; }
    .drift-chip {
      height: 1.5rem; display: inline-flex; align-items: center; padding: 0 .5rem; border-radius: .375rem;
      background: var(--sunk); color: var(--fg); font-family: var(--mono); font-size: .75rem;
    }
    .exit-code { font-family: var(--mono); font-size: .75rem; color: var(--mut); }
    .harness {
      display: inline-flex; align-items: center; height: 1.5rem;
      font-size: .75rem; color: var(--mut); border: 1px solid var(--line); border-radius: .375rem; padding: 0 .5rem;
    }
    .directory { font-family: var(--mono); font-size: .6875rem; color: var(--mut); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  `,
})
export class SessionDetailsComponent {
  readonly session = input.required<Session>();
  private readonly api = inject(FleetApiService);
  private readonly requests = inject(SessionRequestsService);
  protected readonly exitCodeLabel = exitCodeLabel;
  // A name edit and an emoji edit are independent requests, so one in flight must not guard-block the other.
  protected readonly renameError = computed(() => {
    const sessionId = this.session().id;
    return this.requests.errorOf(sessionId, 'renameName') ?? this.requests.errorOf(sessionId, 'renameEmoji');
  });

  private readonly sessionId = computed(() => this.session().id);
  /** A closed session is not running, so its chip shows no timer. */
  protected readonly runningSince = computed(() => (this.session().state === 'closed' ? undefined : this.session().stateSince));
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
