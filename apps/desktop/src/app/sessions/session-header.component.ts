import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import type { Session } from '@openfleet/shared';
import { copyFor } from '../core/error-copy';
import { FleetApiService } from '../core/fleet-api.service';
import { SessionRequestsService } from '../core/session-requests';
import { StateChipComponent } from '../design/state-chip.component';
import { ModelSelectorComponent } from './model-selector.component';
import { PermissionModePickerComponent } from './permission-mode-picker.component';
import { SessionActionsComponent } from './session-actions.component';
import { exitCodeLabel } from './session-close-status';

@Component({
  selector: 'of-session-header',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [StateChipComponent, ModelSelectorComponent, PermissionModePickerComponent, SessionActionsComponent],
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
          <span role="alert" data-testid="session-rename-error" class="of-error">✕ {{ error }}</span>
        }
        <of-state-chip [state]="session().state" [since]="session().stateSince" />
        @if (session().modelDriftedFrom; as previousModel) {
          <span class="drift-chip" data-testid="session-drift-chip" [attr.title]="'The model changed under this session; it was ' + previousModel">⇄ drift</span>
        }
        @if (session().state === 'closed') {
          <span class="exit-code" data-testid="session-exit-code">{{ exitCodeLabel(session().exitCode) }}</span>
        }
        <span class="harness" data-testid="session-harness" title="Harness">{{ session().harness }}</span>
        <span class="directory" data-testid="session-directory" [attr.title]="session().directory">{{ session().directory }}</span>
        <span class="cost" data-testid="session-cost" title="Cost tracking is not implemented yet">—</span>
      </div>
      <of-model-selector [sessionId]="session().id" />
      <of-permission-mode-picker [sessionId]="session().id" [currentMode]="session().permissionMode" />
      <span class="spacer"></span>
      <of-session-actions [sessionId]="session().id" [state]="session().state" [stateSince]="session().stateSince" [sessionName]="session().name" />
    </header>
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
    .exit-code { font-family: var(--mono); font-size: .75rem; color: var(--state-closed); }
    .harness {
      display: inline-flex; align-items: center; height: 1.5rem;
      font-size: .75rem; color: var(--mut); border: 1px solid var(--line); border-radius: .375rem; padding: 0 .5rem;
    }
    .directory { font-family: var(--mono); font-size: .6875rem; color: var(--mut); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 16rem; }
    .cost { font-style: italic; color: var(--mut); font-size: .75rem; }
    .spacer { flex: 1; min-width: .5rem; }
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
