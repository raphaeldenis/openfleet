import { TestBed } from '@angular/core/testing';
import { provideRouter, withComponentInputBinding } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { signal } from '@angular/core';
import { routes } from './app.routes';
import { FleetEventsService } from './core/fleet-events.service';

function configureTestBed() {
  const managerSession = { id: 'm1', name: 'Lead', emoji: '🧭', role: 'manager', state: 'idle', harness: 'claude-cli' };
  const workerSession = { id: 's1', name: 'Gimli', emoji: '⛏️', state: 'idle', harness: 'claude-cli', directory: '/repo' };
  return TestBed.configureTestingModule({
    providers: [
      provideRouter(routes, withComponentInputBinding()),
      {
        provide: FleetEventsService,
        useValue: {
          sessions: signal([managerSession, workerSession]),
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
  it("renders the App shell at ''", async () => {
    await configureTestBed();
    const harness = await RouterTestingHarness.create('');
    expect(harness.routeNativeElement?.querySelector('[data-testid="app-shell"]')).toBeTruthy();
  });

  it("renders the components sheet at '/components'", async () => {
    await configureTestBed();
    const harness = await RouterTestingHarness.create('/components');
    expect(harness.routeNativeElement?.querySelector('[data-testid="components-sheet"]')).toBeTruthy();
  });

  it("renders the manager dashboard at '/manager/:id'", async () => {
    await configureTestBed();
    const harness = await RouterTestingHarness.create('/manager/m1');
    expect(harness.routeNativeElement?.querySelector('[data-testid="manager-dashboard"]')).toBeTruthy();
  });

  it("renders the session view at '/session/:sessionId'", async () => {
    await configureTestBed();
    const harness = await RouterTestingHarness.create('/session/s1');
    expect(harness.routeNativeElement?.querySelector('[data-testid="session-view"]')).toBeTruthy();
  });
});
