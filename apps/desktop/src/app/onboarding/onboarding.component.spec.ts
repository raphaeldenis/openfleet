import { TestBed } from '@angular/core/testing';
import { render, screen } from '@testing-library/angular/zoneless';
import userEvent from '@testing-library/user-event';
import { provideRouter } from '@angular/router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { APP_VERSION_READER } from '../core/app-version';
import { VersionsService } from '../core/versions.service';
import { OnboardingComponent } from './onboarding.component';

const HEALTH_POLL_INTERVAL_MS = 2000;
const DEFERRED_STEP_NAMES = ['Providers', 'Playbooks', 'Team'];
const DAEMON_STEP_HEADING = 'Start the OpenFleet daemon';
const PROJECT_STEP_HEADING = 'Define the project';

function jsonResponse(body: unknown): Response {
  return { ok: true, status: 200, json: () => Promise.resolve(body) } as unknown as Response;
}

function stubDaemon() {
  const daemon: { isUp: boolean; version?: unknown } = { isUp: false };
  const fetchMock = vi.fn((url: string) => {
    if (url.endsWith('/health')) return daemon.isUp ? Promise.resolve(jsonResponse({ ok: true, version: daemon.version })) : Promise.reject(new TypeError('Failed to fetch'));
    if (url.endsWith('/api/sessions')) return Promise.resolve(jsonResponse([]));
    return Promise.reject(new Error(`unexpected request to ${url}`));
  });
  vi.stubGlobal('fetch', fetchMock);
  const healthRequestCount = () => fetchMock.mock.calls.filter(([url]) => url.endsWith('/health')).length;
  return { daemon, healthRequestCount };
}

function renderOnboarding({ appVersion = '0.1.0' }: { appVersion?: string } = {}) {
  return render(OnboardingComponent, {
    providers: [provideRouter([{ path: '**', children: [] }]), { provide: APP_VERSION_READER, useValue: () => Promise.resolve(appVersion) }],
  });
}

async function letTimePass(milliseconds: number, fixture: { whenStable: () => Promise<unknown> }): Promise<void> {
  await vi.advanceTimersByTimeAsync(milliseconds);
  await fixture.whenStable();
}

describe('OnboardingComponent', () => {
  beforeEach(() => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }));
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('user sees the six-step stepper with the daemon step current and the three unbacked steps marked as coming later', async () => {
    stubDaemon();
    await renderOnboarding();

    const steps = screen.getAllByRole('listitem');

    expect(steps.map((step) => step.textContent)).toEqual([
      expect.stringContaining('Daemon'),
      expect.stringContaining('Providers'),
      expect.stringContaining('Project'),
      expect.stringContaining('Playbooks'),
      expect.stringContaining('Team'),
      expect.stringContaining('First session'),
    ]);
    expect(steps[0]).toHaveAttribute('aria-current', 'step');
    for (const deferredName of DEFERRED_STEP_NAMES) {
      const deferredStep = steps.find((step) => step.textContent?.includes(deferredName));
      expect(deferredStep).not.toHaveAttribute('aria-disabled');
      expect(deferredStep).toHaveTextContent('Available in a later phase');
    }
  });

  it('user is told no daemon answers on the configured address', async () => {
    stubDaemon();
    await renderOnboarding();

    expect(screen.getByText('No daemon on 127.0.0.1:7331')).toBeInTheDocument();
    expect(screen.queryByText('Daemon not found')).toBeNull();
    expect(screen.queryByRole('heading', { name: 'The daemon could not start' })).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Start it yourself' })).toBeNull();
  });

  it('user is told to start the daemon with pnpm dev:core, with no CLI install or token to paste', async () => {
    stubDaemon();
    const { container } = await renderOnboarding();

    expect(container).toHaveTextContent('Start the daemon: pnpm dev:core in the OpenFleet folder');
    expect(container.textContent).not.toMatch(/openfleetd|brew install/i);
    expect(screen.queryByRole('textbox')).toBeNull();
  });

  it('user copying the command gets exactly `pnpm dev:core` in the clipboard', async () => {
    stubDaemon();
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    await renderOnboarding();

    await user.click(screen.getByRole('button', { name: 'Copy command' }));

    expect(await navigator.clipboard.readText()).toBe('pnpm dev:core');
  });

  it('user sees onboarding move on to the project step once the daemon answers, and /health is no longer polled', async () => {
    const { daemon, healthRequestCount } = stubDaemon();
    const { fixture } = await renderOnboarding();

    daemon.isUp = true;
    await letTimePass(HEALTH_POLL_INTERVAL_MS, fixture);
    const requestsWhenAdvanced = healthRequestCount();
    await letTimePass(HEALTH_POLL_INTERVAL_MS * 5, fixture);

    expect(screen.getByRole('heading', { name: PROJECT_STEP_HEADING })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: DAEMON_STEP_HEADING })).toBeNull();
    expect(healthRequestCount()).toBe(requestsWhenAdvanced);
  });

  it('user starting the daemon after the app sees its version recorded, so About shows it and the mismatch is detected', async () => {
    const { daemon } = stubDaemon();
    daemon.version = '0.2.0';
    const { fixture } = await renderOnboarding({ appVersion: '0.1.0' });
    const versions = TestBed.inject(VersionsService);
    await versions.loadAppVersion();

    daemon.isUp = true;
    await letTimePass(HEALTH_POLL_INTERVAL_MS, fixture);

    expect(versions.daemonVersion()).toBe('0.2.0');
    expect(versions.mismatch()).toEqual({ appVersion: '0.1.0', daemonVersion: '0.2.0' });
  });

  it('user starting a daemon that reports no version keeps the daemon version unknown', async () => {
    const { daemon } = stubDaemon();
    const { fixture } = await renderOnboarding({ appVersion: '0.1.0' });
    const versions = TestBed.inject(VersionsService);

    daemon.isUp = true;
    await letTimePass(HEALTH_POLL_INTERVAL_MS, fixture);

    expect(versions.daemonVersion()).toBeNull();
    expect(versions.isDaemonVersionSettled()).toBe(true);
  });

  it('user leaving the page stops the /health polling', async () => {
    const { healthRequestCount } = stubDaemon();
    const { fixture } = await renderOnboarding();
    await letTimePass(HEALTH_POLL_INTERVAL_MS, fixture);
    expect(healthRequestCount()).toBeGreaterThan(1);

    fixture.destroy();
    const requestsAtLeave = healthRequestCount();
    await vi.advanceTimersByTimeAsync(HEALTH_POLL_INTERVAL_MS * 5);

    expect(healthRequestCount()).toBe(requestsAtLeave);
  });

  it('user cannot continue from the project step without typing the repository path', async () => {
    const { daemon } = stubDaemon();
    const { fixture } = await renderOnboarding();
    daemon.isUp = true;
    await letTimePass(HEALTH_POLL_INTERVAL_MS, fixture);

    expect(screen.getByRole('button', { name: 'Continue' })).toBeDisabled();

    await userEvent.setup({ advanceTimers: vi.advanceTimersByTime }).type(screen.getByLabelText('Repository path'), '/Users/me/repo');

    expect(screen.getByRole('button', { name: 'Continue' })).toBeEnabled();
  });

});
