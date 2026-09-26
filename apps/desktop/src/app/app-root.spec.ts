import { TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { signal } from '@angular/core';
import { describe, expect, it, vi } from 'vitest';
import { AppRoot } from './app-root';
import { routes } from './app.routes';
import { FleetEventsService } from './core/fleet-events.service';

describe('AppRoot', () => {
  it('connects to the fleet event stream when only the manager dashboard route is active (a direct load or refresh of /manager/:id)', async () => {
    const connect = vi.fn();
    TestBed.configureTestingModule({
      providers: [
        provideRouter(routes),
        {
          provide: FleetEventsService,
          useValue: { connect, sessions: signal([]), approvals: signal([]), managers: signal([]), connected: signal(true), snapshotReceived: signal(true) },
        },
      ],
    });

    const fixture = TestBed.createComponent(AppRoot);
    fixture.detectChanges();
    const router = TestBed.inject(Router);
    await router.navigateByUrl('/manager/m1');
    fixture.detectChanges();

    expect(connect).toHaveBeenCalledTimes(1);
  });
});
