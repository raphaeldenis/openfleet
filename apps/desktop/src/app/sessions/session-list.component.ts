import { Component, inject, output } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { MANAGER_ROLE, type Session } from '@openfleet/shared';
import { FleetApiService } from '../core/fleet-api.service';
import { FleetEventsService } from '../core/fleet-events.service';
import { StateChipComponent } from '../design/state-chip.component';
import { ManagerCardComponent } from '../managers/manager-card.component';
import { NewManagerFormComponent } from '../managers/new-manager-form.component';

@Component({
  selector: 'of-session-list',
  imports: [FormsModule, StateChipComponent, ManagerCardComponent, NewManagerFormComponent],
  template: `
    <ul class="sessions">
      @for (session of roots(); track session.id) {
        <li>
          <button
            type="button"
            class="row"
            [attr.data-testid]="'session-' + session.id"
            [attr.aria-label]="session.name + ' — ' + session.state"
            (click)="onSessionClick(session)"
            [class.closed]="session.state === 'closed'"
          >
            <span class="name">{{ session.emoji }} {{ session.name }}</span>
            <of-state-chip [state]="session.state" />
          </button>
        </li>
        @if (managerOf(session.id); as manager) {
          <li><of-manager-card [manager]="manager" [session]="session" /></li>
        }
        @for (child of childrenOf(session.id); track child.id) {
          <li>
            <button
              type="button"
              class="row child"
              [attr.data-testid]="'session-' + child.id"
              [attr.aria-label]="child.name + ' — ' + child.state"
              (click)="onSessionClick(child)"
              [class.closed]="child.state === 'closed'"
            >
              <span class="name">{{ child.emoji }} {{ child.name }}</span>
              <of-state-chip [state]="child.state" />
            </button>
          </li>
          @if (managerOf(child.id); as childManager) {
            <li><of-manager-card [manager]="childManager" [session]="child" /></li>
          }
        }
      }
    </ul>
    <form (ngSubmit)="create()">
      <input name="directory" [(ngModel)]="directory" placeholder="/path/to/worktree" required />
      <input name="name" [(ngModel)]="name" placeholder="Name" required />
      <input name="emoji" [(ngModel)]="emoji" size="2" />
      <button type="submit" class="of-btn of-btn--secondary">+ New session</button>
    </form>
    <of-new-manager-form />
  `,
  styles: `
    .sessions { list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column }
    .row {
      display: flex; align-items: center; justify-content: space-between; gap: .5rem;
      padding: .4rem .6rem; cursor: pointer; width: 100%; border: none; background: none;
      font: inherit; color: inherit; text-align: left;
    }
    .row.closed { opacity: .5 }
    .row.child { padding-left: 1.6rem; margin-left: .75rem; border-left: 1px solid var(--line-2) }
    .row:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px }
    form { display: flex; flex-direction: column; gap: .4rem; padding: .6rem }
  `,
})
export class SessionListComponent {
  readonly events = inject(FleetEventsService);
  private readonly api = inject(FleetApiService);
  private readonly router = inject(Router);
  readonly selected = output<string>();
  directory = '';
  name = '';
  emoji = '🤖';

  // ponytail: one level of indentation (manager -> direct children); recursive grouping if managers-of-managers ships
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

  async create(): Promise<void> {
    await this.api.createSession({ directory: this.directory, name: this.name, emoji: this.emoji });
    this.name = '';
  }
}
