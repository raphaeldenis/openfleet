import { render, screen } from '@testing-library/angular/zoneless';
import userEvent from '@testing-library/user-event';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OnboardingComponent } from './onboarding.component';

const HEALTH_POLL_INTERVAL_MS = 2000;
const DEFERRED_STEP_NAMES = ['Providers', 'Playbooks', 'Team'];
const DAEMON_STEP_HEADING = 'Start the OpenFleet daemon';
const PROJECT_STEP_HEADING = 'Define the project';

function jsonResponse(body: unknown): Response {
  return { ok: true, status: 200, json: () => Promise.resolve(body) } as unknown as Response;
}

function stubDaemon() {
  const daemon = { isUp: false };
  const fetchMock = vi.fn((url: string, init?: RequestInit) => {
    if (url.endsWith('/health')) return daemon.isUp ? Promise.resolve(jsonResponse({ ok: true })) : Promise.reject(new TypeError('Failed to fetch'));
    if (url.endsWith('/api/sessions')) return Promise.resolve(jsonResponse(init?.method === 'POST' ? { id: 's-new' } : []));
    return Promise.reject(new Error(`unexpected request to ${url}`));
  });
  vi.stubGlobal('fetch', fetchMock);
  const healthRequestCount = () => fetchMock.mock.calls.filter(([url]) => url.endsWith('/health')).length;
  const createSessionRequestBody = () => {
    const createRequest = fetchMock.mock.calls.find(([url, init]) => url.endsWith('/api/sessions') && init?.method === 'POST');
    return JSON.parse(createRequest?.[1]?.body as string);
  };
  return { daemon, healthRequestCount, createSessionRequestBody };
}

async function renderOnboarding() {
  const view = await render(OnboardingComponent, { providers: [provideRouter([{ path: '**', children: [] }])] });
  return { ...view, router: TestBed.inject(Router) };
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
      expect(deferredStep).toHaveAttribute('aria-disabled', 'true');
      expect(deferredStep).toHaveTextContent('Available in a later phase');
    }
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

  it('user waiting on the daemon step has /health checked every 2 seconds', async () => {
    const { healthRequestCount } = stubDaemon();
    const { fixture } = await renderOnboarding();
    const requestsOnArrival = healthRequestCount();

    await letTimePass(HEALTH_POLL_INTERVAL_MS, fixture);
    await letTimePass(HEALTH_POLL_INTERVAL_MS, fixture);

    expect(healthRequestCount()).toBe(requestsOnArrival + 2);
    expect(screen.getByRole('heading', { name: DAEMON_STEP_HEADING })).toBeInTheDocument();
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

  it('user creates the first session from the new-session form, pre-filled with the repository path and a safe seeded prompt, and lands on it', async () => {
    const { daemon, createSessionRequestBody } = stubDaemon();
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const { fixture, router } = await renderOnboarding();
    daemon.isUp = true;
    await letTimePass(HEALTH_POLL_INTERVAL_MS, fixture);
    await user.type(screen.getByLabelText('Repository path'), '/Users/me/repo');
    await user.click(screen.getByRole('button', { name: 'Continue' }));

    expect(screen.getByLabelText('Directory')).toHaveValue('/Users/me/repo');
    await user.click(screen.getByRole('button', { name: 'Create session' }));

    await vi.waitFor(() => expect(router.url).toBe('/session/s-new'));
    const { directory, seededPrompt } = createSessionRequestBody();
    expect(directory).toBe('/Users/me/repo');
    expect(seededPrompt).toMatch(/do not (modify|change|edit)/i);
  });

  it('user can skip onboarding and go straight to the app', async () => {
    stubDaemon();
    await renderOnboarding();

    expect(screen.getByRole('link', { name: /Skip to app/ })).toHaveAttribute('href', '/');
  });
});
