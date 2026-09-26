import { Component, inject } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { FleetEventsService } from './core/fleet-events.service';

@Component({
  selector: 'app-root',
  imports: [RouterOutlet],
  template: `<router-outlet />`,
})
export class AppRoot {
  // Starts the fleet event socket regardless of which route is active — a direct load or
  // refresh of /manager/:id never mounts App, so App's constructor cannot be relied on for this.
  constructor() {
    void inject(FleetEventsService).connect();
  }
}
