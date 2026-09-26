import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { signal } from '@angular/core';
import { routes } from './app.routes';
import { FleetEventsService } from './core/fleet-events.service';

function configureTestBed() {
  return TestBed.configureTestingModule({
    providers: [
      provideRouter(routes),
      { provide: FleetEventsService, useValue: { sessions: signal([]), approvals: signal([]), connect: () => {}, connected: signal(true) } },
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
});
