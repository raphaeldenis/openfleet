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

  it('renders a manager card and pulses on click', async () => {
    const api = fakeApi();
    const nextPulseAt = new Date(Date.now() + 42_000).toISOString();
    const fake = fakeEvents({
      sessions: [{ id: 'm1', name: 'Lead', emoji: '🧭', role: 'manager', state: 'idle' }],
      managers: [{ sessionId: 'm1', pulseSeconds: 1800, childrenCap: 2, missionText: 'x', nextPulseAt, childrenCount: 1 }],
    });
    await render(SessionListComponent, { providers: [provideRouter([]), { provide: FleetApiService, useValue: api }, { provide: FleetEventsService, useValue: fake }] });
    expect(screen.getByTestId('manager-m1-card')).toBeTruthy();
    await userEvent.click(screen.getByTestId('manager-m1-pulse'));
    expect(api.pulseNow).toHaveBeenCalledWith('m1');
  });

  it('wraps the manager card in its own <li> so the sidebar list stays valid markup', async () => {
    const fake = fakeEvents({
      sessions: [{ id: 'm1', name: 'Lead', emoji: '🧭', role: 'manager', state: 'idle' }],
      managers: [{ sessionId: 'm1', pulseSeconds: 1800, childrenCap: 2, missionText: 'x', nextPulseAt: new Date().toISOString(), childrenCount: 0 }],
    });
    await render(SessionListComponent, { providers: [provideRouter([]), { provide: FleetEventsService, useValue: fake }] });
    expect(screen.getByTestId('manager-m1-card').closest('li')).toBeTruthy();
  });

  it('navigates to the manager dashboard when a root manager row is clicked, instead of opening its terminal', async () => {
    const fake = fakeEvents({ sessions: [{ id: 'm1', name: 'Lead', emoji: '🧭', role: 'manager', state: 'idle' }] });
    const { fixture } = await render(SessionListComponent, { providers: [provideRouter([]), { provide: FleetEventsService, useValue: fake }] });
    const router = fixture.debugElement.injector.get(Router);
    const navigateSpy = vi.spyOn(router, 'navigate').mockResolvedValue(true);

    await userEvent.click(screen.getByTestId('session-m1'));

    expect(navigateSpy).toHaveBeenCalledWith(['/manager', 'm1']);
  });

  it('navigates to its dashboard when a child session that is itself a manager is clicked, instead of opening a terminal', async () => {
    const fake = fakeEvents({
      sessions: [
        { id: 'm1', name: 'Lead', emoji: '🧭', role: 'manager', state: 'idle' },
        { id: 'm2', name: 'Nested', emoji: '🧭', role: 'manager', parentId: 'm1', state: 'idle' },
      ],
    });
    const { fixture } = await render(SessionListComponent, { providers: [provideRouter([]), { provide: FleetEventsService, useValue: fake }] });
    const router = fixture.debugElement.injector.get(Router);
    const navigateSpy = vi.spyOn(router, 'navigate').mockResolvedValue(true);

    await userEvent.click(screen.getByTestId('session-m2'));

    expect(navigateSpy).toHaveBeenCalledWith(['/manager', 'm2']);
  });

  it('opens the terminal (does not navigate) when a plain root session is clicked', async () => {
    const fake = fakeEvents({ sessions: [{ id: 's1', name: 'Gimli', emoji: '⚔️', state: 'idle' }] });
    const { fixture } = await render(SessionListComponent, { providers: [provideRouter([]), { provide: FleetEventsService, useValue: fake }] });
    const selected = vi.fn();
    fixture.componentInstance.selected.subscribe(selected);

    await userEvent.click(screen.getByTestId('session-s1'));

    expect(selected).toHaveBeenCalledWith('s1');
  });

  it('renders a child whose parent is missing from the session list (orphan) at the root level instead of hiding it', async () => {
    const fake = fakeEvents({
      sessions: [{ id: 'c1', name: 'Gimli', emoji: '⚔️', parentId: 'missing-parent', state: 'idle' }],
    });
    await render(SessionListComponent, { providers: [provideRouter([]), { provide: FleetEventsService, useValue: fake }] });

    expect(screen.getByTestId('session-c1')).toBeTruthy();
  });

  it('renders a grandchild (a session whose parent is itself a child) indented under its own parent, not hidden', async () => {
    const fake = fakeEvents({
      sessions: [
        { id: 'm1', name: 'Lead', emoji: '🧭', role: 'manager', state: 'idle' },
        { id: 'c1', name: 'Gimli', emoji: '⚔️', parentId: 'm1', state: 'idle' },
        { id: 'g1', name: 'Legolas', emoji: '🏹', parentId: 'c1', state: 'idle' },
      ],
    });
    await render(SessionListComponent, { providers: [provideRouter([]), { provide: FleetEventsService, useValue: fake }] });

    const grandchildRow = screen.getByTestId('session-g1');
    expect(grandchildRow).toBeTruthy();
    expect(grandchildRow.className).toContain('child');
    const innermostChildrenList = grandchildRow.closest('.children');
    const outermostChildrenList = innermostChildrenList?.parentElement?.closest('.children');
    expect(outermostChildrenList).toBeTruthy();
  });

  it('renders a great-grandchild the same way, so lineage depth is not artificially capped', async () => {
    const fake = fakeEvents({
      sessions: [
        { id: 'm1', name: 'Lead', emoji: '🧭', role: 'manager', state: 'idle' },
        { id: 'c1', name: 'Gimli', emoji: '⚔️', parentId: 'm1', state: 'idle' },
        { id: 'g1', name: 'Legolas', emoji: '🏹', parentId: 'c1', state: 'idle' },
        { id: 'gg1', name: 'Frodo', emoji: '💍', parentId: 'g1', state: 'idle' },
      ],
    });
    await render(SessionListComponent, { providers: [provideRouter([]), { provide: FleetEventsService, useValue: fake }] });

    expect(screen.getByTestId('session-gg1')).toBeTruthy();
  });

  it('shows the model rung and a not-implemented cost placeholder on a session row, like the dashboard table', async () => {
    const fake = fakeEvents({ sessions: [{ id: 's1', name: 'Gimli', emoji: '⚔️', state: 'idle', model: 'sonnet' }] });
    await render(SessionListComponent, { providers: [provideRouter([]), { provide: FleetEventsService, useValue: fake }] });

    const row = screen.getByTestId('session-s1');
    expect(row).toHaveTextContent('sonnet');
    const cost = row.querySelector('[title="Cost tracking is not implemented yet"]');
    expect(cost).toHaveTextContent('—');
  });

  it('keeps a long session name on a single line with the full name available in the title attribute', async () => {
    const longName = 'A very long manager session name that would otherwise wrap across two lines';
    const fake = fakeEvents({ sessions: [{ id: 's1', name: longName, emoji: '⚔️', state: 'idle' }] });
    await render(SessionListComponent, { providers: [provideRouter([]), { provide: FleetEventsService, useValue: fake }] });

    const nameEl = screen.getByTestId('session-s1').querySelector('.name');
    expect(nameEl).toHaveAttribute('title', longName);
  });

  it('lets a keyboard-only user Tab to a session row and open it with Enter', async () => {
    const fake = fakeEvents({ sessions: [{ id: 's1', name: 'Gimli', emoji: '⚔️', state: 'idle' }] });
    const { fixture } = await render(SessionListComponent, { providers: [provideRouter([]), { provide: FleetEventsService, useValue: fake }] });
    const selected = vi.fn();
    fixture.componentInstance.selected.subscribe(selected);

    await userEvent.tab();
    expect(screen.getByTestId('session-s1')).toHaveFocus();
    await userEvent.keyboard('{Enter}');

    expect(selected).toHaveBeenCalledWith('s1');
  });
});
