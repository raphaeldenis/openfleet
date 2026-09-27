import { ChangeDetectionStrategy, Component } from '@angular/core';

@Component({
  selector: 'of-empty-state',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="empty" data-testid="empty-state">
      <p>Select a session from the sidebar to open its terminal.</p>
    </div>
  `,
  styles: `
    .empty { flex: 1; display: flex; align-items: center; justify-content: center; color: var(--mut); text-align: center; padding: 2rem; }
  `,
})
export class EmptyStateComponent {}
