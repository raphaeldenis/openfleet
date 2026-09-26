import { Component, inject, signal } from '@angular/core';
import { ActivatedRoute } from '@angular/router';
import { FleetEventsService } from './core/fleet-events.service';
import { InboxComponent } from './inbox/inbox.component';
import { SessionListComponent } from './sessions/session-list.component';
import { TerminalComponent } from './sessions/terminal.component';

@Component({
  imports: [SessionListComponent, TerminalComponent, InboxComponent],
  selector: 'of-app-shell',
  styleUrl: './app.scss',
  templateUrl: './app.html',
})
export class App {
  protected readonly events = inject(FleetEventsService);
  // A dashboard's "Terminal" button navigates here with ?session=<id> to open that
  // session's terminal; the query param only needs to seed the initial selection.
  private readonly requestedSessionId = inject(ActivatedRoute).snapshot.queryParamMap.get('session');
  protected readonly selectedId = signal<string | null>(this.requestedSessionId);
}
