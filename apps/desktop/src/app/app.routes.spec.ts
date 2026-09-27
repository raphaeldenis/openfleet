import { TestBed } from '@angular/core/testing';
import { provideRouter, withComponentInputBinding } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { signal } from '@angular/core';
import { routes } from './app.routes';
import { FleetEventsService } from './core/fleet-events.service';

function configureTestBed() {
  const managerSession = { id: 'm1', name: 'Lead', emoji: '🧭', role: 'manager', state: 'idle', harness: 'claude-cli' };
  const workerSession = { id: 's1', name: 'Gimli', emoji: '⛏️', state: 'idle', harness: 'claude-cli', directory: '/repo' };
  const secondWorkerSession = { id: 's2', name: 'Legolas', emoji: '🏹', state: 'idle', harness: 'claude-cli', directory: '/repo' };
  return TestBed.configureTestingModule({
    providers: [
      provideRouter(routes, withComponentInputBinding()),
      {
        provide: FleetEventsService,
        useValue: {
          sessions: signal([managerSession, workerSession, secondWorkerSession]),
          approvals: signal([]),
          managers: signal([]),
          connect: () => {},
          connected: signal(true),
          snapshotReceived: signal(true),
          reconnectCount: signal(0),
          deliveredMessageIds: signal(new Set()),
          output: () => ({ subscribe: () => ({ unsubscribe: () => {} }) }),
          sendInput: () => {},
          sendResize: () => {},
          sendAttach: () => {},
        },
      },
    ],
  }).compileComponents();
}

describe('app.routes', () => {
  it("renders the app shell with an empty state at ''", async () => {
    await configureTestBed();
    const harness = await RouterTestingHarness.create('');
    expect(harness.routeNativeElement?.querySelector('[data-testid="app-shell"]')).toBeTruthy();
    expect(harness.routeNativeElement?.querySelector('[data-testid="empty-state"]')).toBeTruthy();
  });

  it("renders the components sheet at '/components', outside the shell chrome", async () => {
    await configureTestBed();
    const harness = await RouterTestingHarness.create('/components');
    expect(harness.routeNativeElement?.querySelector('[data-testid="components-sheet"]')).toBeTruthy();
    expect(harness.routeNativeElement?.querySelector('[data-testid="app-shell"]')).toBeFalsy();
  });

  it("renders the inbox in its own panel at '/inbox', inside the shell", async () => {
    await configureTestBed();
    const harness = await RouterTestingHarness.create('/inbox');
    expect(harness.routeNativeElement?.querySelector('[data-testid="app-shell"]')).toBeTruthy();
    expect(harness.routeNativeElement?.querySelector('of-inbox')).toBeTruthy();
  });

  it("renders the manager dashboard at '/manager/:id' without losing the sidebar (the old three-column layout's dead end)", async () => {
    await configureTestBed();
    const harness = await RouterTestingHarness.create('/manager/m1');
    expect(harness.routeNativeElement?.querySelector('[data-testid="app-shell"]')).toBeTruthy();
    expect(harness.routeNativeElement?.querySelector('[data-testid="app-nav"]')).toBeTruthy();
    expect(harness.routeNativeElement?.querySelector('[data-testid="manager-dashboard"]')).toBeTruthy();
  });

  it("renders the session view at '/session/:sessionId' without losing the sidebar (the old three-column layout's dead end)", async () => {
    await configureTestBed();
    const harness = await RouterTestingHarness.create('/session/s1');
    expect(harness.routeNativeElement?.querySelector('[data-testid="app-shell"]')).toBeTruthy();
    expect(harness.routeNativeElement?.querySelector('[data-testid="app-nav"]')).toBeTruthy();
    expect(harness.routeNativeElement?.querySelector('[data-testid="session-view"]')).toBeTruthy();
  });

  it('user picking a different session while already on a session view sees the new session, not the old one (zoneless router-input-binding regression)', async () => {
    await configureTestBed();
    const harness = await RouterTestingHarness.create('/session/s1');
    expect(harness.routeNativeElement?.querySelector('[data-testid="session-name"]')).toHaveTextContent('Gimli');

    await harness.navigateByUrl('/session/s2');

    expect(harness.routeNativeElement?.querySelector('[data-testid="session-name"]')).toHaveTextContent('Legolas');
  });

  it('user visiting an unknown path still lands inside the app shell instead of a blank page', async () => {
    await configureTestBed();
    const harness = await RouterTestingHarness.create('/this-page-does-not-exist');

    expect(harness.routeNativeElement?.querySelector('[data-testid="app-shell"]')).toBeTruthy();
    expect(harness.routeNativeElement?.querySelector('[data-testid="not-found"]')).toBeTruthy();
  });
});
