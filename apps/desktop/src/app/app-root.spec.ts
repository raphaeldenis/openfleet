import { TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { signal } from '@angular/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppRoot } from './app-root';
import { routes } from './app.routes';
import { FleetEventsService } from './core/fleet-events.service';
import { silentWorkingStateSignals } from './working-state/working-state-fixtures';

function stubDaemonIsUp() {
  const daemonAnswersHealth = () => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ ok: true }) } as unknown as Response);
  vi.stubGlobal('fetch', vi.fn(daemonAnswersHealth));
}

describe('AppRoot', () => {
  beforeEach(() => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }));
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('connects to the fleet event stream when only the manager dashboard route is active (a direct load or refresh of /manager/:id)', async () => {
    stubDaemonIsUp();
    const connect = vi.fn();
    TestBed.configureTestingModule({
      providers: [
        provideRouter(routes),
        {
          provide: FleetEventsService,
          useValue: { connect, sessions: signal([]), approvals: signal([]), managers: signal([]), connected: signal(true), snapshotReceived: signal(true), ...silentWorkingStateSignals() },
        },
      ],
    });

    const fixture = TestBed.createComponent(AppRoot);
    fixture.detectChanges();
    const router = TestBed.inject(Router);
    await router.navigateByUrl('/manager/m1');
    fixture.detectChanges();

    expect(connect).toHaveBeenCalledTimes(1);
  });
});
