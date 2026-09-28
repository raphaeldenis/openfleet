import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { NavigationEnd, provideRouter, Router, type Routes, withComponentInputBinding } from '@angular/router';
import { screen } from '@testing-library/angular/zoneless';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppRoot } from './app-root';
import { routes } from './app.routes';
import { FleetEventsService } from './core/fleet-events.service';

// Black-box suite for the P2-U7 boot redirect: what URL the user is on and what they see, never how AppRoot decides.

const HEALTH_POLL_INTERVAL_MS = 2000;
const BOOT_HEALTH_TIMEOUT_MS = 5000;
const DEEP_LINK = '/session/x';
const DAEMON_STEP_HEADING = 'Start the OpenFleet daemon';
const PROJECT_STEP_HEADING = 'Define the project';

function healthResponse(): Response {
  return { ok: true, status: 200, json: () => Promise.resolve({ ok: true }) } as unknown as Response;
}

function sessionsResponse(sessions: unknown[]): Response {
  return { ok: true, status: 200, json: () => Promise.resolve(sessions) } as unknown as Response;
}

const daemonIsDown = (): Promise<Response> => Promise.reject(new TypeError('Failed to fetch'));
const daemonIsUp = (): Promise<Response> => Promise.resolve(healthResponse());
const daemonNeverAnswers = (): Promise<Response> => new Promise<Response>(() => undefined);

function stubDaemon({ answersHealth, fleet = [] }: { answersHealth: () => Promise<Response>; fleet?: unknown[] }) {
  const daemon = { answersHealth, fleet };
  const fetchMock = vi.fn((url: string) => {
    if (url.endsWith('/health')) return daemon.answersHealth();
    if (url.endsWith('/api/sessions')) return Promise.resolve(sessionsResponse(daemon.fleet));
    return Promise.reject(new TypeError('Failed to fetch'));
  });
  vi.stubGlobal('fetch', fetchMock);
  const healthRequestCount = () => fetchMock.mock.calls.filter(([url]) => url.endsWith('/health')).length;
  return { daemon, healthRequestCount };
}

function configureAppRoot(appRoutes: Routes = routes) {
  TestBed.configureTestingModule({
    providers: [
      provideRouter(appRoutes, withComponentInputBinding()),
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

describe('AppRoot boot redirect', () => {
  beforeEach(() => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }));
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('user opening a deep link while the daemon is down lands on onboarding, outside the shell', async () => {
    stubDaemon({ answersHealth: daemonIsDown });

    const { router, fixture } = await openAppAt(DEEP_LINK);
    await vi.waitFor(() => expect(router.url).toBe('/onboarding'));
    await letTimePass(0, fixture);

    expect(screen.getByRole('heading', { name: DAEMON_STEP_HEADING })).toBeInTheDocument();
    expect(screen.queryByRole('navigation')).toBeNull();
  });

  it('user who opened a deep link while the daemon was down is sent back to it as soon as the daemon is up', async () => {
    const { daemon } = stubDaemon({ answersHealth: daemonIsDown });
    const { router, fixture } = await openAppAt(DEEP_LINK);
    await vi.waitFor(() => expect(router.url).toBe('/onboarding'));
    await letTimePass(0, fixture);

    daemon.answersHealth = daemonIsUp;
    await letTimePass(HEALTH_POLL_INTERVAL_MS, fixture);

    await vi.waitFor(() => expect(router.url).toBe(DEEP_LINK));
  });

  it('user who opened a deep link while the daemon was down and skips onboarding is taken to that link', async () => {
    stubDaemon({ answersHealth: daemonIsDown });
    const { router, fixture } = await openAppAt(DEEP_LINK);
    await vi.waitFor(() => expect(router.url).toBe('/onboarding'));
    await letTimePass(0, fixture);

    await userEvent.setup({ advanceTimers: vi.advanceTimersByTime }).click(screen.getByRole('link', { name: /Skip to app/ }));

    await vi.waitFor(() => expect(router.url).toBe(DEEP_LINK));
  });

  it('user sent back to a deep link that then fails to open lands on the project step instead of staying on the daemon step', async () => {
    const { daemon } = stubDaemon({ answersHealth: daemonIsDown });
    let visitsToDeepLink = 0;
    const opensOnlyOnTheFirstVisit = () => {
      visitsToDeepLink += 1;
      if (visitsToDeepLink > 1) throw new Error('route failed to load');
      return true;
    };
    const router = configureAppRoot([{ path: 'session/:id', canActivate: [opensOnlyOnTheFirstVisit], children: [] }, ...routes]);
    await router.navigateByUrl(DEEP_LINK);
    const fixture = TestBed.createComponent(AppRoot);
    fixture.detectChanges();
    await vi.waitFor(() => expect(router.url).toBe('/onboarding'));
    await letTimePass(0, fixture);

    daemon.answersHealth = daemonIsUp;
    await letTimePass(HEALTH_POLL_INTERVAL_MS, fixture);

    await vi.waitFor(() => expect(screen.getByRole('heading', { name: PROJECT_STEP_HEADING })).toBeInTheDocument());
  });

  it('user sent back to a deep link that the router refuses to open lands on the project step instead of staying on the daemon step', async () => {
    const { daemon } = stubDaemon({ answersHealth: daemonIsDown });
    let visitsToDeepLink = 0;
    const opensOnlyOnTheFirstVisit = () => {
      visitsToDeepLink += 1;
      return visitsToDeepLink === 1;
    };
    const router = configureAppRoot([{ path: 'session/:id', canActivate: [opensOnlyOnTheFirstVisit], children: [] }, ...routes]);
    await router.navigateByUrl(DEEP_LINK);
    const fixture = TestBed.createComponent(AppRoot);
    fixture.detectChanges();
    await vi.waitFor(() => expect(router.url).toBe('/onboarding'));
    await letTimePass(0, fixture);

    daemon.answersHealth = daemonIsUp;
    await letTimePass(HEALTH_POLL_INTERVAL_MS, fixture);

    await vi.waitFor(() => expect(screen.getByRole('heading', { name: PROJECT_STEP_HEADING })).toBeInTheDocument());
  });

  it('returning user whose daemon was simply down, with sessions in the fleet, is sent back to the app', async () => {
    const { daemon } = stubDaemon({ answersHealth: daemonIsDown });
    const { router, fixture } = await openAppAt('/');
    await vi.waitFor(() => expect(router.url).toBe('/onboarding'));
    await letTimePass(0, fixture);

    daemon.fleet = [{ id: 's-1' }];
    daemon.answersHealth = daemonIsUp;
    await letTimePass(HEALTH_POLL_INTERVAL_MS, fixture);

    await vi.waitFor(() => expect(router.url).toBe('/'));
  });

  it('first-run user with an empty fleet, on the app home, continues onboarding with the project once the daemon is up', async () => {
    const { daemon } = stubDaemon({ answersHealth: daemonIsDown });
    const { router, fixture } = await openAppAt('/');
    await vi.waitFor(() => expect(router.url).toBe('/onboarding'));
    await letTimePass(0, fixture);

    daemon.answersHealth = daemonIsUp;
    await letTimePass(HEALTH_POLL_INTERVAL_MS, fixture);

    expect(screen.getByRole('heading', { name: PROJECT_STEP_HEADING })).toBeInTheDocument();
    expect(router.url).toBe('/onboarding');
  });

  it('user opening /onboarding while the daemon is up is not bounced out of onboarding', async () => {
    stubDaemon({ answersHealth: daemonIsUp });

    const { router, fixture } = await openAppAt('/onboarding');
    await letTimePass(0, fixture);

    expect(router.url).toBe('/onboarding');
    expect(screen.getByRole('heading', { name: PROJECT_STEP_HEADING })).toBeInTheDocument();
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
    expect(screen.getByRole('heading', { name: DAEMON_STEP_HEADING })).toBeInTheDocument();
  });

  it('user whose daemon has not answered yet is left on the page they asked for, with a single /health request', async () => {
    const { healthRequestCount } = stubDaemon({ answersHealth: daemonNeverAnswers });

    const { router, fixture } = await openAppAt(DEEP_LINK);
    await letTimePass(BOOT_HEALTH_TIMEOUT_MS - 1000, fixture);

    expect(router.url).toBe(DEEP_LINK);
    expect(healthRequestCount()).toBe(1);
  });

  it('user whose daemon has not answered after 5 seconds ends up on onboarding', async () => {
    stubDaemon({ answersHealth: daemonNeverAnswers });

    const { router, fixture } = await openAppAt(DEEP_LINK);
    await letTimePass(BOOT_HEALTH_TIMEOUT_MS, fixture);

    await vi.waitFor(() => expect(router.url).toBe('/onboarding'));
  });

  it('user working when a slow /health finally fails is taken to onboarding, once', async () => {
    let failHealth!: (reason: unknown) => void;
    stubDaemon({ answersHealth: () => new Promise<Response>((_resolve, reject) => (failHealth = reject)) });
    const { router, fixture } = await openAppAt('/inbox');
    await letTimePass(BOOT_HEALTH_TIMEOUT_MS - 2000, fixture);
    expect(router.url).toBe('/inbox');

    failHealth(new TypeError('Failed to fetch'));
    await vi.waitFor(() => expect(router.url).toBe('/onboarding'));

    expect(router.url).toBe('/onboarding');
  });

  it('user whose daemon is up at boot is never sent to onboarding, even after the daemon goes away later (the boot check runs once)', async () => {
    const { daemon, healthRequestCount } = stubDaemon({ answersHealth: daemonIsUp });
    const { router, fixture } = await openAppAt('/inbox');
    await letTimePass(0, fixture);

    daemon.answersHealth = daemonIsDown;
    await letTimePass(HEALTH_POLL_INTERVAL_MS * 5, fixture);

    expect(router.url).toBe('/inbox');
    expect(healthRequestCount()).toBe(1);
  });
});
