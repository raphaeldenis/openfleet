import { Component, inject, output } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { FleetApiService } from '../core/fleet-api.service';
import { FleetEventsService } from '../core/fleet-events.service';

@Component({
  selector: 'of-session-list',
  imports: [FormsModule],
  template: `
    <ul class="sessions">
      @for (session of events.sessions(); track session.id) {
        <li
          [attr.data-testid]="'session-' + session.id"
          (click)="selected.emit(session.id)"
          [class.closed]="session.state === 'closed'"
        >
          <span class="name">{{ session.emoji }} {{ session.name }}</span>
          <span class="state" [attr.data-testid]="'session-' + session.id + '-state'" [attr.data-state]="session.state">{{ session.state }}</span>
        </li>
      }
    </ul>
    <form (ngSubmit)="create()">
      <input name="directory" [(ngModel)]="directory" placeholder="/path/to/worktree" required />
      <input name="name" [(ngModel)]="name" placeholder="Name" required />
      <input name="emoji" [(ngModel)]="emoji" size="2" />
      <button type="submit">+ New session</button>
    </form>
  `,
  styles: `
    .sessions { list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column }
    li { display: flex; justify-content: space-between; padding: 0.4rem 0.6rem; cursor: pointer }
    li.closed { opacity: 0.5 }
    .state[data-state='waiting_permission'] { color: #d97706 }
    .state[data-state='generating'] { color: #2563eb }
    form { display: flex; flex-direction: column; gap: 0.4rem; padding: 0.6rem }
  `,
})
export class SessionListComponent {
  readonly events = inject(FleetEventsService);
  private readonly api = inject(FleetApiService);
  readonly selected = output<string>();
  directory = '';
  name = '';
  emoji = '🤖';

  async create(): Promise<void> {
    await this.api.createSession({ directory: this.directory, name: this.name, emoji: this.emoji });
    this.name = '';
  }
}
