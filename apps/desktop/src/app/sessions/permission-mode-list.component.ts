import { ChangeDetectionStrategy, Component, computed, model, signal } from '@angular/core';
import { PERMISSION_MODES, type PermissionMode } from '@openfleet/shared';
import { INHERITED_EXPLANATION, PERMISSION_MODE_EXPLANATIONS } from './permission-mode-picker.component';

const INHERITED_MODE = '';
const DANGEROUS_MODE: PermissionMode = 'bypassPermissions';

export type ChosenPermissionMode = PermissionMode | typeof INHERITED_MODE;

interface PermissionModeOption {
  value: ChosenPermissionMode;
  label: string;
  explanation: string;
  isDangerous: boolean;
}

const PERMISSION_MODE_OPTIONS: ReadonlyArray<PermissionModeOption> = [
  { value: INHERITED_MODE, label: 'inherited', explanation: INHERITED_EXPLANATION, isDangerous: false },
  ...PERMISSION_MODES.map((mode) => ({ value: mode, label: mode, explanation: PERMISSION_MODE_EXPLANATIONS[mode], isDangerous: mode === DANGEROUS_MODE })),
];

@Component({
  selector: 'of-permission-mode-list',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="permission-mode-list">
      <span class="of-label" id="permission-mode-list-label">Permission mode</span>
      <div class="options" role="radiogroup" aria-labelledby="permission-mode-list-label" data-testid="new-session-permission-mode">
        @for (option of options; track option.label) {
          <label class="option" [attr.data-selected]="option.value === shownValue() ? '1' : null" [attr.data-dangerous]="option.isDangerous ? '1' : null">
            <input
              type="radio" name="permission-mode" [value]="option.value" [checked]="option.value === shownValue()"
              [attr.aria-labelledby]="'permission-mode-name-' + option.label" [attr.aria-describedby]="'permission-mode-explanation-' + option.label"
              (change)="choose(option)"
            />
            <span class="name" [id]="'permission-mode-name-' + option.label">{{ option.label }}</span>
            <span class="explanation" [id]="'permission-mode-explanation-' + option.label">{{ option.explanation }}</span>
          </label>
        }
      </div>
      @if (isConfirmingDangerousMode()) {
        <div class="confirm" data-testid="new-session-permission-mode-bypass-confirm-row">
          <span role="alert" class="of-error">✕ {{ dangerousModeWarning }}</span>
          <button type="button" class="of-btn of-btn--secondary" (click)="cancelDangerousMode()">Cancel</button>
          <button type="button" class="of-btn of-btn--primary" (click)="confirmDangerousMode()">Confirm</button>
        </div>
      }
    </div>
  `,
  styles: `
    .permission-mode-list { display: flex; flex-direction: column; gap: .375rem; min-width: 0 }
    .options { display: flex; flex-direction: column; gap: .125rem }
    .option { display: flex; align-items: center; gap: .5rem; min-height: 1.625rem; padding: 0 .5rem; border: 1px solid var(--line); border-radius: .375rem; cursor: pointer }
    .option[data-selected='1'] { border-color: var(--accent) }
    .option[data-dangerous='1'] .name { color: var(--state-error) }
    .option[data-dangerous='1'][data-selected='1'] { border-color: var(--state-error) }
    .option:has(input:focus-visible) { outline: 2px solid var(--accent); outline-offset: -2px }
    input { flex: none; margin: 0 }
    .name { flex: none; width: 8rem; font-family: var(--mono); font-size: .75rem }
    .explanation { flex: 1; min-width: 0; font-size: .6875rem; color: var(--mut) }
    .confirm { display: flex; align-items: center; flex-wrap: wrap; gap: .375rem }
  `,
})
export class PermissionModeListComponent {
  readonly value = model<ChosenPermissionMode>(INHERITED_MODE);
  protected readonly options = PERMISSION_MODE_OPTIONS;
  protected readonly dangerousModeWarning = PERMISSION_MODE_EXPLANATIONS[DANGEROUS_MODE];
  protected readonly isConfirmingDangerousMode = signal(false);
  protected readonly shownValue = computed(() => (this.isConfirmingDangerousMode() ? DANGEROUS_MODE : this.value()));

  protected choose(option: PermissionModeOption): void {
    this.isConfirmingDangerousMode.set(option.isDangerous);
    if (!option.isDangerous) this.value.set(option.value);
  }

  protected cancelDangerousMode(): void {
    this.isConfirmingDangerousMode.set(false);
  }

  protected confirmDangerousMode(): void {
    this.isConfirmingDangerousMode.set(false);
    this.value.set(DANGEROUS_MODE);
  }
}
