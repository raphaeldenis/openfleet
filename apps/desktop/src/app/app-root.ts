import { Location } from '@angular/common';
import { Component, DestroyRef, Injector, inject } from '@angular/core';
import { Router, RouterOutlet } from '@angular/router';
import { FleetApiService } from './core/fleet-api.service';
import { FleetEventsService } from './core/fleet-events.service';
import { NativeNotifications } from './core/native-notifications.service';
import { VersionsService } from './core/versions.service';

@Component({
  selector: 'app-root',
  imports: [RouterOutlet],
  template: `<router-outlet />`,
})
export class AppRoot {
  // Starts the fleet event socket regardless of which route is active — a direct load or
  // refresh of /manager/:id never mounts App, so App's constructor cannot be relied on for this.
  private readonly api = inject(FleetApiService);
  private readonly versions = inject(VersionsService);
  private readonly router = inject(Router);
  private readonly injector = inject(Injector);
  private isDestroyed = false;
  private readonly location = inject(Location);

  constructor() {
    void inject(FleetEventsService).connect();
    inject(DestroyRef).onDestroy(() => (this.isDestroyed = true));
    void inject(NativeNotifications).onBannerClick((route) => void this.router.navigateByUrl(route));
    void this.startNotifications();
    void this.sendToOnboardingWhenDaemonIsUnreachable();
  }

  /** Loads banners and the Dock badge outside the initial bundle: nothing needs them before the first event. */
  private async startNotifications(): Promise<void> {
    const [{ NotificationDispatcher }, { DockBadgeService }] = await Promise.all([
      import('./core/notification-dispatcher.service'),
      import('./core/dock-badge.service'),
    ]);
    if (this.isDestroyed) return;
    this.injector.get(NotificationDispatcher);
    this.injector.get(DockBadgeService);
  }

  private async sendToOnboardingWhenDaemonIsUnreachable(): Promise<void> {
    const health = await this.api.health().catch(() => null);
    this.versions.recordDaemonHealth(health);
    const isDaemonUp = health !== null;
    if (isDaemonUp) return;
    // The browser location, not `router.url`: the first navigation may still be running when a refused connection fails fast.
    const requestedUrl = this.location.path() || '/';
    const isAlreadyOnboarding = requestedUrl.startsWith('/onboarding');
    if (isAlreadyOnboarding) return;
    await this.router.navigateByUrl('/onboarding', { state: { returnUrl: requestedUrl } });
  }
}
