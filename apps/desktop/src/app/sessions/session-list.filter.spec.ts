import { render, screen, within } from '@testing-library/angular/zoneless';
import userEvent from '@testing-library/user-event';
import { signal } from '@angular/core';
import { provideRouter } from '@angular/router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionListComponent } from './session-list.component';
import { SHOW_CLOSED_STORAGE_KEY } from './session-filter';
import { FleetApiService } from '../core/fleet-api.service';
import { FleetEventsService } from '../core/fleet-events.service';

const live = { id: 'live', name: 'Gimli', emoji: '⚔️', state: 'generating' };
const finished = { id: 'done', name: 'Legolas', emoji: '🏹', state: 'closed' };
const closedManager = { id: 'm1', name: 'Capitaine', emoji: '🧭', role: 'manager', state: 'closed' };

async function renderList(options: { sessions: unknown[]; projects?: { id: string; name: string }[] }) {
  const events = {
    sessions: signal(options.sessions),
    approvals: signal([]),
    managers: signal([]),
    workingStates: signal(new Map()),
    workingStatesReported: signal(false),
    workingStateMaxAgeMinutes: signal<number | undefined>(30),
    workingStateMaxBytes: signal<number | undefined>(6144),
  };
  const api = { listProjects: vi.fn().mockResolvedValue({ items: options.projects ?? [] }), pulseNow: vi.fn() };
  await render(SessionListComponent, {
    providers: [provideRouter([]), { provide: FleetApiService, useValue: api }, { provide: FleetEventsService, useValue: events }],
  });
  return events;
}

describe('SessionListComponent active sessions only', () => {
  beforeEach(() => localStorage.clear());

  it('user sees open sessions and not closed ones by default', async () => {
    await renderList({ sessions: [live, finished] });

    expect(screen.getByTestId('session-live')).toBeTruthy();
    expect(screen.queryByTestId('session-done')).toBeNull();
  });

  it('user reveals closed sessions with the "Show closed" toggle, which announces it is pressed', async () => {
    await renderList({ sessions: [live, finished] });
    const toggle = screen.getByRole('button', { name: 'Show closed (1)' });
    expect(toggle).toHaveAttribute('aria-pressed', 'false');

    await userEvent.click(toggle);

    expect(await screen.findByTestId('session-done')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Show closed (1)' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('user hides closed sessions again by pressing the toggle a second time', async () => {
    await renderList({ sessions: [live, finished] });
    const toggle = screen.getByRole('button', { name: 'Show closed (1)' });

    await userEvent.click(toggle);
    await screen.findByTestId('session-done');
    await userEvent.click(toggle);

    await vi.waitFor(() => expect(screen.queryByTestId('session-done')).toBeNull());
  });

  it('user finds the preference kept after a reload', async () => {
    localStorage.setItem(SHOW_CLOSED_STORAGE_KEY, '1');

    await renderList({ sessions: [live, finished] });

    expect(screen.getByTestId('session-done')).toBeTruthy();
  });

  it('user triggers the toggle from the keyboard', async () => {
    await renderList({ sessions: [live, finished] });

    screen.getByRole('button', { name: 'Show closed (1)' }).focus();
    await userEvent.keyboard('{Enter}');

    expect(await screen.findByTestId('session-done')).toBeTruthy();
    expect(localStorage.getItem(SHOW_CLOSED_STORAGE_KEY)).toBe('1');
  });

  it('user sees no toggle when nothing is closed', async () => {
    await renderList({ sessions: [live] });

    expect(screen.queryByRole('button', { name: /Show closed/ })).toBeNull();
  });

  it('user sees "No active sessions" when every session is closed', async () => {
    await renderList({ sessions: [finished] });

    expect(screen.getByText('No active sessions')).toBeTruthy();
  });

  it('user does not see a closed manager in the sessions list, even with closed sessions shown', async () => {
    localStorage.setItem(SHOW_CLOSED_STORAGE_KEY, '1');

    await renderList({ sessions: [closedManager, finished] });

    expect(screen.queryByTestId('session-m1')).toBeNull();
    expect(screen.getByTestId('session-done')).toBeTruthy();
  });

  it('user still sees an open manager in the sessions list', async () => {
    await renderList({ sessions: [{ ...closedManager, state: 'idle' }] });

    expect(screen.getByTestId('session-m1')).toBeTruthy();
  });
});

describe('SessionListComponent project groups', () => {
  beforeEach(() => localStorage.clear());

  it('user sees sessions under their project name with "No project" last', async () => {
    const sessions = [
      { ...live, id: 'loose', name: 'Loose' },
      { ...live, id: 'p-ccm', name: 'InCcm', projectId: 'ccm' },
    ];

    await renderList({ sessions, projects: [{ id: 'ccm', name: 'CCM' }] });

    const headings = await screen.findAllByRole('heading', { level: 3 });
    expect(headings.map((h) => h.textContent?.trim())).toEqual(['⌂ CCM', 'No project']);
  });

  it('user sees no group heading when no session belongs to a project', async () => {
    await renderList({ sessions: [live] });

    expect(screen.queryAllByRole('heading', { level: 3 })).toHaveLength(0);
  });

  it('user sees the row of a grouped session still selectable', async () => {
    await renderList({ sessions: [{ ...live, projectId: 'ccm' }], projects: [{ id: 'ccm', name: 'CCM' }] });

    expect(within(screen.getByTestId('session-live')).getByText(/Gimli/)).toBeTruthy();
  });
});
