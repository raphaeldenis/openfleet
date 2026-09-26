import { render, screen } from '@testing-library/angular/zoneless';
import userEvent from '@testing-library/user-event';
import { signal } from '@angular/core';
import { ActivatedRoute, convertToParamMap } from '@angular/router';
import { of } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { ManagerDashboardComponent } from './manager-dashboard.component';
import { FleetApiService } from '../core/fleet-api.service';
import { FleetEventsService } from '../core/fleet-events.service';

function activatedRouteFor(id: string) {
  return { paramMap: of(convertToParamMap({ id })) };
}

function fakeEvents(overrides: { sessions?: unknown[]; managers?: unknown[] } = {}) {
  return {
    sessions: signal(overrides.sessions ?? []),
    approvals: signal([]),
    managers: signal(overrides.managers ?? []),
  };
}

const MANAGER_SESSION = { id: 'm1', name: 'Lead', emoji: '🧭', role: 'manager', state: 'idle', harness: 'claude-cli' };
const MANAGER_VIEW = { sessionId: 'm1', pulseSeconds: 1800, childrenCap: 2, missionText: 'x', nextPulseAt: new Date(Date.now() + 42_000).toISOString(), childrenCount: 1 };
const CHILD_SESSION = { id: 'c1', name: 'Gimli', emoji: '⚔️', parentId: 'm1', state: 'generating', harness: 'claude-cli' };

describe('ManagerDashboardComponent', () => {
  it('shows the manager name, state and children cap headroom', async () => {
    const fake = fakeEvents({ sessions: [MANAGER_SESSION], managers: [MANAGER_VIEW] });
    await render(ManagerDashboardComponent, {
      providers: [{ provide: ActivatedRoute, useValue: activatedRouteFor('m1') }, { provide: FleetEventsService, useValue: fake }],
    });
    expect(screen.getByTestId('manager-dashboard-name')).toHaveTextContent('Lead');
    expect(screen.getByTestId('manager-dashboard-cap')).toHaveTextContent('1/2');
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
