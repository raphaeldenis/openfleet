import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { MAX_TODO_ITEMS } from './todos.adapter';

@Component({
  selector: 'of-todos-tab',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: ``,
})
export class TodosTabComponent {
  readonly sessionId = input<string | undefined>(undefined);
  readonly sessionClosed = input(false);
  readonly connected = input(true);
  readonly renderCap = input(MAX_TODO_ITEMS);
}
