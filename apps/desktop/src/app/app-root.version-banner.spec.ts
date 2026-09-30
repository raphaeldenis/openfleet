import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router, withComponentInputBinding } from '@angular/router';
import { screen } from '@testing-library/angular/zoneless';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppRoot } from './app-root';
import { routes } from './app.routes';
import { APP_VERSION_READER } from './core/app-version';
import { FleetEventsService } from './core/fleet-events.service';
import { silentWorkingStateSignals } from './working-state/working-state-fixtures';

// Black-box: the daemon version the user sees comes from the one /health request made at boot.

function jsonResponse(body: unknown): Response {
  return { ok: true, status: 200, json: () => Promise.resolve(body) } as unknown as Response;
}

function daemonServing({ health }: { health: unknown }) {
  const fetchMock = vi.fn((url: string) => Promise.resolve(jsonResponse(url.endsWith('/health') ? health : [])));
  vi.stubGlobal('fetch', fetchMock);
  return { healthRequestCount: () => fetchMock.mock.calls.filter(([url]) => url.endsWith('/health')).length };
}

async function bootAppOn({ appVersion }: { appVersion: string }) {
  TestBed.configureTestingModule({
    providers: [
      provideRouter(routes, withComponentInputBinding()),
      { provide: APP_VERSION_READER, useValue: () => Promise.resolve(appVersion) },
      {
        provide: FleetEventsService,
        useValue: { connect: vi.fn(), sessions: signal([]), approvals: signal([]), managers: signal([]), connected: signal(true), snapshotReceived: signal(true), ...silentWorkingStateSignals() },
      },
    ],
  });
  await TestBed.inject(Router).navigateByUrl('/inbox');
  const fixture = TestBed.createComponent(AppRoot);
  fixture.detectChanges();
  await fixture.whenStable();
}

describe('AppRoot version mismatch banner', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('warns the user when the daemon they reached runs another version than the app, from a single /health request', async () => {
    const { healthRequestCount } = daemonServing({ health: { ok: true, version: '0.2.0-dev' } });

    await bootAppOn({ appVersion: '0.2.0' });

    expect(await screen.findByTestId('version-mismatch-banner')).toHaveTextContent('The daemon on 127.0.0.1:7331 is 0.2.0-dev, this app is 0.2.0');
    expect(healthRequestCount()).toBe(1);
  });

  it('stays quiet when the daemon runs the version of the app', async () => {
    daemonServing({ health: { ok: true, version: '0.2.0' } });

    await bootAppOn({ appVersion: '0.2.0' });

    expect(await screen.findByTestId('app-shell')).toBeInTheDocument();
    expect(screen.queryByTestId('version-mismatch-banner')).not.toBeInTheDocument();
  });
});
