import { Component, inject, signal } from '@angular/core';
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
  protected readonly selectedId = signal<string | null>(null);

  constructor() {
    void this.events.connect();
  }
}
