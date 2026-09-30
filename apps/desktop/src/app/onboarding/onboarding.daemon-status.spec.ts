import { Router, provideRouter } from '@angular/router';
import { TestBed } from '@angular/core/testing';
import { render, screen } from '@testing-library/angular/zoneless';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DAEMON_STATUS_PORT, DaemonStatus } from '../core/daemon-status.service';
import { OnboardingComponent } from './onboarding.component';

const POLL_INTERVAL_MS = 1000;
const READY_BEAT_MS = 1200;
const POLL_CAP_MS = 6 * 60 * 1000;
const STARTING_COPY = 'Starting the daemon…';
const SLOW_COPY = 'First launch can take up to a minute — macOS checks the app once.';
const FAILED_HEADING = 'The daemon could not start';
const PROJECT_STEP_HEADING = 'Define the project';
const MANUAL_CARD_COMMAND = 'pnpm dev:core';

function jsonResponse(body: unknown): Response {
  return { ok: true, status: 200, json: () => Promise.resolve(body) } as unknown as Response;
}

function stubDaemonHttp({ isUp = false, sessions = [] as unknown[] } = {}) {
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string) => {
      if (url.endsWith('/health')) return isUp ? Promise.resolve(jsonResponse({ ok: true })) : Promise.reject(new TypeError('Failed to fetch'));
      if (url.endsWith('/api/sessions')) return Promise.resolve(jsonResponse(sessions));
      return Promise.reject(new Error(`unexpected request to ${url}`));
    }),
  );
}

function fakeDaemonStatusPort(initial: DaemonStatus) {
  let next: DaemonStatus | Error = initial;
  const read = vi.fn(() => (next instanceof Error ? Promise.reject(next) : Promise.resolve(next)));
  return { port: { read }, read, report: (status: DaemonStatus | Error) => (next = status) };
}

function renderUnderTauri(port: { read: () => Promise<DaemonStatus> } | null) {
  return render(OnboardingComponent, {
    providers: [provideRouter([{ path: '**', children: [] }]), { provide: DAEMON_STATUS_PORT, useValue: port }],
  });
}

async function renderAfterFirstStatusRead(port: { read: () => Promise<DaemonStatus> }) {
  const rendered = await renderUnderTauri(port);
  await vi.advanceTimersByTimeAsync(0);
  await rendered.fixture.whenStable();
  return rendered;
}

async function letTimePass(milliseconds: number, fixture: { whenStable: () => Promise<unknown> }): Promise<void> {
  await vi.advanceTimersByTimeAsync(milliseconds);
  await fixture.whenStable();
}

describe('OnboardingComponent daemon step under Tauri', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    stubDaemonHttp();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('user sees the daemon starting with no manual command to run', async () => {
    const { port } = fakeDaemonStatusPort({ state: 'starting' });

    const { container } = await renderUnderTauri(port);

    expect(screen.getByRole('status')).toHaveTextContent(STARTING_COPY);
    expect(container).not.toHaveTextContent(MANUAL_CARD_COMMAND);
    expect(container).not.toHaveTextContent(SLOW_COPY);
  });

  it('user is told the first launch can be slow once the daemon reports a slow start', async () => {
    const { port, report } = fakeDaemonStatusPort({ state: 'starting' });
    const { fixture } = await renderUnderTauri(port);

    report({ state: 'slow', startedSecondsAgo: 16 });
    await letTimePass(POLL_INTERVAL_MS, fixture);

    expect(screen.getByRole('status')).toHaveTextContent(STARTING_COPY);
    expect(screen.getByRole('status')).toHaveTextContent(SLOW_COPY);
  });

  it('user sees the daemon ready, then the project step after a short beat', async () => {
    const { port, report } = fakeDaemonStatusPort({ state: 'starting' });
    const { fixture } = await renderUnderTauri(port);

    report({ state: 'ready', daemonVersion: '0.9.2' });
    await letTimePass(POLL_INTERVAL_MS, fixture);
    expect(screen.getByRole('status')).toHaveTextContent('Daemon ready · core 0.9.2');
    expect(screen.queryByRole('heading', { name: PROJECT_STEP_HEADING })).toBeNull();
    await letTimePass(READY_BEAT_MS, fixture);

    expect(screen.getByRole('heading', { name: PROJECT_STEP_HEADING })).toBeInTheDocument();
  });

  it('user with a daemon already running sees it ready without a version when it reports none', async () => {
    const { port } = fakeDaemonStatusPort({ state: 'reused' });

    await renderAfterFirstStatusRead(port);

    expect(screen.getByRole('status')).toHaveTextContent(/^\s*✓?\s*Daemon ready\s*$/);
  });

  it('user returning to the app is sent on once, even when the health check and the status both see the daemon', async () => {
    stubDaemonHttp({ isUp: true, sessions: [{ id: 's1' }] });
    const { port } = fakeDaemonStatusPort({ state: 'ready' });
    const { fixture } = await renderUnderTauri(port);
    const navigate = vi.spyOn(TestBed.inject(Router), 'navigateByUrl');

    await letTimePass(READY_BEAT_MS * 3, fixture);

    expect(navigate).toHaveBeenCalledTimes(1);
  });

  it('user sees the last line of a failed daemon, the manual command and a way to check again', async () => {
    const { port } = fakeDaemonStatusPort({ state: 'failed', lastLine: 'error: port 7331 is already in use', pathSource: 'shell' });

    const { container } = await renderAfterFirstStatusRead(port);

    expect(screen.getByRole('heading', { name: FAILED_HEADING })).toHaveFocus();
    expect(screen.getByTestId('daemon-last-line')).toHaveTextContent('error: port 7331 is already in use');
    expect(screen.getByRole('button', { name: 'Check again' })).toBeEnabled();
    expect(container).toHaveTextContent(MANUAL_CARD_COMMAND);
    expect(container).not.toHaveTextContent('may not be on the daemon PATH');
    expect(screen.queryByRole('button', { name: 'Reveal log' })).toBeNull();
  });

  it('user is told claude may be missing from the PATH only when the fallback PATH was used and the last line names claude', async () => {
    const { port } = fakeDaemonStatusPort({ state: 'failed', lastLine: 'claude: command not found', pathSource: 'fallback', pathTried: '/opt/homebrew/bin:/usr/bin' });

    const { container } = await renderAfterFirstStatusRead(port);

    expect(container).toHaveTextContent('claude may not be on the daemon PATH');
    expect(container).toHaveTextContent('/opt/homebrew/bin:/usr/bin');
  });

  it('user is not told about the PATH when the fallback PATH was used but the failure is something else', async () => {
    const { port } = fakeDaemonStatusPort({ state: 'failed', lastLine: 'error: port 7331 is already in use', pathSource: 'fallback' });

    const { container } = await renderAfterFirstStatusRead(port);

    expect(container).not.toHaveTextContent('PATH');
  });

  it('user pressing Check again reads the status again and sees the daemon ready', async () => {
    const { port, read, report } = fakeDaemonStatusPort({ state: 'failed', lastLine: 'boom' });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const { fixture } = await renderAfterFirstStatusRead(port);
    const readsBefore = read.mock.calls.length;

    report({ state: 'ready' });
    await user.click(screen.getByRole('button', { name: 'Check again' }));
    await fixture.whenStable();

    expect(read.mock.calls.length).toBe(readsBefore + 1);
    expect(screen.getByRole('status')).toHaveTextContent('Daemon ready');
  });

  it('user outside Tauri keeps the manual card and never sees the automatic start', async () => {
    const { container } = await renderUnderTauri(null);

    expect(screen.getByText('No daemon on 127.0.0.1:7331')).toBeInTheDocument();
    expect(container).toHaveTextContent('Start the daemon: pnpm dev:core in the OpenFleet folder');
    expect(container).not.toHaveTextContent(STARTING_COPY);
    expect(screen.queryByRole('button', { name: 'Check again' })).toBeNull();
  });

  it('the status is read every second while the daemon is starting or slow', async () => {
    const { port, read, report } = fakeDaemonStatusPort({ state: 'starting' });
    const { fixture } = await renderUnderTauri(port);

    await letTimePass(POLL_INTERVAL_MS * 3, fixture);
    report({ state: 'slow' });
    await letTimePass(POLL_INTERVAL_MS * 3, fixture);

    expect(read.mock.calls.length).toBe(1 + 3 + 3);
  });

  it.each([
    ['ready', { state: 'ready' }],
    ['reused', { state: 'reused' }],
    ['failed', { state: 'failed', lastLine: 'boom' }],
  ] as const)('the status is no longer read once the daemon is %s', async (_name, settled) => {
    const { port, read, report } = fakeDaemonStatusPort({ state: 'starting' });
    const { fixture } = await renderUnderTauri(port);

    report(settled);
    await letTimePass(POLL_INTERVAL_MS, fixture);
    const readsWhenSettled = read.mock.calls.length;
    await letTimePass(POLL_INTERVAL_MS * 10, fixture);

    expect(read.mock.calls.length).toBe(readsWhenSettled);
  });

  it('the status is no longer read once the user leaves the page', async () => {
    const { port, read } = fakeDaemonStatusPort({ state: 'starting' });
    const { fixture } = await renderUnderTauri(port);

    fixture.destroy();
    const readsAtLeave = read.mock.calls.length;
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 10);

    expect(read.mock.calls.length).toBe(readsAtLeave);
  });

  it('the status stops being read after six minutes of a daemon that never settles', async () => {
    const { port, read } = fakeDaemonStatusPort({ state: 'slow' });
    const { fixture } = await renderUnderTauri(port);

    await letTimePass(POLL_CAP_MS + POLL_INTERVAL_MS, fixture);
    const readsAtCap = read.mock.calls.length;
    await letTimePass(POLL_CAP_MS, fixture);

    expect(readsAtCap).toBeLessThanOrEqual(POLL_CAP_MS / POLL_INTERVAL_MS + 1);
    expect(read.mock.calls.length).toBe(readsAtCap);
  });

  it('user is not blocked by a failing status read: the next read still gets the daemon ready', async () => {
    const { port, report } = fakeDaemonStatusPort({ state: 'starting' });
    report(new Error('invoke failed'));
    const { fixture } = await renderUnderTauri(port);

    report({ state: 'ready' });
    await letTimePass(POLL_INTERVAL_MS, fixture);

    expect(screen.getByRole('status')).toHaveTextContent('Daemon ready');
  });

  it('user who prefers reduced motion gets a spinner that does not animate', async () => {
    const { port } = fakeDaemonStatusPort({ state: 'starting' });

    await renderUnderTauri(port);

    const componentStyles = [...document.querySelectorAll('style')].map((style) => style.textContent).join('\n');
    expect(componentStyles).toMatch(/prefers-reduced-motion:\s*reduce\)\s*\{[^}]*animation:\s*none/);
  });
});
