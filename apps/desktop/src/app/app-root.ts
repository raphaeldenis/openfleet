import { Component, inject } from '@angular/core';
import { Router, RouterOutlet } from '@angular/router';
import { FleetApiService } from './core/fleet-api.service';
import { FleetEventsService } from './core/fleet-events.service';

@Component({
  selector: 'app-root',
  imports: [RouterOutlet],
  template: `<router-outlet />`,
})
export class AppRoot {
  // Starts the fleet event socket regardless of which route is active — a direct load or
  // refresh of /manager/:id never mounts App, so App's constructor cannot be relied on for this.
  private readonly api = inject(FleetApiService);
  private readonly router = inject(Router);

  constructor() {
    void inject(FleetEventsService).connect();
    void this.sendToOnboardingWhenDaemonIsUnreachable();
  }

  private async sendToOnboardingWhenDaemonIsUnreachable(): Promise<void> {
    const isDaemonUp = await this.api.health().then(
      () => true,
      () => false,
    );
    if (!isDaemonUp) await this.router.navigateByUrl('/onboarding');
  }
}
