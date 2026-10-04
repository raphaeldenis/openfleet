import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';
import { HANDOFF_SECTION_MAX_CHARACTERS, type HandoffSectionSource } from '@openfleet/shared';

const SOURCE_CAPTION: Record<HandoffSectionSource, string> = {
  working_state: 'from the state panel',
  git: 'from git',
  session: 'from the state panel',
  manager: 'from the state panel',
  none: 'write it here',
};

let nextFieldId = 0;

@Component({
  selector: 'of-handoff-section-field',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <label class="label" [attr.for]="textareaId">{{ label() }}</label>
    <textarea
      class="text"
      rows="3"
      [id]="textareaId"
      [attr.placeholder]="placeholder() || null"
      [attr.maxlength]="maxCharacters"
      [value]="value()"
      [disabled]="disabled()"
      [attr.aria-describedby]="caption() ? captionId : null"
      (input)="valueChange.emit($any($event.target).value)"
    ></textarea>
    @if (caption(); as sourceCaption) {
      <span class="caption" [id]="captionId">{{ sourceCaption }}</span>
    }
  `,
  styles: `
    :host { display: flex; flex-direction: column; gap: .25rem; min-width: 0; }
    .label { color: var(--mut); font-size: .6875rem; font-weight: 600; text-transform: uppercase; letter-spacing: .04em; }
    .text {
      width: 100%; box-sizing: border-box; resize: vertical; min-height: 3.5rem; padding: .375rem .5rem;
      border: 1px solid var(--line); border-radius: .375rem; background: var(--sunk); color: var(--fg);
      font: inherit; font-size: .75rem; line-height: 1.45;
    }
    .caption { color: var(--mut); font-size: .6875rem; }
  `,
})
export class HandoffSectionFieldComponent {
  readonly label = input.required<string>();
  readonly value = input.required<string>();
  readonly source = input<HandoffSectionSource>();
  readonly placeholder = input('');
  readonly disabled = input(false);
  readonly valueChange = output<string>();

  protected readonly maxCharacters = HANDOFF_SECTION_MAX_CHARACTERS;
  protected readonly textareaId = `of-handoff-field-${nextFieldId}`;
  protected readonly captionId = `of-handoff-field-caption-${nextFieldId++}`;
  protected readonly caption = computed(() => {
    const source = this.source();
    return source ? SOURCE_CAPTION[source] : '';
  });
}
