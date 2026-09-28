import { TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { signal } from '@angular/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppRoot } from './app-root';
import { routes } from './app.routes';
import { FleetEventsService } from './core/fleet-events.service';

function stubDaemon({ isUp }: { isUp: boolean }) {
  const fetchMock = vi.fn((url: string) =>
    url.endsWith('/health') && isUp
      ? Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ ok: true }) } as unknown as Response)
      : Promise.reject(new TypeError('Failed to fetch')),
  );
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function configureAppRoot() {
  TestBed.configureTestingModule({
    providers: [
      provideRouter(routes),
      {
        provide: FleetEventsService,
        useValue: { connect: vi.fn(), sessions: signal([]), approvals: signal([]), managers: signal([]), connected: signal(true), snapshotReceived: signal(true) },
      },
    ],
  });
}

describe('AppRoot', () => {
  beforeEach(() => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }));
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('user opening the app while the daemon is unreachable lands on onboarding', async () => {
    stubDaemon({ isUp: false });
    configureAppRoot();

    TestBed.createComponent(AppRoot).detectChanges();

    await vi.waitFor(() => expect(TestBed.inject(Router).url).toBe('/onboarding'));
  });

  it('user opening the app while the daemon is up stays on the page they asked for', async () => {
    const fetchMock = stubDaemon({ isUp: true });
    configureAppRoot();
    const router = TestBed.inject(Router);
    await router.navigateByUrl('/inbox');

    TestBed.createComponent(AppRoot).detectChanges();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledWith(expect.stringMatching(/\/health$/), expect.anything()));
    await vi.advanceTimersByTimeAsync(0);

    expect(router.url).toBe('/inbox');
  });

  it('connects to the fleet event stream when only the manager dashboard route is active (a direct load or refresh of /manager/:id)', async () => {
    stubDaemon({ isUp: true });
    const connect = vi.fn();
    TestBed.configureTestingModule({
      providers: [
        provideRouter(routes),
        {
          provide: FleetEventsService,
          useValue: { connect, sessions: signal([]), approvals: signal([]), managers: signal([]), connected: signal(true), snapshotReceived: signal(true) },
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
