import { render, screen } from '@testing-library/angular/zoneless';
import userEvent from '@testing-library/user-event';
import { signal } from '@angular/core';
import { provideRouter, Router } from '@angular/router';
import { describe, expect, it, vi } from 'vitest';
import { SessionListComponent } from './session-list.component';
import { FleetApiService } from '../core/fleet-api.service';
import { FleetEventsService } from '../core/fleet-events.service';

function fakeEvents(overrides: { sessions?: unknown[]; managers?: unknown[] } = {}) {
  return {
    sessions: signal(overrides.sessions ?? []),
    approvals: signal([]),
    managers: signal(overrides.managers ?? []),
  };
}

function fakeApi(overrides: Record<string, unknown> = {}) {
  return {
    createSession: vi.fn().mockResolvedValue({}),
    createManagerSession: vi.fn().mockResolvedValue({}),
    pulseNow: vi.fn().mockResolvedValue({}),
    ...overrides,
  };
}

describe('SessionListComponent', () => {
  it('renders each root session with its emoji, name and state', async () => {
    const fake = fakeEvents({ sessions: [{ id: '1', name: 'Gimli', emoji: '⚔️', state: 'generating' }] });
    await render(SessionListComponent, { providers: [provideRouter([]), { provide: FleetEventsService, useValue: fake }] });
    expect(screen.getByText('⚔️ Gimli')).toBeTruthy();
    expect(screen.getByText('generating')).toBeTruthy();
  });

  it('indents a child session under its manager parent', async () => {
    const fake = fakeEvents({
      sessions: [
        { id: 'm1', name: 'Lead', emoji: '🧭', role: 'manager', state: 'idle' },
        { id: 'c1', name: 'Gimli', emoji: '⚔️', parentId: 'm1', state: 'idle' },
      ],
    });
    await render(SessionListComponent, { providers: [provideRouter([]), { provide: FleetEventsService, useValue: fake }] });
    const childRow = screen.getByTestId('session-c1');
    expect(childRow.className).toContain('child');
  });

  it('shows children count/cap and a pulse countdown on a manager card, and pulses on click', async () => {
    const api = fakeApi();
    const nextPulseAt = new Date(Date.now() + 42_000).toISOString();
    const fake = fakeEvents({
      sessions: [{ id: 'm1', name: 'Lead', emoji: '🧭', role: 'manager', state: 'idle' }],
      managers: [{ sessionId: 'm1', pulseSeconds: 1800, childrenCap: 2, missionText: 'x', nextPulseAt, childrenCount: 1 }],
    });
    await render(SessionListComponent, { providers: [provideRouter([]), { provide: FleetApiService, useValue: api }, { provide: FleetEventsService, useValue: fake }] });
    expect(screen.getByTestId('manager-m1-children')).toHaveTextContent('1/2');
    expect(screen.getByTestId('manager-m1-countdown').textContent).toMatch(/\d+s/);
    await userEvent.click(screen.getByTestId('manager-m1-pulse'));
    expect(api.pulseNow).toHaveBeenCalledWith('m1');
  });

  it('navigates to the manager dashboard when a root manager row is clicked, instead of opening its terminal', async () => {
    const fake = fakeEvents({ sessions: [{ id: 'm1', name: 'Lead', emoji: '🧭', role: 'manager', state: 'idle' }] });
    const { fixture } = await render(SessionListComponent, { providers: [provideRouter([]), { provide: FleetEventsService, useValue: fake }] });
    const router = fixture.debugElement.injector.get(Router);
    const navigateSpy = vi.spyOn(router, 'navigate').mockResolvedValue(true);

    await userEvent.click(screen.getByTestId('session-m1'));

    expect(navigateSpy).toHaveBeenCalledWith(['/manager', 'm1']);
  });

  it('opens the terminal (does not navigate) when a plain root session is clicked', async () => {
    const fake = fakeEvents({ sessions: [{ id: 's1', name: 'Gimli', emoji: '⚔️', state: 'idle' }] });
    const { fixture } = await render(SessionListComponent, { providers: [provideRouter([]), { provide: FleetEventsService, useValue: fake }] });
    const selected = vi.fn();
    fixture.componentInstance.selected.subscribe(selected);

    await userEvent.click(screen.getByTestId('session-s1'));

    expect(selected).toHaveBeenCalledWith('s1');
  });
});
