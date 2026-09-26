import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { App } from './app';
import { FleetEventsService } from './core/fleet-events.service';
import { signal } from '@angular/core';

function configureTestBed(connected = true) {
  return TestBed.configureTestingModule({
    imports: [App],
    providers: [
      provideRouter([]),
      { provide: FleetEventsService, useValue: { sessions: signal([]), approvals: signal([]), managers: signal([]), connect: () => {}, connected: signal(connected) } },
    ],
  }).compileComponents();
}

describe('App', () => {
  it('should create the app', async () => {
    await configureTestBed();
    const fixture = TestBed.createComponent(App);
    const app = fixture.componentInstance;
    expect(app).toBeTruthy();
  });

  it('renders the sessions sidebar', async () => {
    await configureTestBed();
    const fixture = TestBed.createComponent(App);
    await fixture.whenStable();
    const compiled = fixture.nativeElement as HTMLElement;
    expect(compiled.querySelector('of-session-list')).toBeTruthy();
  });

  it('hides the connection-lost banner while connected', async () => {
    await configureTestBed(true);
    const fixture = TestBed.createComponent(App);
    await fixture.whenStable();
    const compiled = fixture.nativeElement as HTMLElement;
    expect(compiled.querySelector('[data-testid="connection-lost"]')).toBeFalsy();
  });

  it('shows the connection-lost banner while disconnected', async () => {
    await configureTestBed(false);
    const fixture = TestBed.createComponent(App);
    await fixture.whenStable();
    const compiled = fixture.nativeElement as HTMLElement;
    expect(compiled.querySelector('[data-testid="connection-lost"]')).toBeTruthy();
  });
});
