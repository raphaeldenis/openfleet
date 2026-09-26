import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { signal } from '@angular/core';
import { routes } from './app.routes';
import { FleetEventsService } from './core/fleet-events.service';

function configureTestBed() {
  const managerSession = { id: 'm1', name: 'Lead', emoji: '🧭', role: 'manager', state: 'idle', harness: 'claude-cli' };
  return TestBed.configureTestingModule({
    providers: [
      provideRouter(routes),
      { provide: FleetEventsService, useValue: { sessions: signal([managerSession]), approvals: signal([]), managers: signal([]), connect: () => {}, connected: signal(true) } },
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
});
