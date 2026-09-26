import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import type { Session } from '@openfleet/shared';
import { StateChipComponent } from '../design/state-chip.component';
import { ModelSelectorComponent } from './model-selector.component';
import { PermissionModePickerComponent } from './permission-mode-picker.component';
import { exitCodeLabel } from './session-close-status';

@Component({
  selector: 'of-session-header',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [StateChipComponent, ModelSelectorComponent, PermissionModePickerComponent],
  template: `
    <header class="session-header" data-testid="session-header">
      <span class="emoji" data-testid="session-emoji" title="Change emoji — not available yet">{{ session().emoji }}</span>
      <span class="name" data-testid="session-name" title="Renaming isn't available yet — no backend route to update a session's name">{{ session().name }}</span>
      <of-state-chip [state]="session().state" />
      @if (session().state === 'closed') {
        <span class="exit-code" data-testid="session-exit-code">{{ exitCodeLabel(session().exitCode) }}</span>
      }
      <span class="harness" data-testid="session-harness" title="Harness">{{ session().harness }}</span>
      <of-model-selector [sessionId]="session().id" />
      <of-permission-mode-picker [sessionId]="session().id" [currentMode]="session().permissionMode" />
      <span class="directory" data-testid="session-directory" [attr.title]="session().directory">{{ session().directory }}</span>
      <span class="cost" data-testid="session-cost" title="Cost tracking is not implemented yet">—</span>
    </header>
  `,
  styles: `
    .session-header {
      display: flex; align-items: center; gap: .625rem; flex-wrap: wrap;
      padding: .5rem .75rem; border-bottom: 1px solid var(--line); background: var(--panel);
    }
    .emoji { font-size: 1.125rem; }
    .name { font-weight: 600; }
    .exit-code { font-family: var(--mono); font-size: .75rem; color: var(--state-closed); }
    .harness { font-size: .75rem; color: var(--mut); border: 1px solid var(--line); border-radius: .375rem; padding: 0 .5rem; }
    .directory { font-family: var(--mono); font-size: .6875rem; color: var(--mut); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 16rem; }
    .cost { font-style: italic; color: var(--faint); font-size: .75rem; }
  `,
})
export class SessionHeaderComponent {
  readonly session = input.required<Session>();
  protected readonly exitCodeLabel = exitCodeLabel;
}
