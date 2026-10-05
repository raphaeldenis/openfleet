import { Component, computed, inject, output, signal } from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import { Router, RouterLink } from '@angular/router';
import { MANAGER_ROLE, type Session } from '@openfleet/shared';
import { FleetApiService } from '../core/fleet-api.service';
import { FleetEventsService } from '../core/fleet-events.service';
import { WatchedSession } from '../core/watched-session';
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
          <li class="group-title">
            @if (group.projectId; as projectId) {
              <h3><a class="project-home" [routerLink]="['/project', projectId]" title="Open project home">⌂ {{ group.label }}</a></h3>
              <a class="new-in-project" routerLink="/new" [queryParams]="{ projectId }" [attr.aria-label]="'New session in ' + group.label" [title]="'New session in ' + group.label">+</a>
            } @else {
              <h3>{{ group.label }}</h3>
              <a class="new-in-project" routerLink="/new" aria-label="New session without a project" title="New session without a project">+</a>
            }
          </li>
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
          [attr.aria-current]="session.id === watchedSessionId() ? 'true' : null"
          [attr.data-testid]="'session-' + session.id"
          [attr.aria-label]="visibleNameOf(session) + ' — ' + session.state"
          (click)="onSessionClick(session)"
        >
          <span class="tile" aria-hidden="true">{{ session.emoji }}</span>
          <span class="text">
            <span class="title-line">
              <span class="name" [attr.title]="visibleNameOf(session)">{{ visibleNameOf(session) }}</span>
              @if (!managerOf(session.id)) {
                <of-overdue-chip [session]="session" [compact]="true" />
              }
              <span class="cost" title="Cost tracking is not implemented yet">—</span>
            </span>
            <span class="detail-line">
              <of-state-chip [state]="session.state" />
              <span class="rung" title="Model rung">{{ session.model || '—' }}</span>
            </span>
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
  `,
  styles: `
    :host { display: flex; flex-direction: column; flex: 1; min-height: 0 }
    .sessions { list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; flex: 1; min-height: 0; overflow-y: auto }
    .children { list-style: none; padding: 0 0 0 1.6rem; margin: 0 0 0 .75rem; border-left: 1px solid var(--line-2); display: flex; flex-direction: column }
    .row {
      display: flex; align-items: center; gap: .5rem;
      padding: .4rem .6rem; cursor: pointer; width: 100%; border: none; background: none;
      font: inherit; color: inherit; text-align: left; min-width: 0;
    }
    .tile { display: flex; flex: none; align-items: center; justify-content: center; width: 1.5rem; height: 1.5rem; border: 1px solid var(--line); border-radius: .375rem; background: var(--sunk) }
    .text { display: flex; flex-direction: column; flex: 1; gap: .125rem; min-width: 0 }
    .title-line { display: flex; align-items: center; gap: .375rem; min-width: 0 }
    .detail-line { display: flex; align-items: center; gap: .375rem; font-size: .6875rem; color: var(--mut); font-family: var(--mono); --chip-height: 1.125rem; --chip-font-size: .6875rem }
    .show-closed { align-self: flex-start; margin: .25rem .75rem }
    .group-title { display: flex; align-items: center; gap: .375rem; padding: .4rem .75rem .125rem }
    .group-title h3 { flex: 1; min-width: 0; margin: 0; font-size: .6875rem; font-weight: 600; letter-spacing: .06em; text-transform: uppercase; color: var(--mut) }
    .project-home { color: inherit; text-decoration: none }
    .project-home:hover, .project-home:focus-visible { color: var(--fg) }
    .new-in-project { flex: none; padding: 0 .25rem; color: var(--mut); font-size: .875rem; line-height: 1; text-decoration: none }
    .new-in-project:hover, .new-in-project:focus-visible { color: var(--fg) }
    .empty { padding: .4rem .75rem; font-size: .75rem; color: var(--mut) }
    .row:hover { background: var(--hover) }
    .row[aria-current='true'] { background: var(--active); box-shadow: inset 2px 0 0 var(--accent); font-weight: 500 }
    .row.closed { opacity: .5 }
    .row:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px }
    .row .name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap }
    .row .cost { flex: none; font-size: .6875rem; color: var(--mut); font-family: var(--mono) }
  `,
})
export class SessionListComponent {
  readonly events = inject(FleetEventsService);
  private readonly router = inject(Router);
  protected readonly watchedSessionId = inject(WatchedSession).id;
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
