import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import type { TodoCounts } from './todos.adapter';

/** A bar showing the share of completed todos. Named, it is a progressbar; unnamed, it only decorates a text that already says the numbers. */
@Component({
  selector: 'of-todo-progress',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="track" [attr.role]="ariaLabel() ? 'progressbar' : null" [attr.aria-hidden]="ariaLabel() ? null : 'true'"
         [attr.aria-label]="ariaLabel() ?? null" [attr.aria-valuemin]="ariaLabel() ? 0 : null"
         [attr.aria-valuemax]="ariaLabel() ? counts().total : null" [attr.aria-valuenow]="ariaLabel() ? counts().completed : null"
         [attr.aria-valuetext]="ariaLabel() ? valueText() : null">
      <div class="fill" [style.width.%]="percent()"></div>
    </div>
  `,
  styles: `
    :host { display: block; }
    .track { height: .375rem; border-radius: .1875rem; background: var(--sunk); border: 1px solid var(--line); overflow: hidden; }
    .fill { height: 100%; min-width: .25rem; background: var(--state-waiting-permission); }
  `,
})
export class TodoProgressComponent {
  readonly counts = input.required<TodoCounts>();
  readonly ariaLabel = input<string | undefined>(undefined);
  readonly valueText = input('');

  protected readonly percent = computed(() => {
    const { completed, total } = this.counts();
    return total > 0 ? (completed / total) * 100 : 0;
  });
}
