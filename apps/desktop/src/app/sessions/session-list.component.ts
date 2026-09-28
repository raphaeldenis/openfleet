import { Component, inject, output } from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import { Router, RouterLink } from '@angular/router';
import { MANAGER_ROLE, type Session } from '@openfleet/shared';
import { FleetEventsService } from '../core/fleet-events.service';
import { StateChipComponent } from '../design/state-chip.component';
import { ManagerCardComponent } from '../managers/manager-card.component';

@Component({
  selector: 'of-session-list',
  imports: [RouterLink, NgTemplateOutlet, StateChipComponent, ManagerCardComponent],
  template: `
    <ul class="sessions">
      @for (session of roots(); track session.id) {
        <ng-container [ngTemplateOutlet]="node" [ngTemplateOutletContext]="{ $implicit: session }" />
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
          [attr.aria-label]="session.name + ' — ' + session.state"
          (click)="onSessionClick(session)"
        >
          <span class="name" [attr.title]="session.name">{{ session.emoji }} {{ session.name }}</span>
          <span class="meta">
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
      display: flex; align-items: center; justify-content: space-between; gap: .5rem;
      padding: .4rem .6rem; cursor: pointer; width: 100%; border: none; background: none;
      font: inherit; color: inherit; text-align: left; min-width: 0;
    }
    .row.closed { opacity: .5 }
    .row:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px }
    .row .name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap }
    .row .meta { display: flex; align-items: center; gap: .375rem; flex: none; font-size: .6875rem; color: var(--faint); font-family: var(--mono) }
    .new-links { display: flex; flex: none; gap: .375rem; padding: .6rem }
    .new-links a { flex: 1; justify-content: center; text-decoration: none }
  `,
})
export class SessionListComponent {
  readonly events = inject(FleetEventsService);
  private readonly router = inject(Router);
  readonly selected = output<string>();

  roots(): Session[] {
    const sessions = this.events.sessions();
    const sessionIds = new Set(sessions.map((s) => s.id));
    const hasNoParent = (session: Session) => !session.parentId;
    const isOrphanedChild = (session: Session) => !!session.parentId && !sessionIds.has(session.parentId);
    return sessions.filter((session) => hasNoParent(session) || isOrphanedChild(session));
  }

  childrenOf(parentId: string): Session[] {
    return this.events.sessions().filter((s) => s.parentId === parentId);
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
