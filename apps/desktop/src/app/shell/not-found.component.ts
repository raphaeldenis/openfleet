import { ChangeDetectionStrategy, Component } from '@angular/core';
import { RouterLink } from '@angular/router';

@Component({
  selector: 'of-not-found',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink],
  template: `
    <div class="empty" data-testid="not-found">
      <p>Page not found.</p>
      <a routerLink="/">Back to Sessions</a>
    </div>
  `,
  styles: `
    .empty { flex: 1; display: flex; flex-direction: column; gap: .5rem; align-items: center; justify-content: center; color: var(--mut); text-align: center; padding: 2rem; }
  `,
})
export class NotFoundComponent {}
