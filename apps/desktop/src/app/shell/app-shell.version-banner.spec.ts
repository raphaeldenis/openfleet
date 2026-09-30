import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter, type Routes } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { screen } from '@testing-library/angular/zoneless';
import { describe, expect, it } from 'vitest';
import { APP_VERSION_READER } from '../core/app-version';
import { FleetEventsService } from '../core/fleet-events.service';
import { type DaemonHealth, VersionsService } from '../core/versions.service';
import { silentWorkingStateSignals } from '../working-state/working-state-fixtures';
import { AppShellComponent } from './app-shell.component';

@Component({ selector: 'stub-home', template: '<span data-testid="stub-home">home</span>' })
class StubHomeComponent {}

const routes: Routes = [{ path: '', component: AppShellComponent, children: [{ path: '', component: StubHomeComponent }] }];

async function openShell({ appVersion }: { appVersion: string }) {
  const events = {
    sessions: signal([]),
    approvals: signal([]),
    managers: signal([]),
    connected: signal(true),
    ...silentWorkingStateSignals(),
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
  return { daemonAnswersBootCheckWith };
}

const versionMismatchBanner = () => screen.queryByText('Version mismatch');

describe('AppShellComponent version mismatch banner', () => {
  it('names both versions when the daemon and the app differ', async () => {
    const { daemonAnswersBootCheckWith } = await openShell({ appVersion: '0.2.0' });

    await daemonAnswersBootCheckWith({ version: '0.2.0-dev' });

    const banner = screen.getByText('The daemon on 127.0.0.1:7331 is 0.2.0-dev, this app is 0.2.0');
    expect(banner.closest('[data-testid="banner"]')).toHaveAttribute('role', 'status');
    expect(versionMismatchBanner()).toBeInTheDocument();
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

  it('shows nothing when the daemon did not answer the boot check', async () => {
    const { daemonAnswersBootCheckWith } = await openShell({ appVersion: '0.2.0' });

    await daemonAnswersBootCheckWith(null);

    expect(versionMismatchBanner()).not.toBeInTheDocument();
  });
});
