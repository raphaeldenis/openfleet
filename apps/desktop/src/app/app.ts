import { Component, inject, signal } from '@angular/core';
import { FleetEventsService } from './core/fleet-events.service';
import { SessionListComponent } from './sessions/session-list.component';
import { TerminalComponent } from './sessions/terminal.component';

@Component({
  imports: [SessionListComponent, TerminalComponent],
  selector: 'app-root',
  styleUrl: './app.scss',
  templateUrl: './app.html',
})
export class App {
  private readonly events = inject(FleetEventsService);
  protected readonly selectedId = signal<string | null>(null);

  constructor() {
    void this.events.connect();
  }
}
