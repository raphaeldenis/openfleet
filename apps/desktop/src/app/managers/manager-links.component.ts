import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { RouterLink } from '@angular/router';
import type { ManagerView } from '@openfleet/shared';

/** Where a manager's mission note and log table open: the notes and tables screens, on the project of the manager. */
@Component({
  selector: 'of-manager-links',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink],
  template: `
    @if (missionNoteQuery(); as query) {
      <a class="link" routerLink="/notes" [queryParams]="query" [attr.data-testid]="'manager-' + manager().sessionId + '-mission-note-link'">Mission note</a>
      @if (manager().pinMissionNote) {
        <span class="pinned" [attr.data-testid]="'manager-' + manager().sessionId + '-mission-note-pinned'">pinned</span>
      }
    }
    @if (logTableQuery(); as query) {
      <a class="link" routerLink="/tables" [queryParams]="query" [attr.data-testid]="'manager-' + manager().sessionId + '-log-table-link'">Log table</a>
    }
  `,
  styles: `
    :host { display: contents }
    .link { color: var(--accent); text-decoration: none }
    .link:hover, .link:focus-visible { text-decoration: underline }
    .pinned { color: var(--mut) }
  `,
})
export class ManagerLinksComponent {
  readonly manager = input.required<ManagerView>();
  readonly projectId = input<string | undefined>(undefined);

  protected readonly missionNoteQuery = computed(() => {
    const noteId = this.manager().missionNoteId;
    return noteId === undefined ? undefined : { projectId: this.projectId(), noteId };
  });

  protected readonly logTableQuery = computed(() => {
    const storeId = this.manager().logStoreId;
    return storeId === undefined ? undefined : { projectId: this.projectId(), storeId };
  });
}
