import { render, screen, within } from '@testing-library/angular/zoneless';
import userEvent from '@testing-library/user-event';
import { signal } from '@angular/core';
import { provideRouter, Router } from '@angular/router';
import { describe, expect, it, vi } from 'vitest';
import { SessionListComponent } from './session-list.component';
import { SHOW_CLOSED_STORAGE_KEY } from './session-filter';
import { FleetApiService } from '../core/fleet-api.service';
import { FleetEventsService } from '../core/fleet-events.service';

function fakeEvents(overrides: { sessions?: unknown[]; managers?: unknown[]; workingStatesReported?: boolean } = {}) {
  return {
    sessions: signal(overrides.sessions ?? []),
    approvals: signal([]),
    managers: signal(overrides.managers ?? []),
    workingStates: signal(new Map()),
    workingStatesReported: signal(overrides.workingStatesReported ?? false),
    workingStateMaxAgeMinutes: signal<number | undefined>(30),
    workingStateMaxBytes: signal<number | undefined>(6144),
  };
}

function listNestingDepthOf(element: HTMLElement) {
  let depth = 0;
  for (let list = element.closest('ul'); list; list = list.parentElement?.closest('ul') ?? null) depth++;
  return depth;
}

function fakeApi(overrides: Record<string, unknown> = {}) {
  return {
    createSession: vi.fn().mockResolvedValue({}),
    createManagerSession: vi.fn().mockResolvedValue({}),
    pulseNow: vi.fn().mockResolvedValue({}),
    ...overrides,
  };
}

describe('SessionListComponent state overdue chip', () => {
  const sessions = [
    { id: 'm1', name: 'Lead', emoji: '🧭', role: 'manager', state: 'idle' },
    { id: 'c1', name: 'Gimli', emoji: '⚔️', parentId: 'm1', state: 'generating' },
    { id: 'c2', name: 'Legolas', emoji: '🏹', parentId: 'm1', state: 'closed' },
  ];

  it('user sees "state overdue" on the sidebar row of each open session that has no state, and not on a closed one', async () => {
    const fake = fakeEvents({ sessions, workingStatesReported: true });
    localStorage.setItem(SHOW_CLOSED_STORAGE_KEY, '1');

    await render(SessionListComponent, { providers: [provideRouter([]), { provide: FleetEventsService, useValue: fake }] });
    localStorage.clear();

    expect(within(screen.getByTestId('session-m1')).getByTestId('overdue-chip')).toBeTruthy();
    expect(within(screen.getByTestId('session-c1')).getByTestId('overdue-chip')).toBeTruthy();
    expect(within(screen.getByTestId('session-c2')).queryByTestId('overdue-chip')).toBeNull();
  });

  it('user sees "state overdue" once for a manager, not on both its row and its pulse card', async () => {
    const managers = [{ sessionId: 'm1', pulseSeconds: 1800, childrenCap: 2, missionText: 'x', nextPulseAt: new Date().toISOString(), childrenCount: 0 }];
    const fake = fakeEvents({ sessions: [sessions[0]], managers, workingStatesReported: true });

    await render(SessionListComponent, { providers: [provideRouter([]), { provide: FleetEventsService, useValue: fake }] });

    expect(screen.getAllByTestId('overdue-chip')).toHaveLength(1);
  });

  it('user keeps reading the session name when its row also carries the chip', async () => {
    const fake = fakeEvents({ sessions: [{ id: 'c1', name: 'Gimli', emoji: '⚔️', state: 'generating' }], workingStatesReported: true });

    await render(SessionListComponent, { providers: [provideRouter([]), { provide: FleetEventsService, useValue: fake }] });

    const row = screen.getByTestId('session-c1');
    expect(row).toHaveTextContent('Gimli');
    expect(within(row).getByTestId('overdue-chip')).toBeVisible();
  });

  it('user sees the sidebar chip as an icon named "state overdue: <reason>", with no label text taking room in the row', async () => {
    const fake = fakeEvents({ sessions: [{ id: 'c1', name: 'Gimli', emoji: '⚔️', state: 'generating' }], workingStatesReported: true });

    await render(SessionListComponent, { providers: [provideRouter([]), { provide: FleetEventsService, useValue: fake }] });

    const row = screen.getByTestId('session-c1');
    const chip = within(row).getByRole('img', { name: 'state overdue: No state recorded' });
    expect(chip).toHaveAttribute('title', 'No state recorded');
    expect(row).not.toHaveTextContent('state overdue');
  });

  it('user sees the sidebar chip on the same meta line as the state and the cost, not on a line of its own', async () => {
    const fake = fakeEvents({ sessions: [{ id: 'c1', name: 'Gimli', emoji: '⚔️', state: 'generating' }], workingStatesReported: true });

    await render(SessionListComponent, { providers: [provideRouter([]), { provide: FleetEventsService, useValue: fake }] });

    const row = screen.getByTestId('session-c1');
    const metaOfChip = within(row).getByTestId('overdue-chip').closest('.meta');
    const metaOfCost = row.querySelector('[title="Cost tracking is not implemented yet"]')?.closest('.meta');
    expect(metaOfChip).not.toBeNull();
    expect(metaOfChip).toBe(metaOfCost);
  });

  it('user sees no chip on the sidebar when the daemon does not report working states', async () => {
    const fake = fakeEvents({ sessions, workingStatesReported: false });

    await render(SessionListComponent, { providers: [provideRouter([]), { provide: FleetEventsService, useValue: fake }] });

    expect(screen.queryByTestId('overdue-chip')).toBeNull();
  });
});

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
    expect(listNestingDepthOf(screen.getByTestId('session-m1'))).toBe(1);
    expect(listNestingDepthOf(screen.getByTestId('session-c1'))).toBe(2);
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

    expect(listNestingDepthOf(screen.getByTestId('session-g1'))).toBe(3);
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

  it('user reads bidi and zero-width controls of a session name as escapes in the row, its title and its accessible name', async () => {
    const fake = fakeEvents({ sessions: [{ id: 's1', name: 'Gi‮mli​', emoji: '⚔️', state: 'idle' }] });
    await render(SessionListComponent, { providers: [provideRouter([]), { provide: FleetEventsService, useValue: fake }] });

    const row = screen.getByTestId('session-s1');
    expect(row).toHaveTextContent('Gi<U+202E>mli<U+200B>');
    expect(row).toHaveAttribute('aria-label', 'Gi<U+202E>mli<U+200B> — idle');
    expect(row.querySelector('.name')).toHaveAttribute('title', 'Gi<U+202E>mli<U+200B>');
  });

  it('keeps a long session name on a single line with the full name available in the title attribute', async () => {
    const longName = 'A very long manager session name that would otherwise wrap across two lines';
    const fake = fakeEvents({ sessions: [{ id: 's1', name: longName, emoji: '⚔️', state: 'idle' }] });
    await render(SessionListComponent, { providers: [provideRouter([]), { provide: FleetEventsService, useValue: fake }] });

    const nameEl = screen.getByTestId('session-s1').querySelector('.name');
    expect(nameEl).toHaveAttribute('title', longName);
  });

  it('user can reach the one new-session form from the sidebar, as a session or as a manager', async () => {
    await render(SessionListComponent, { providers: [provideRouter([]), { provide: FleetEventsService, useValue: fakeEvents() }] });

    expect(screen.getByTestId('new-session-link')).toHaveAttribute('href', '/new');
    expect(screen.getByTestId('new-manager-link')).toHaveAttribute('href', '/new?mode=manager');
  });

  it('user no longer sees an inline create form in the sidebar', async () => {
    await render(SessionListComponent, { providers: [provideRouter([]), { provide: FleetEventsService, useValue: fakeEvents() }] });

    expect(screen.queryByPlaceholderText('/path/to/worktree')).toBeNull();
    expect(screen.queryByTestId('create-manager')).toBeNull();
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
