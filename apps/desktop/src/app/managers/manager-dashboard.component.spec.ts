import { render, screen } from '@testing-library/angular/zoneless';
import userEvent from '@testing-library/user-event';
import { signal } from '@angular/core';
import { ActivatedRoute, convertToParamMap } from '@angular/router';
import { BehaviorSubject, of } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { ManagerDashboardComponent } from './manager-dashboard.component';
import { FleetApiService } from '../core/fleet-api.service';
import { FleetEventsService } from '../core/fleet-events.service';

function activatedRouteFor(id: string) {
  return { paramMap: of(convertToParamMap({ id })) };
}

function fakeEvents(overrides: { sessions?: unknown[]; managers?: unknown[]; snapshotReceived?: boolean } = {}) {
  return {
    sessions: signal(overrides.sessions ?? []),
    approvals: signal([]),
    managers: signal(overrides.managers ?? []),
    snapshotReceived: signal(overrides.snapshotReceived ?? true),
  };
}

const MANAGER_SESSION = { id: 'm1', name: 'Lead', emoji: '🧭', role: 'manager', state: 'idle', harness: 'claude-cli' };
const MANAGER_VIEW = { sessionId: 'm1', pulseSeconds: 1800, childrenCap: 2, missionText: 'x', nextPulseAt: new Date(Date.now() + 42_000).toISOString(), childrenCount: 1 };
const CHILD_SESSION = { id: 'c1', name: 'Gimli', emoji: '⚔️', parentId: 'm1', state: 'generating', harness: 'claude-cli' };

describe('ManagerDashboardComponent', () => {
  it('shows the manager name, state and children cap headroom', async () => {
    const fake = fakeEvents({ sessions: [MANAGER_SESSION, CHILD_SESSION], managers: [MANAGER_VIEW] });
    await render(ManagerDashboardComponent, {
      providers: [{ provide: ActivatedRoute, useValue: activatedRouteFor('m1') }, { provide: FleetEventsService, useValue: fake }],
    });
    expect(screen.getByTestId('manager-dashboard-name')).toHaveTextContent('Lead');
    expect(screen.getByTestId('manager-dashboard-cap')).toHaveTextContent('1/2');
  });

  it('shows a loading state before the snapshot has arrived, instead of a blank screen', async () => {
    const fake = fakeEvents({ snapshotReceived: false });
    await render(ManagerDashboardComponent, {
      providers: [{ provide: ActivatedRoute, useValue: activatedRouteFor('m1') }, { provide: FleetEventsService, useValue: fake }],
    });
    expect(screen.getByTestId('manager-dashboard-loading')).toBeTruthy();
    expect(screen.queryByTestId('manager-dashboard-not-found')).toBeNull();
  });

  it('shows "session not found" once the snapshot has loaded but no session matches the id', async () => {
    const fake = fakeEvents({ sessions: [], snapshotReceived: true });
    await render(ManagerDashboardComponent, {
      providers: [{ provide: ActivatedRoute, useValue: activatedRouteFor('missing-id') }, { provide: FleetEventsService, useValue: fake }],
    });
    expect(screen.getByTestId('manager-dashboard-not-found')).toBeTruthy();
  });

  it('shows "not a manager" instead of full manager chrome when the session at this id is not a manager', async () => {
    const plainSession = { id: 's1', name: 'Gimli', emoji: '⚔️', state: 'idle', harness: 'claude-cli' };
    const fake = fakeEvents({ sessions: [plainSession] });
    await render(ManagerDashboardComponent, {
      providers: [{ provide: ActivatedRoute, useValue: activatedRouteFor('s1') }, { provide: FleetEventsService, useValue: fake }],
    });
    expect(screen.getByTestId('manager-dashboard-not-manager')).toBeTruthy();
    expect(screen.queryByTestId('manager-dashboard-governance-notice')).toBeNull();
  });

  it('derives the children header count from the live session list, updating immediately when a child is created', async () => {
    const staleManagerView = { ...MANAGER_VIEW, childrenCount: 0 };
    const fake = fakeEvents({ sessions: [MANAGER_SESSION], managers: [staleManagerView] });
    const { fixture } = await render(ManagerDashboardComponent, {
      providers: [{ provide: ActivatedRoute, useValue: activatedRouteFor('m1') }, { provide: FleetEventsService, useValue: fake }],
    });
    expect(screen.getByTestId('manager-dashboard-cap')).toHaveTextContent('0/2');

    fake.sessions.set([MANAGER_SESSION, CHILD_SESSION]);
    await fixture.whenStable();

    expect(screen.getByTestId('manager-dashboard-cap')).toHaveTextContent('1/2');
  });

  it('stops the countdown and disables "Pulse now", with a reason, once the manager session is closed', async () => {
    const closedManagerSession = { ...MANAGER_SESSION, state: 'closed' };
    const fake = fakeEvents({ sessions: [closedManagerSession], managers: [MANAGER_VIEW] });
    await render(ManagerDashboardComponent, {
      providers: [{ provide: ActivatedRoute, useValue: activatedRouteFor('m1') }, { provide: FleetEventsService, useValue: fake }],
    });

    expect(screen.getByTestId('manager-dashboard-countdown')).toHaveTextContent(/closed|—/i);
    expect(screen.getByTestId('manager-dashboard-pulse')).toBeDisabled();
    expect(screen.getByTestId('manager-dashboard-pulse-message')).toHaveTextContent(/closed/i);
  });

  it('resets the pulse action state when the route id changes from one manager to another', async () => {
    const paramMap$ = new BehaviorSubject(convertToParamMap({ id: 'm1' }));
    const api = { pulseNow: vi.fn().mockRejectedValue(new Error('POST /api/managers/m1/pulse → 409')) };
    const managerB = { id: 'm2', name: 'Second', emoji: '🧭', role: 'manager', state: 'idle', harness: 'claude-cli' };
    const managerBView = { ...MANAGER_VIEW, sessionId: 'm2' };
    const fake = fakeEvents({ sessions: [MANAGER_SESSION, managerB], managers: [MANAGER_VIEW, managerBView] });
    const { fixture } = await render(ManagerDashboardComponent, {
      providers: [
        { provide: ActivatedRoute, useValue: { paramMap: paramMap$ } },
        { provide: FleetApiService, useValue: api },
        { provide: FleetEventsService, useValue: fake },
      ],
    });

    await userEvent.click(screen.getByTestId('manager-dashboard-pulse'));
    expect(screen.getByTestId('manager-dashboard-pulse-message')).toBeTruthy();

    paramMap$.next(convertToParamMap({ id: 'm2' }));
    await fixture.whenStable();

    expect(screen.queryByTestId('manager-dashboard-pulse-message')).toBeNull();
  });

  it('lists each child in the table with its name and state', async () => {
    const fake = fakeEvents({ sessions: [MANAGER_SESSION, CHILD_SESSION], managers: [MANAGER_VIEW] });
    await render(ManagerDashboardComponent, {
      providers: [{ provide: ActivatedRoute, useValue: activatedRouteFor('m1') }, { provide: FleetEventsService, useValue: fake }],
    });
    const row = screen.getByTestId('manager-dashboard-child-c1');
    expect(row).toHaveTextContent('Gimli');
    expect(row).toHaveTextContent('generating');
  });

  it('pulses now when the button is clicked', async () => {
    const api = { pulseNow: vi.fn().mockResolvedValue({}) };
    const fake = fakeEvents({ sessions: [MANAGER_SESSION], managers: [MANAGER_VIEW] });
    await render(ManagerDashboardComponent, {
      providers: [
        { provide: ActivatedRoute, useValue: activatedRouteFor('m1') },
        { provide: FleetApiService, useValue: api },
        { provide: FleetEventsService, useValue: fake },
      ],
    });

    await userEvent.click(screen.getByTestId('manager-dashboard-pulse'));

    expect(api.pulseNow).toHaveBeenCalledWith('m1');
  });

  it('shows an explicit notice instead of a silently missing journal/proposals section', async () => {
    const fake = fakeEvents({ sessions: [MANAGER_SESSION], managers: [MANAGER_VIEW] });
    await render(ManagerDashboardComponent, {
      providers: [{ provide: ActivatedRoute, useValue: activatedRouteFor('m1') }, { provide: FleetEventsService, useValue: fake }],
    });
    expect(screen.getByTestId('manager-dashboard-governance-notice')).toHaveTextContent('coming');
  });

  it('disables "Pulse now" while a pulse request is pending, so a slow response cannot be double-fired', async () => {
    let resolvePulse!: () => void;
    const api = { pulseNow: vi.fn(() => new Promise<void>((resolve) => { resolvePulse = resolve; })) };
    const fake = fakeEvents({ sessions: [MANAGER_SESSION], managers: [MANAGER_VIEW] });
    await render(ManagerDashboardComponent, {
      providers: [
        { provide: ActivatedRoute, useValue: activatedRouteFor('m1') },
        { provide: FleetApiService, useValue: api },
        { provide: FleetEventsService, useValue: fake },
      ],
    });

    await userEvent.click(screen.getByTestId('manager-dashboard-pulse'));
    expect(screen.getByTestId('manager-dashboard-pulse')).toBeDisabled();

    resolvePulse();
  });

  it('shows an error message, not a silent failure, when the pulse request is rejected (e.g. a closed session)', async () => {
    const api = { pulseNow: vi.fn().mockRejectedValue(new Error('POST /api/managers/m1/pulse → 409')) };
    const fake = fakeEvents({ sessions: [MANAGER_SESSION], managers: [MANAGER_VIEW] });
    await render(ManagerDashboardComponent, {
      providers: [
        { provide: ActivatedRoute, useValue: activatedRouteFor('m1') },
        { provide: FleetApiService, useValue: api },
        { provide: FleetEventsService, useValue: fake },
      ],
    });

    await userEvent.click(screen.getByTestId('manager-dashboard-pulse'));

    expect(screen.getByTestId('manager-dashboard-pulse-message')).toBeTruthy();
  });

  it('lets a keyboard-only user Tab to "Pulse now" and activate it with Enter', async () => {
    const api = { pulseNow: vi.fn().mockResolvedValue({}) };
    const fake = fakeEvents({ sessions: [MANAGER_SESSION], managers: [MANAGER_VIEW] });
    await render(ManagerDashboardComponent, {
      providers: [
        { provide: ActivatedRoute, useValue: activatedRouteFor('m1') },
        { provide: FleetApiService, useValue: api },
        { provide: FleetEventsService, useValue: fake },
      ],
    });

    await userEvent.tab();
    expect(screen.getByTestId('manager-dashboard-pulse')).toHaveFocus();
    await userEvent.keyboard('{Enter}');

    expect(api.pulseNow).toHaveBeenCalledWith('m1');
  });
});
