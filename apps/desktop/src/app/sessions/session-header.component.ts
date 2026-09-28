import { ChangeDetectionStrategy, Component, effect, inject, input, signal, type WritableSignal } from '@angular/core';
import type { Session } from '@openfleet/shared';
import { FleetApiService } from '../core/fleet-api.service';
import { runGuarded } from '../core/run-guarded';
import { StateChipComponent } from '../design/state-chip.component';
import { ModelSelectorComponent } from './model-selector.component';
import { PermissionModePickerComponent } from './permission-mode-picker.component';
import { SessionActionsComponent } from './session-actions.component';
import { exitCodeLabel } from './session-close-status';

const RENAME_ERROR = 'Could not rename — try again.';

@Component({
  selector: 'of-session-header',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [StateChipComponent, ModelSelectorComponent, PermissionModePickerComponent, SessionActionsComponent],
  template: `
    <header class="session-header" data-testid="session-header">
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
        <span role="alert" data-testid="session-rename-error" class="of-error">✕ {{ error }}</span>
      }
      <of-state-chip [state]="session().state" [since]="session().stateSince" />
      @if (session().state === 'closed') {
        <span class="exit-code" data-testid="session-exit-code">{{ exitCodeLabel(session().exitCode) }}</span>
      }
      <span class="harness" data-testid="session-harness" title="Harness">{{ session().harness }}</span>
      <of-model-selector [sessionId]="session().id" (pendingModelSwitch)="modelSwitchPending.set($event)" />
      <of-permission-mode-picker [sessionId]="session().id" [currentMode]="session().permissionMode" [sessionState]="session().state" />
      <span class="directory" data-testid="session-directory" [attr.title]="session().directory">{{ session().directory }}</span>
      <span class="cost" data-testid="session-cost" title="Cost tracking is not implemented yet">—</span>
      <span class="spacer"></span>
      <of-session-actions
        [sessionId]="session().id"
        [state]="session().state"
        [sessionName]="session().name"
        [modelSwitchPending]="modelSwitchPending()"
      />
    </header>
  `,
  styles: `
    .session-header {
      display: flex; align-items: center; gap: .625rem; flex-wrap: wrap;
      padding: .5rem .75rem; border-bottom: 1px solid var(--line); background: var(--panel);
    }
    .emoji, .name {
      border: 1px solid transparent; border-radius: .375rem; background: transparent; color: var(--fg);
      font-family: inherit; padding: 0 .25rem; height: 1.75rem;
    }
    .emoji:hover, .name:hover { border-color: var(--line); }
    .emoji:focus, .name:focus { border-color: var(--accent); outline: 0; }
    .emoji { font-size: 1.125rem; width: 2.25rem; text-align: center; }
    .name { font-weight: 600; font-size: 1rem; width: 9rem; text-overflow: ellipsis; }
    .exit-code { font-family: var(--mono); font-size: .75rem; color: var(--state-closed); }
    .harness { font-size: .75rem; color: var(--mut); border: 1px solid var(--line); border-radius: .375rem; padding: 0 .5rem; }
    .directory { font-family: var(--mono); font-size: .6875rem; color: var(--mut); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 16rem; }
    .cost { font-style: italic; color: var(--faint); font-size: .75rem; }
    .spacer { flex: 1; min-width: .5rem; }
  `,
})
export class SessionHeaderComponent {
  readonly session = input.required<Session>();
  private readonly api = inject(FleetApiService);
  protected readonly exitCodeLabel = exitCodeLabel;
  protected readonly modelSwitchPending = signal(false);
  // Separate busy flags: a name edit and an emoji edit are independent requests, so one in flight
  // must not guard-block the other.
  protected readonly renamingName = signal(false);
  protected readonly renamingEmoji = signal(false);
  protected readonly renameError = signal<string | null>(null);
  // `session` carries a fresh object on every field update (state, model, …), not only on a real
  // session switch — tracking the last-seen id keeps the reset below from firing on every one of
  // those and wiping an in-progress rename's own error.
  private lastSessionId: string | undefined;

  constructor() {
    // A route param change reuses this component instance, so a session switch must not leak the
    // previous session's in-flight rename or rename error into the one now shown.
    effect(() => {
      const id = this.session().id;
      if (id === this.lastSessionId) return;
      this.lastSessionId = id;
      this.renamingName.set(false);
      this.renamingEmoji.set(false);
      this.renameError.set(null);
    });
  }

  renameName(value: string): void {
    const trimmed = value.trim();
    if (!trimmed || trimmed === this.session().name) return;
    void this.rename({ name: trimmed }, this.renamingName);
  }

  renameEmoji(value: string): void {
    const trimmed = value.trim();
    if (!trimmed || trimmed === this.session().emoji) return;
    void this.rename({ emoji: trimmed }, this.renamingEmoji);
  }

  protected cancelNameEdit(input: HTMLInputElement): void {
    input.value = this.session().name;
    input.blur();
  }

  protected cancelEmojiEdit(input: HTMLInputElement): void {
    input.value = this.session().emoji;
    input.blur();
  }

  // This component instance is reused across a route param change, so a rename that settles after the user
  // navigated away leaves `busy`/`renameError` alone: they belong to whichever session is current by then.
  private async rename(patch: { name?: string; emoji?: string }, busy: WritableSignal<boolean>): Promise<void> {
    const sessionId = this.session().id;
    const hasNavigatedAway = () => this.session().id !== sessionId;
    await runGuarded(busy, this.renameError, RENAME_ERROR, () => this.api.renameSession(sessionId, patch), { isStale: hasNavigatedAway });
  }
}
