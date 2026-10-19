import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router, withComponentInputBinding } from '@angular/router';
import type { NotificationTrigger } from '@openfleet/shared';
import { Subject } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppRoot } from './app-root';
import { routes } from './app.routes';
import { FleetEventsService } from './core/fleet-events.service';
import { NativeNotifications } from './core/native-notifications.service';
import { silentWorkingStateSignals } from './working-state/working-state-fixtures';

// Black-box: a clicked system banner takes the user to the route it carried.

function stubDaemonUp() {
  const response = { ok: true, status: 200, json: () => Promise.resolve({ ok: true }) } as unknown as Response;
  vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(response)));
}

function openAppWithBannerClicks() {
  let clickBanner: (route: string) => void = () => undefined;
  const triggers = new Subject<NotificationTrigger>();
  const notifications = {
    isAvailable: true,
    show: vi.fn(async () => 'delivered' as const),
    setDockBadge: vi.fn(async () => undefined),
    onBannerClick: vi.fn(async (handler: (route: string) => void) => {
      clickBanner = handler;
      return () => undefined;
    }),
  };
  TestBed.configureTestingModule({
    providers: [
      provideRouter(routes, withComponentInputBinding()),
      { provide: NativeNotifications, useValue: notifications },
      {
        provide: FleetEventsService,
        useValue: { connect: vi.fn(), sessions: signal([]), approvals: signal([]), managers: signal([]), notificationTriggers: triggers, connected: signal(true), snapshotReceived: signal(true), ...silentWorkingStateSignals() },
      },
    ],
  });
  const router = TestBed.inject(Router);
  const fixture = TestBed.createComponent(AppRoot);
  fixture.detectChanges();
  return { router, fixture, notifications, triggers, clickBanner: (route: string) => clickBanner(route) };
}

describe('AppRoot banner click', () => {
  beforeEach(stubDaemonUp);
  afterEach(() => vi.unstubAllGlobals());

  it('user clicking a system banner lands on the route the banner carried', async () => {
    const { router, clickBanner } = openAppWithBannerClicks();
    await router.navigateByUrl('/inbox');

    clickBanner('/session/abc');

    await vi.waitFor(() => expect(router.url).toBe('/session/abc'));
  });

  it('user whose agent finished while the app was running gets a system banner, with the Dock badge cleared', async () => {
    const { notifications, triggers } = openAppWithBannerClicks();
    await vi.waitFor(() => expect(notifications.setDockBadge).toHaveBeenCalledWith(0));

    triggers.next({ category: 'agentFinished', sessionId: 's1' });

    await vi.waitFor(() => expect(notifications.show).toHaveBeenCalledWith(expect.objectContaining({ body: 'Finished', route: '/session/s1' })));
  });
});
