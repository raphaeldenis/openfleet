import { ChangeDetectionStrategy, Component, ElementRef, inject, input, model } from '@angular/core';

export interface ChoiceCard {
  value: string;
  label: string;
  hint?: string;
  isAvailable?: boolean;
  unavailableReason?: string;
}

let nextGroupNumber = 0;

@Component({
  selector: 'of-choice-cards',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="group" role="radiogroup" [attr.aria-label]="label()">
      @for (card of cards(); track card.value) {
        <label class="card" [attr.title]="card.isAvailable === false ? card.unavailableReason : null" [attr.data-selected]="card.value === value() ? '1' : null" [attr.data-unavailable]="card.isAvailable === false ? '1' : null">
          <input type="radio" [name]="groupName" [value]="card.value" [checked]="card.value === value()" [disabled]="card.isAvailable === false" [attr.aria-disabled]="isLocked() ? 'true' : null" (change)="choose(card)" />
          <span class="name">{{ card.label }}</span>
          @if (card.hint) {<span class="hint">{{ card.hint }}</span>}
        </label>
      }
    </div>
  `,
  styles: `
    .group { display: flex; gap: .375rem }
    .card { position: relative; flex: 1; min-width: 0; display: flex; flex-direction: column; justify-content: center; gap: .125rem; min-height: 2rem; padding: .375rem .625rem; border: 1px solid var(--line); border-radius: .375rem; cursor: pointer }
    .card[data-selected='1'] { border-color: var(--accent); background: var(--accent-bg) }
    .card[data-unavailable='1'] { color: var(--mut); cursor: not-allowed }
    .card:has(input:focus-visible) { outline: .125rem solid var(--accent); outline-offset: -.125rem }
    input { position: absolute; opacity: 0; inset: 0; margin: 0; cursor: inherit }
    .name { font-size: .75rem }
    .hint { font-size: .6875rem; color: var(--mut) }
  `,
})
export class ChoiceCardsComponent {
  readonly label = input.required<string>();
  readonly cards = input.required<ReadonlyArray<ChoiceCard>>();
  readonly value = model.required<string>();
  readonly isLocked = input(false);
  protected readonly groupName = `choice-cards-${nextGroupNumber++}`;

  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);

  protected choose(card: ChoiceCard): void {
    const isUnavailable = card.isAvailable === false;
    if (this.isLocked() || isUnavailable) return this.recheckShownCard();
    this.value.set(card.value);
  }

  private recheckShownCard(): void {
    const radios = this.host.nativeElement.querySelectorAll<HTMLInputElement>('input[type=radio]');
    radios.forEach((radio) => (radio.checked = radio.value === this.value()));
  }
}
