import { afterNextRender, ChangeDetectionStrategy, Component, computed, ElementRef, inject, Injector, input, model, signal, viewChild } from '@angular/core';
import { PERMISSION_MODES, type PermissionMode } from '@openfleet/shared';
import { INHERITED_EXPLANATION, PERMISSION_MODE_EXPLANATIONS } from './permission-mode-picker.component';

export const INHERITED_MODE = '';
const DANGEROUS_MODE: PermissionMode = 'bypassPermissions';

export type ChosenPermissionMode = PermissionMode | typeof INHERITED_MODE;

interface PermissionModeOption {
  value: ChosenPermissionMode;
  label: string;
  explanation: string;
  isDangerous: boolean;
}

const MODES_ENDING_ON_THE_DANGEROUS_ONE: ReadonlyArray<PermissionMode> = [...PERMISSION_MODES.filter((mode) => mode !== DANGEROUS_MODE), DANGEROUS_MODE];

const PERMISSION_MODE_OPTIONS: ReadonlyArray<PermissionModeOption> = [
  { value: INHERITED_MODE, label: 'inherited', explanation: INHERITED_EXPLANATION, isDangerous: false },
  ...MODES_ENDING_ON_THE_DANGEROUS_ONE.map((mode) => ({ value: mode, label: mode, explanation: PERMISSION_MODE_EXPLANATIONS[mode], isDangerous: mode === DANGEROUS_MODE })),
];
const ARROW_KEYS = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']);

@Component({
  selector: 'of-permission-mode-list',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="permission-mode-list" (keydown.escape)="cancelDangerousModeOnEscape()">
      <span class="of-label" id="permission-mode-list-label">Permission mode</span>
      <div class="options" role="radiogroup" aria-labelledby="permission-mode-list-label" data-testid="new-session-permission-mode" (keydown)="blockArrowsWhileLocked($event)">
        @for (option of options; track option.label) {
          <label class="option" [attr.title]="option.explanation" [attr.data-selected]="option.value === shownValue() ? '1' : null" [attr.data-dangerous]="option.isDangerous ? '1' : null">
            <input
              type="radio" name="permission-mode" [value]="option.value" [checked]="option.value === shownValue()" [attr.aria-disabled]="isLocked() ? 'true' : null"
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
          @if (isAnswerDemanded()) {
            <span role="status" class="of-error" data-testid="new-session-permission-mode-answer-hint">Confirm or cancel this warning before creating.</span>
          }
          <button type="button" class="of-btn of-btn--secondary" (click)="cancelDangerousMode()">Cancel</button>
          <button #confirmButton type="button" class="of-btn of-btn--primary" (click)="confirmDangerousMode()">Confirm</button>
        </div>
      }
    </div>
  `,
  styles: `
    .permission-mode-list { display: flex; flex-direction: column; gap: .375rem; min-width: 0 }
    .options { display: flex; flex-direction: column; gap: .125rem }
    .option { display: flex; align-items: center; gap: .5rem; height: 1.625rem; padding: 0 .5rem; border: 1px solid var(--line); border-radius: .375rem; cursor: pointer }
    .option[data-selected='1'] { border-color: var(--accent); background: var(--accent-bg) }
    .option[data-dangerous='1'] .name { color: var(--state-error) }
    .option[data-dangerous='1'][data-selected='1'] { border-color: var(--state-error); background: color-mix(in oklch, var(--state-error) 12%, transparent) }
    .option:has(input:focus-visible) { outline: 2px solid var(--accent); outline-offset: -2px }
    input { flex: none; margin: 0; accent-color: var(--accent) }
    .option[data-dangerous='1'][data-selected='1'] input { accent-color: var(--state-error) }
    .name { flex: none; width: 8rem; font-family: var(--mono); font-size: .75rem }
    .explanation { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: .6875rem; color: var(--mut) }
    .confirm { display: flex; align-items: center; flex-wrap: wrap; gap: .375rem }
  `,
})
export class PermissionModeListComponent {
  readonly value = model<ChosenPermissionMode>(INHERITED_MODE);
  readonly isLocked = input(false);
  protected readonly options = PERMISSION_MODE_OPTIONS;
  protected readonly dangerousModeWarning = PERMISSION_MODE_EXPLANATIONS[DANGEROUS_MODE];
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly injector = inject(Injector);
  private readonly confirmButton = viewChild<ElementRef<HTMLButtonElement>>('confirmButton');
  readonly isConfirmingDangerousMode = signal(false);
  protected readonly isAnswerDemanded = signal(false);
  protected readonly shownValue = computed(() => (this.isConfirmingDangerousMode() ? DANGEROUS_MODE : this.value()));

  demandAnswer(): void {
    this.isAnswerDemanded.set(true);
    this.confirmButton()?.nativeElement.focus();
  }

  protected blockArrowsWhileLocked(event: KeyboardEvent): void {
    const isArrowKey = ARROW_KEYS.has(event.key);
    if (this.isLocked() && isArrowKey) event.preventDefault();
  }

  protected choose(option: PermissionModeOption): void {
    if (this.isLocked()) return this.recheckShownRadio();
    this.isConfirmingDangerousMode.set(option.isDangerous);
    this.isAnswerDemanded.set(false);
    if (!option.isDangerous) this.value.set(option.value);
  }

  protected cancelDangerousMode(): void {
    this.closeWarning();
    this.focusCheckedRadioAfterRender();
  }

  protected confirmDangerousMode(): void {
    this.closeWarning();
    this.value.set(DANGEROUS_MODE);
    this.focusCheckedRadioAfterRender();
  }

  protected cancelDangerousModeOnEscape(): void {
    if (this.isConfirmingDangerousMode()) this.cancelDangerousMode();
  }

  private recheckShownRadio(): void {
    const radios = this.host.nativeElement.querySelectorAll<HTMLInputElement>('input[type=radio]');
    radios.forEach((radio, index) => (radio.checked = this.options[index]?.value === this.shownValue()));
  }

  private closeWarning(): void {
    this.isConfirmingDangerousMode.set(false);
    this.isAnswerDemanded.set(false);
  }

  private focusCheckedRadioAfterRender(): void {
    afterNextRender(() => this.host.nativeElement.querySelector<HTMLInputElement>('input[type=radio]:checked')?.focus(), { injector: this.injector });
  }
}
