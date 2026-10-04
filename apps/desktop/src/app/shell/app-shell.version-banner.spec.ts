import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router, type Routes } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { screen } from '@testing-library/angular/zoneless';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { APP_VERSION_READER } from '../core/app-version';
import { FleetEventsService } from '../core/fleet-events.service';
import { type DaemonHealth, VersionsService } from '../core/versions.service';
import { silentWorkingStateSignals } from '../working-state/working-state-fixtures';
import { AppShellComponent } from './app-shell.component';

@Component({ selector: 'stub-home', template: '<span data-testid="stub-home">home</span>' })
class StubHomeComponent {}

@Component({ selector: 'stub-settings', template: '<span data-testid="stub-settings">settings</span>' })
class StubSettingsComponent {}

const routes: Routes = [
  {
    path: '',
    component: AppShellComponent,
    children: [
      { path: '', component: StubHomeComponent },
      { path: 'settings', component: StubSettingsComponent },
    ],
  },
];

async function openShell({ appVersion, isConnected = true, daemonIssues = [] }: { appVersion: string; isConnected?: boolean; daemonIssues?: unknown[] }) {
  const events = {
    sessions: signal([]),
    approvals: signal([]),
    managers: signal([]),
    connected: signal(isConnected),
    ...silentWorkingStateSignals(),
    daemonIssues: signal(daemonIssues),
    workingStates: signal(new Map()),
    workingStatesReported: signal(false),
  };
  TestBed.configureTestingModule({
    providers: [
      provideRouter(routes),
      { provide: FleetEventsService, useValue: events },
      { provide: APP_VERSION_READER, useValue: () => Promise.resolve(appVersion) },
    ],
  });
  const harness = await RouterTestingHarness.create('');
  const versions = TestBed.inject(VersionsService);
  const daemonAnswersBootCheckWith = async (health: DaemonHealth) => {
    await versions.loadAppVersion();
    versions.recordDaemonHealth(health);
    harness.detectChanges();
  };
  return { daemonAnswersBootCheckWith, harness };
}

const versionMismatchBanner = () => screen.queryByTestId('version-mismatch-banner');

describe('AppShellComponent version mismatch banner', () => {
  it('names both versions when the daemon and the app differ', async () => {
    const { daemonAnswersBootCheckWith } = await openShell({ appVersion: '0.2.0' });

    await daemonAnswersBootCheckWith({ version: '0.2.0-dev' });

    const banner = screen.getByTestId('version-mismatch-banner');
    expect(banner).toHaveTextContent('The daemon on 127.0.0.1:7331 is 0.2.0-dev, this app is 0.2.0');
    expect(banner.querySelector('[data-testid="banner"]')).toHaveAttribute('role', 'status');
  });

  it('offers its actions as compact buttons', async () => {
    const { daemonAnswersBootCheckWith } = await openShell({ appVersion: '0.2.0' });

    await daemonAnswersBootCheckWith({ version: '0.2.0-dev' });

    expect(screen.getByTestId('version-mismatch-copy-details')).toHaveClass('of-btn--compact');
    expect(screen.getByTestId('version-mismatch-about')).toHaveClass('of-btn--compact');
  });

  it('shows nothing when the daemon and the app run the same version', async () => {
    const { daemonAnswersBootCheckWith } = await openShell({ appVersion: '0.2.0' });

    await daemonAnswersBootCheckWith({ version: '0.2.0' });

    expect(versionMismatchBanner()).not.toBeInTheDocument();
  });

  it('shows nothing when the daemon does not report its version', async () => {
    const { daemonAnswersBootCheckWith } = await openShell({ appVersion: '0.2.0' });

    await daemonAnswersBootCheckWith({});

    expect(versionMismatchBanner()).not.toBeInTheDocument();
  });

  it('shows a daemon version made of HTML as escaped text', async () => {
    const { daemonAnswersBootCheckWith } = await openShell({ appVersion: '0.2.0' });

    await daemonAnswersBootCheckWith({ version: '<img src=x onerror=alert(1)>' });

    const banner = screen.getByTestId('version-mismatch-banner');
    expect(banner).toHaveTextContent('<img src=x onerror=alert(1)>');
    expect(banner.querySelector('img')).toBeNull();
  });

  it('caps a huge daemon version at 64 characters with an ellipsis', async () => {
    const { daemonAnswersBootCheckWith } = await openShell({ appVersion: '0.2.0' });

    await daemonAnswersBootCheckWith({ version: '9'.repeat(5000) });

    const bannerText = screen.getByTestId('version-mismatch-banner').textContent ?? '';
    expect(bannerText).toContain(`${'9'.repeat(63)}…`);
    expect(bannerText).not.toContain('9'.repeat(64));
  });

  it('treats a daemon version that is not a string as unknown and shows nothing', async () => {
    const { daemonAnswersBootCheckWith } = await openShell({ appVersion: '0.2.0' });

    await daemonAnswersBootCheckWith({ version: 7 as unknown as string });

    expect(versionMismatchBanner()).not.toBeInTheDocument();
  });

  it('shows nothing when the daemon did not answer the boot check', async () => {
    const { daemonAnswersBootCheckWith } = await openShell({ appVersion: '0.2.0' });

    await daemonAnswersBootCheckWith(null);

    expect(versionMismatchBanner()).not.toBeInTheDocument();
  });

  it('titles the banner "! Version mismatch" and tells the user to restart the daemon so both match', async () => {
    const { daemonAnswersBootCheckWith } = await openShell({ appVersion: '1.2.0' });

    await daemonAnswersBootCheckWith({ version: '0.9.2' });

    const banner = screen.getByTestId('version-mismatch-banner');
    expect(banner).toHaveTextContent('! Version mismatch');
    expect(banner).toHaveTextContent('The daemon on 127.0.0.1:7331 is 0.9.2, this app is 1.2.0 — restart the daemon so both match.');
  });

  describe('Copy details', () => {
    afterEach(() => vi.unstubAllGlobals());

    it('copies the ref, the code, both versions, the address and the time, and says Copied', async () => {
      const writeText = vi.fn(() => Promise.resolve());
      vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
      const { daemonAnswersBootCheckWith } = await openShell({ appVersion: '1.2.0' });
      await daemonAnswersBootCheckWith({ version: '0.9.2' });

      await userEvent.click(screen.getByRole('button', { name: 'Copy details' }));

      const [copiedText] = writeText.mock.calls[0] as unknown as [string];
      const lines = copiedText.split('\n');
      expect(lines).toEqual([
        expect.stringMatching(/^ref OF-[0-9a-f]{6}$/),
        'code: version_mismatch',
        'daemon: 0.9.2',
        'app: 1.2.0',
        'address: 127.0.0.1:7331',
        expect.stringMatching(/^time: \d{4}-\d{2}-\d{2}T/),
      ]);
      expect(screen.getByRole('button', { name: 'Copied' })).toBeInTheDocument();
    });

    it('copies a daemon version without credentials or home paths', async () => {
      const writeText = vi.fn(() => Promise.resolve());
      vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
      const { daemonAnswersBootCheckWith } = await openShell({ appVersion: '1.2.0' });
      await daemonAnswersBootCheckWith({ version: '0.9.2 /Users/review-user/x Bearer SYNTHETIC_TOKEN_123' });

      await userEvent.click(screen.getByRole('button', { name: 'Copy details' }));

      const [copiedText] = writeText.mock.calls[0] as unknown as [string];
      expect(copiedText).not.toMatch(/SYNTHETIC_TOKEN_123|review-user/);
    });
  });

  it('opens Settings on its About section from the About… button', async () => {
    const { daemonAnswersBootCheckWith, harness } = await openShell({ appVersion: '1.2.0' });
    await daemonAnswersBootCheckWith({ version: '0.9.2' });

    await userEvent.click(screen.getByRole('button', { name: 'About…' }));
    harness.detectChanges();

    expect(TestBed.inject(Router).url).toBe('/settings?tab=about');
    expect(screen.getByTestId('stub-settings')).toBeInTheDocument();
  });

  describe('the daemon status pill', () => {
    it('reads "Daemon <version>" with the differing-versions tooltip when the versions differ', async () => {
      const { daemonAnswersBootCheckWith } = await openShell({ appVersion: '1.2.0' });

      await daemonAnswersBootCheckWith({ version: '0.9.2' });

      const [topBarPill] = screen.getAllByTestId('daemon-status');
      expect(topBarPill).toHaveTextContent('Daemon 0.9.2');
      expect(topBarPill).toHaveAttribute('title', 'Daemon and app versions differ — restart the daemon');
    });

    it('keeps reading "Connected" when the versions match', async () => {
      const { daemonAnswersBootCheckWith } = await openShell({ appVersion: '1.2.0' });

      await daemonAnswersBootCheckWith({ version: '1.2.0' });

      const [topBarPill] = screen.getAllByTestId('daemon-status');
      expect(topBarPill).toHaveTextContent('Connected');
    });
  });

  describe('stacking under the top bar', () => {
    const stuckDatabase = { id: '3f9a1c2e', code: 'db_stuck', message: 'The database is stuck.', since: '2026-09-30T10:00:00.000Z' };

    it('puts the mismatch banner above the degraded banner and the reconnecting banner, as the design does', async () => {
      const { daemonAnswersBootCheckWith } = await openShell({ appVersion: '1.2.0', isConnected: false, daemonIssues: [stuckDatabase] });

      await daemonAnswersBootCheckWith({ version: '0.9.2' });

      const bannerOrder = screen.getAllByTestId('banner').map((banner) => banner.getAttribute('data-variant'));
      expect(bannerOrder).toEqual(['mismatch', 'error', 'reconnecting']);
    });
  });
});
