import { TestBed } from '@angular/core/testing';
import { App } from './app';
import { FleetEventsService } from './core/fleet-events.service';
import { signal } from '@angular/core';

describe('App', () => {
  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [App],
      providers: [{ provide: FleetEventsService, useValue: { sessions: signal([]), approvals: signal([]), connect: () => Promise.resolve() } }],
    })
      .compileComponents();
  });

  it('should create the app', () => {
    const fixture = TestBed.createComponent(App);
    const app = fixture.componentInstance;
    expect(app).toBeTruthy();
  });

  it('renders the sessions sidebar', async () => {
    const fixture = TestBed.createComponent(App);
    await fixture.whenStable();
    const compiled = fixture.nativeElement as HTMLElement;
    expect(compiled.querySelector('of-session-list')).toBeTruthy();
  });
});
