import { Component, computed, inject, output, signal } from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import { Router, RouterLink } from '@angular/router';
import { MANAGER_ROLE, type Session } from '@openfleet/shared';
import { FleetApiService } from '../core/fleet-api.service';
import { FleetEventsService } from '../core/fleet-events.service';
import { childrenOfInList, closedSessionCountOf, groupByProject, readShowClosedPreference, rootsOfSessionList, writeShowClosedPreference } from './session-filter';
import { StateChipComponent } from '../design/state-chip.component';
import { showInvisibleControlsAsEscapes } from '../core/bidi-escapes';
import { ManagerCardComponent } from '../managers/manager-card.component';
import { OverdueChipComponent } from '../working-state/overdue-chip.component';

@Component({
  selector: 'of-session-list',
  imports: [RouterLink, NgTemplateOutlet, StateChipComponent, ManagerCardComponent, OverdueChipComponent],
  template: `
    @if (closedCount() > 0 || showClosed()) {
      <button
        type="button"
        class="of-btn of-btn--secondary of-btn--compact show-closed"
        data-testid="show-closed-toggle"
        [attr.aria-pressed]="showClosed()"
        (click)="toggleShowClosed()"
      >Show closed ({{ closedCount() }})</button>
    }
    <ul class="sessions">
      @for (group of groups(); track group.projectId) {
        @if (group.label) {
          <li class="group-title"><h3>{{ group.label }}</h3></li>
        }
        @for (session of group.sessions; track session.id) {
          <ng-container [ngTemplateOutlet]="node" [ngTemplateOutletContext]="{ $implicit: session }" />
        }
      }
      @if (roots().length === 0) {
        <li class="empty">{{ emptyMessage() }}</li>
      }
    </ul>
    <ng-template #node let-session>
      <li>
        <button
          type="button"
          class="row"
          [class.child]="!!session.parentId"
          [class.closed]="session.state === 'closed'"
          [attr.data-testid]="'session-' + session.id"
          [attr.aria-label]="visibleNameOf(session) + ' — ' + session.state"
          (click)="onSessionClick(session)"
        >
          <span class="name" [attr.title]="visibleNameOf(session)">{{ session.emoji }} {{ visibleNameOf(session) }}</span>
          <span class="meta">
            @if (!managerOf(session.id)) {
              <of-overdue-chip [session]="session" [compact]="true" />
            }
            <of-state-chip [state]="session.state" />
            <span class="rung" title="Model rung">{{ session.model || '—' }}</span>
            <span class="cost" title="Cost tracking is not implemented yet">—</span>
          </span>
        </button>
      </li>
      @if (managerOf(session.id); as manager) {
        <li><of-manager-card [manager]="manager" [session]="session" /></li>
      }
      @if (childrenOf(session.id); as children) {
        @if (children.length > 0) {
          <ul class="children">
            @for (child of children; track child.id) {
              <ng-container [ngTemplateOutlet]="node" [ngTemplateOutletContext]="{ $implicit: child }" />
            }
          </ul>
        }
      }
    </ng-template>
    <div class="new-links">
      <a class="of-btn of-btn--secondary" routerLink="/new" data-testid="new-session-link">+ New session</a>
      <a class="of-btn of-btn--secondary" routerLink="/new" [queryParams]="{ mode: 'manager' }" data-testid="new-manager-link">+ New manager</a>
    </div>
  `,
  styles: `
    :host { display: flex; flex-direction: column; flex: 1; min-height: 0 }
    .sessions { list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; flex: 1; min-height: 0; overflow-y: auto }
    .children { list-style: none; padding: 0 0 0 1.6rem; margin: 0 0 0 .75rem; border-left: 1px solid var(--line-2); display: flex; flex-direction: column }
    .row {
      display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: .125rem .5rem;
      padding: .4rem .6rem; cursor: pointer; width: 100%; border: none; background: none;
      font: inherit; color: inherit; text-align: left; min-width: 0;
    }
    .show-closed { align-self: flex-start; margin: .25rem .75rem }
    .group-title h3 { margin: 0; padding: .4rem .75rem .125rem; font-size: .6875rem; font-weight: 600; letter-spacing: .06em; text-transform: uppercase; color: var(--mut) }
    .empty { padding: .4rem .75rem; font-size: .75rem; color: var(--mut) }
    .row.closed { opacity: .5 }
    .row:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px }
    .row .name { flex: 1 1 6rem; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap }
    .row .meta { display: flex; flex-wrap: wrap; align-items: center; gap: .125rem .375rem; flex: 0 1 auto; min-width: 0; font-size: .6875rem; color: var(--mut); font-family: var(--mono) }
    .new-links { display: flex; flex: none; gap: .375rem; padding: .6rem }
    .new-links a { flex: 1; justify-content: center; text-decoration: none }
  `,
})
export class SessionListComponent {
  readonly events = inject(FleetEventsService);
  private readonly router = inject(Router);
  readonly selected = output<string>();

  private readonly api = inject(FleetApiService);
  protected readonly showClosed = signal(readShowClosedPreference());
  private readonly projectNames = signal<ReadonlyMap<string, string>>(new Map());

  protected readonly roots = computed(() => rootsOfSessionList(this.events.sessions(), { showClosed: this.showClosed() }));
  protected readonly groups = computed(() => groupByProject(this.roots(), this.projectNames()));
  protected readonly closedCount = computed(() => closedSessionCountOf(this.events.sessions()));
  protected readonly emptyMessage = computed(() => (this.showClosed() ? 'No sessions' : 'No active sessions'));

  constructor() {
    void this.loadProjectNames();
  }

  private async loadProjectNames(): Promise<void> {
    try {
      const { items } = await this.api.listProjects();
      this.projectNames.set(new Map(items.map((project) => [project.id, project.name])));
    } catch {
      // Group headers fall back to "Unknown project" until the next load succeeds.
    }
  }

  protected toggleShowClosed(): void {
    const showClosed = !this.showClosed();
    this.showClosed.set(showClosed);
    writeShowClosedPreference(showClosed);
  }

  childrenOf(parentId: string): Session[] {
    return childrenOfInList(this.events.sessions(), parentId, { showClosed: this.showClosed() });
  }

  visibleNameOf(session: Session): string {
    return showInvisibleControlsAsEscapes(session.name);
  }

  managerOf(sessionId: string) {
    return this.events.managers().find((m) => m.sessionId === sessionId);
  }

  onSessionClick(session: Session): void {
    if (session.role === MANAGER_ROLE) {
      void this.router.navigate(['/manager', session.id]);
      return;
    }
    this.selected.emit(session.id);
  }
}
