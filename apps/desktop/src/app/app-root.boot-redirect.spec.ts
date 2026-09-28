import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { NavigationEnd, provideRouter, Router, withComponentInputBinding } from '@angular/router';
import { screen } from '@testing-library/angular/zoneless';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppRoot } from './app-root';
import { routes } from './app.routes';
import { FleetEventsService } from './core/fleet-events.service';

// Hostile black-box QE suite for the P2-U7 boot redirect. Every `it.fails` documents a defect.

const HEALTH_POLL_INTERVAL_MS = 2000;
const SLOW_BOOT_MS = 30_000;
const DEEP_LINK = '/session/x';

function healthResponse(): Response {
  return { ok: true, status: 200, json: () => Promise.resolve({ ok: true }) } as unknown as Response;
}

function stubDaemon({ answersHealth }: { answersHealth: () => Promise<Response> }) {
  const fetchMock = vi.fn((url: string) => (url.endsWith('/health') ? answersHealth() : Promise.reject(new TypeError('Failed to fetch'))));
  vi.stubGlobal('fetch', fetchMock);
  const healthRequestCount = () => fetchMock.mock.calls.filter(([url]) => url.endsWith('/health')).length;
  return { healthRequestCount };
}

const daemonIsDown = (): Promise<Response> => Promise.reject(new TypeError('Failed to fetch'));
const daemonIsUp = (): Promise<Response> => Promise.resolve(healthResponse());
const daemonNeverAnswers = (): Promise<Response> => new Promise<Response>(() => undefined);

function configureAppRoot() {
  TestBed.configureTestingModule({
    providers: [
      provideRouter(routes, withComponentInputBinding()),
      {
        provide: FleetEventsService,
        useValue: { connect: vi.fn(), sessions: signal([]), approvals: signal([]), managers: signal([]), connected: signal(true), snapshotReceived: signal(true) },
      },
    ],
  });
  return TestBed.inject(Router);
}

async function openAppAt(url: string) {
  const router = configureAppRoot();
  await router.navigateByUrl(url);
  const fixture = TestBed.createComponent(AppRoot);
  fixture.detectChanges();
  return { router, fixture };
}

async function letTimePass(milliseconds: number, fixture: { whenStable: () => Promise<unknown> }): Promise<void> {
  await vi.advanceTimersByTimeAsync(milliseconds);
  await fixture.whenStable();
}

describe('AppRoot boot redirect — hostile black-box suite', () => {
  beforeEach(() => vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] }));
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('user opening a deep link while the daemon is down lands on onboarding, outside the shell', async () => {
    stubDaemon({ answersHealth: daemonIsDown });

    const { router, fixture } = await openAppAt(DEEP_LINK);
    await vi.waitFor(() => expect(router.url).toBe('/onboarding'));
    await letTimePass(0, fixture);

    expect(screen.getByTestId('onboarding')).toBeInTheDocument();
    expect(screen.queryByTestId('app-shell')).toBeNull();
  });

  // DEFECT (major, known choice) app-root.ts:27 — the requested URL is dropped: once the daemon is up the user
  // is on onboarding and "Skip to app" goes to "/", so the deep link they opened is lost.
  it.fails('user who opened a deep link while the daemon was down is sent back to it once the daemon is up', async () => {
    const daemon = { answersHealth: daemonIsDown };
    stubDaemon({ answersHealth: () => daemon.answersHealth() });
    const { router, fixture } = await openAppAt(DEEP_LINK);
    await vi.waitFor(() => expect(router.url).toBe('/onboarding'));
    await letTimePass(0, fixture);

    daemon.answersHealth = daemonIsUp;
    await letTimePass(HEALTH_POLL_INTERVAL_MS, fixture);
    await userEvent.click(screen.getByRole('link', { name: /Skip to app/ }));
    await vi.waitFor(() => expect(router.url).not.toBe('/onboarding'));

    expect(router.url).toBe(DEEP_LINK);
  });

  it('user opening /onboarding while the daemon is up is not bounced out of onboarding', async () => {
    stubDaemon({ answersHealth: daemonIsUp });

    const { router, fixture } = await openAppAt('/onboarding');
    await letTimePass(0, fixture);

    expect(router.url).toBe('/onboarding');
    expect(screen.getByTestId('onboarding-step-project')).toBeInTheDocument();
  });

  it('user opening /onboarding while the daemon is down is not redirected in a loop', async () => {
    stubDaemon({ answersHealth: daemonIsDown });
    const router = configureAppRoot();
    await router.navigateByUrl('/onboarding');
    const navigationsAfterBoot: NavigationEnd[] = [];
    router.events.subscribe((event) => event instanceof NavigationEnd && navigationsAfterBoot.push(event));

    const fixture = TestBed.createComponent(AppRoot);
    fixture.detectChanges();
    await letTimePass(HEALTH_POLL_INTERVAL_MS * 3, fixture);

    expect(navigationsAfterBoot).toEqual([]);
    expect(screen.getByTestId('onboarding-step-daemon')).toBeInTheDocument();
  });

  it('user whose daemon has not answered after 30 seconds is left on the page they asked for, with a single /health request', async () => {
    const { healthRequestCount } = stubDaemon({ answersHealth: daemonNeverAnswers });

    const { router, fixture } = await openAppAt(DEEP_LINK);
    await letTimePass(SLOW_BOOT_MS, fixture);

    expect(router.url).toBe(DEEP_LINK);
    expect(healthRequestCount()).toBe(1);
  });

  // DEFECT (minor) fleet-api.service.ts:33 + app-root.ts:23 — the boot check has no timeout: a daemon that accepts the
  // connection and never answers leaves the user on a shell with no data and no explanation, never on onboarding.
  it.fails('user whose daemon has not answered after 30 seconds ends up on onboarding', async () => {
    stubDaemon({ answersHealth: daemonNeverAnswers });

    const { router, fixture } = await openAppAt(DEEP_LINK);
    await letTimePass(SLOW_BOOT_MS, fixture);

    expect(router.url).toBe('/onboarding');
  });

  it('user working when a slow /health finally fails is taken to onboarding, once', async () => {
    let failHealth!: (reason: unknown) => void;
    stubDaemon({ answersHealth: () => new Promise<Response>((_resolve, reject) => (failHealth = reject)) });
    const { router, fixture } = await openAppAt('/inbox');
    await letTimePass(SLOW_BOOT_MS, fixture);
    expect(router.url).toBe('/inbox');

    failHealth(new TypeError('Failed to fetch'));
    await vi.waitFor(() => expect(router.url).toBe('/onboarding'));

    expect(router.url).toBe('/onboarding');
  });

  it('user whose daemon is up at boot is never sent to onboarding, even after the daemon goes away later (the boot check runs once)', async () => {
    const daemon = { answersHealth: daemonIsUp };
    const { healthRequestCount } = stubDaemon({ answersHealth: () => daemon.answersHealth() });
    const { router, fixture } = await openAppAt('/inbox');
    await letTimePass(0, fixture);

    daemon.answersHealth = daemonIsDown;
    await letTimePass(HEALTH_POLL_INTERVAL_MS * 5, fixture);

    expect(router.url).toBe('/inbox');
    expect(healthRequestCount()).toBe(1);
  });
});
