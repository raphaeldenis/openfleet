import { ChangeDetectionStrategy, Component, ElementRef, Injector, computed, effect, inject, input, linkedSignal, signal, untracked, viewChild } from '@angular/core';
import type { Session } from '@openfleet/shared';
import { copyFor } from '../core/error-copy';
import { FleetApiService } from '../core/fleet-api.service';
import { PendingSwitchesService } from '../core/pending-switches.service';
import { SessionRequestsService } from '../core/session-requests';
import { ErrorLineComponent } from '../design/error-line.component';
import { StateChipComponent } from '../design/state-chip.component';
import { ModelSelectorComponent } from './model-selector.component';
import { PermissionModePickerComponent } from './permission-mode-picker.component';
import { SessionActionsComponent } from './session-actions.component';
import { restoreFocusWhenFree } from './handoff/handoff-focus';
import { HandoffPreviewHostComponent } from './handoff/handoff-preview-host.component';
import { exitCodeLabel } from './session-close-status';
import { needsAttention } from './session-header-attention';
import { readRememberedHeaderChoice, rememberHeaderChoice } from './session-header-choice';

@Component({
  selector: 'of-session-header',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ErrorLineComponent, StateChipComponent, ModelSelectorComponent, PermissionModePickerComponent, SessionActionsComponent, HandoffPreviewHostComponent],
  template: `
    <header class="session-header" data-testid="session-header">
      <div class="identity-row" data-testid="session-header-row">
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
        @if (renameError(); as error) {
          <of-error-line role="alert" data-testid="session-rename-error">{{ error }}</of-error-line>
        }
        <of-state-chip [state]="session().state" [since]="session().stateSince" />
        @if (session().state === 'closed') {
          <span class="exit-code" data-testid="session-exit-code">{{ exitCodeLabel(session().exitCode) }}</span>
        }
        <button
          type="button"
          class="details-toggle"
          data-testid="session-header-toggle"
          [attr.aria-expanded]="isOpen()"
          [attr.aria-controls]="detailsId()"
          [attr.aria-disabled]="isHandoffOpen() ? 'true' : null"
          [attr.aria-describedby]="isHandoffOpen() ? detailsLockedReasonId : null"
          (click)="toggleDetails()"
        >
          <span aria-hidden="true">{{ isOpen() ? '▴' : '▾' }}</span> Details
        </button>
        @if (isHandoffOpen()) {
          <span class="visually-hidden" [id]="detailsLockedReasonId">Details stay open while the handoff panel is open.</span>
        }
        <span class="spacer"></span>
        <of-session-actions
          [sessionId]="session().id"
          [state]="session().state"
          [stateSince]="session().stateSince"
          [sessionName]="session().name"
          [closeVisible]="isOpen()"
          [isCompact]="!isOpen()"
        />
      </div>
      <div class="details" data-testid="session-header-details" [id]="detailsId()">
        @if (isOpen()) {
          @if (session().modelDriftedFrom; as previousModel) {
            <span class="drift-chip" data-testid="session-drift-chip" [attr.title]="'The model changed under this session; it was ' + previousModel">⇄ drift</span>
          }
          <span class="harness" data-testid="session-harness" title="Harness">{{ session().harness }}</span>
          <span class="directory" data-testid="session-directory" [attr.title]="session().directory">{{ session().directory }}</span>
          <span class="cost" data-testid="session-cost" title="Cost tracking is not implemented yet">—</span>
          <of-model-selector [sessionId]="session().id" />
          <of-permission-mode-picker [sessionId]="session().id" [currentMode]="session().permissionMode" />
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
        }
      </div>
    </header>
    @if (isHandoffOpen()) {
      <div [id]="handoffPanelId()" data-testid="session-handoff-panel">
        <of-handoff-preview [sessionId]="session().id" density="compact" (dismissed)="closeHandoff()" />
      </div>
    }
  `,
  styles: `
    .session-header {
      display: flex; align-items: center; gap: .625rem; flex-wrap: wrap;
      padding: .5rem .75rem; border-bottom: 1px solid var(--line); background: var(--panel);
    }
    .identity-row { display: flex; align-items: center; gap: .625rem; flex-wrap: wrap; min-height: 2rem; min-width: 0; }
    .emoji, .name {
      border: 1px solid transparent; border-radius: .375rem; background: transparent; color: var(--fg);
      font-family: inherit; padding: 0 .25rem; height: 2rem;
    }
    .drift-chip {
      height: 1.5rem; display: inline-flex; align-items: center; padding: 0 .5rem; border-radius: .375rem;
      background: var(--sunk); color: var(--fg); font-family: var(--mono); font-size: .75rem;
    }
    .emoji:hover, .name:hover { border-color: var(--line); }
    .emoji:focus, .name:focus { border-color: var(--accent); outline: 0; }
    .emoji { font-size: 1.125rem; width: 2.25rem; text-align: center; }
    .name { font-weight: 600; font-size: 1rem; width: 9rem; text-overflow: ellipsis; }
    .exit-code { font-family: var(--mono); font-size: .75rem; color: var(--mut); }
    .harness {
      display: inline-flex; align-items: center; height: 1.5rem;
      font-size: .75rem; color: var(--mut); border: 1px solid var(--line); border-radius: .375rem; padding: 0 .5rem;
    }
    .directory { font-family: var(--mono); font-size: .6875rem; color: var(--mut); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 16rem; }
    .cost { font-style: italic; color: var(--mut); font-size: .75rem; }
    .spacer { flex: 1; min-width: .5rem; }
    .details { display: contents; }
    .details-toggle {
      height: 1.5rem; padding: 0 .5rem; border: 1px solid var(--line2); border-radius: .375rem;
      background: transparent; color: var(--fg); font-family: var(--sans); font-size: .6875rem; cursor: pointer;
    }
    .details-toggle[aria-disabled='true'] { opacity: .6; cursor: default; }
    .visually-hidden { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
    .details-toggle:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
  `,
})
export class SessionHeaderComponent {
  readonly session = input.required<Session>();
  private readonly api = inject(FleetApiService);
  private readonly requests = inject(SessionRequestsService);
  protected readonly exitCodeLabel = exitCodeLabel;
  // A name edit and an emoji edit are independent requests, so one in flight must not guard-block the other.
  protected readonly renameError = computed(() => {
    const sessionId = this.session().id;
    return this.requests.errorOf(sessionId, 'renameName') ?? this.requests.errorOf(sessionId, 'renameEmoji');
  });

  private readonly pendingSwitches = inject(PendingSwitchesService);
  protected readonly detailsId = computed(() => `session-header-details-${this.session().id}`);
  private readonly needsAttention = computed(() =>
    needsAttention({
      hasPendingModelSwitch: this.pendingSwitches.pendingOf(this.session().id, 'model') !== undefined,
      permissionMode: this.session().permissionMode,
      modelDriftedFrom: this.session().modelDriftedFrom,
    }),
  );
  private readonly userChoice = linkedSignal<string, boolean | null>({
    source: () => this.session().id,
    computation: readRememberedHeaderChoice,
  });
  /** The user's choice wins; without one, the header is open exactly while something needs attention. An open handoff panel keeps it open so its button stays reachable. */
  protected readonly isOpen = computed(() => this.isHandoffOpen() || (this.userChoice() ?? this.needsAttention()));
  private lastSeenAttention: { sessionId: string; needsAttention: boolean } | null = null;

  constructor() {
    // A route param change reuses this component instance: a preview collected for one session must not stay over another.
    effect(() => {
      this.sessionId();
      untracked(() => this.isHandoffOpen.set(false));
    });
    effect(() => {
      const sessionId = this.session().id;
      const needsAttentionNow = this.needsAttention();
      const previous = this.lastSeenAttention;
      this.lastSeenAttention = { sessionId, needsAttention: needsAttentionNow };
      const isSameSession = previous?.sessionId === sessionId;
      const hasAttentionJustAppeared = isSameSession && !previous.needsAttention && needsAttentionNow;
      if (hasAttentionJustAppeared) untracked(() => this.userChoice.set(true));
    });
  }

  protected readonly detailsLockedReasonId = 'session-header-details-locked-reason';
  private readonly sessionId = computed(() => this.session().id);
  protected readonly isHandoffOpen = signal(false);
  protected readonly handoffPanelId = computed(() => `session-handoff-panel-${this.sessionId()}`);
  private readonly handoffButton = viewChild<ElementRef<HTMLButtonElement>>('handoffButton');
  private readonly injector = inject(Injector);

  protected toggleHandoff(): void {
    if (this.isHandoffOpen()) return this.closeHandoff();
    this.isHandoffOpen.set(true);
  }

  protected closeHandoff(): void {
    this.isHandoffOpen.set(false);
    restoreFocusWhenFree({ target: () => this.handoffButton()?.nativeElement, injector: this.injector });
  }

  protected toggleDetails(): void {
    if (this.isHandoffOpen()) return;
    const open = !this.isOpen();
    this.userChoice.set(open);
    rememberHeaderChoice(this.session().id, open);
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
