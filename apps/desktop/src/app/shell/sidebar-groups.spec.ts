import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter, type Routes } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { within } from '@testing-library/angular/zoneless';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { FleetApiService } from '../core/fleet-api.service';
import { FleetEventsService } from '../core/fleet-events.service';
import { silentWorkingStateSignals } from '../working-state/working-state-fixtures';
import { AppShellComponent } from './app-shell.component';
import { InMemorySessionTodosSource, SESSION_TODOS_SOURCE } from './todos/session-todos-source';

@Component({ selector: 'stub-page', template: '<span data-testid="stub-page">page</span>' })
class StubPageComponent {}

const routes: Routes = [
  {
    path: '',
    component: AppShellComponent,
    children: [
      { path: '', pathMatch: 'full', component: StubPageComponent },
      { path: 'new', component: StubPageComponent },
      { path: 'project/:id', component: StubPageComponent },
    ],
  },
];

const openFleetProject = { id: 'p1', name: 'OpenFleet' };
const plainSession = { id: 's1', name: 'Gimli', emoji: '⚔️', state: 'idle', projectId: 'p1' };
const generatingSession = { id: 's2', name: 'Legolas', emoji: '🏹', state: 'generating', projectId: 'p1' };
const closedManager = { id: 'm1', name: 'Capitaine', emoji: '⚓', role: 'manager', state: 'closed', projectId: 'p1' };
const liveManager = { id: 'm2', name: 'Forge', emoji: '🔥', role: 'manager', state: 'idle', projectId: 'p1' };

function managerView(sessionId: string) {
  return { sessionId, pulseSeconds: 600, childrenCap: 8, missionText: 'x', nextPulseAt: new Date(Date.now() + 272_000).toISOString(), childrenCount: 0 };
}

async function openSidebar(sessions: unknown[] = [], managers: unknown[] = []) {
  TestBed.configureTestingModule({
    providers: [
      provideRouter(routes),
      {
        provide: FleetEventsService,
        useValue: {
          sessions: signal(sessions),
          managers: signal(managers),
          approvals: signal([]),
          connected: signal(true),
          ...silentWorkingStateSignals(),
          daemonIssues: signal([]),
          backgroundFailures: signal([]),
          workingStates: signal(new Map()),
          workingStatesReported: signal(false),
        },
      },
      { provide: FleetApiService, useValue: { listProjects: () => Promise.resolve({ items: [openFleetProject] }) } },
      { provide: SESSION_TODOS_SOURCE, useValue: new InMemorySessionTodosSource() },
    ],
  });
  const harness = await RouterTestingHarness.create('');
  await harness.fixture.whenStable();
  const sidebar = within(harness.routeNativeElement as HTMLElement).getByTestId('app-nav');
  const settle = () => harness.fixture.whenStable();
  return { harness, sidebar: within(sidebar), settle };
}

const groupToggleOf = (sidebar: ReturnType<typeof within>, title: string) => sidebar.getByRole('button', { name: title });

describe('Sidebar groups', () => {
  beforeEach(() => localStorage.clear());

  it('user sees the groups Sessions, Managers, Helm in that order', async () => {
    const { sidebar } = await openSidebar();

    const groupTitlesInOrder = ['Sessions', 'Managers', 'Helm'].map((title) => groupToggleOf(sidebar, title));

    const positions = groupTitlesInOrder.map((toggle) => Array.from(document.querySelectorAll('button')).indexOf(toggle as HTMLButtonElement));
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
    expect(groupTitlesInOrder.every((toggle) => toggle.getAttribute('aria-expanded') === 'true')).toBe(true);
  });

  it('user collapses the Sessions group and expands it again', async () => {
    const { sidebar, settle } = await openSidebar([plainSession]);

    await userEvent.click(groupToggleOf(sidebar, 'Sessions'));
    await settle();
    expect(groupToggleOf(sidebar, 'Sessions')).toHaveAttribute('aria-expanded', 'false');
    expect(sidebar.queryByTestId('session-s1')).toBeNull();

    await userEvent.click(groupToggleOf(sidebar, 'Sessions'));
    await settle();
    expect(groupToggleOf(sidebar, 'Sessions')).toHaveAttribute('aria-expanded', 'true');
    expect(sidebar.getByTestId('session-s1')).toBeTruthy();
  });

  it('user collapses the Helm group and the navigation links leave', async () => {
    const { sidebar, settle } = await openSidebar();

    await userEvent.click(groupToggleOf(sidebar, 'Helm'));
    await settle();

    expect(sidebar.queryByTestId('nav-inbox')).toBeNull();
  });

  it('user finds a collapsed group still collapsed after reloading the app', async () => {
    const firstVisit = await openSidebar([], [liveManager]);
    await userEvent.click(groupToggleOf(firstVisit.sidebar, 'Managers'));
    await firstVisit.settle();
    TestBed.resetTestingModule();

    const { sidebar } = await openSidebar([], [liveManager]);

    expect(groupToggleOf(sidebar, 'Managers')).toHaveAttribute('aria-expanded', 'false');
    expect(groupToggleOf(sidebar, 'Sessions')).toHaveAttribute('aria-expanded', 'true');
  });

  it('user sees how many sessions are running next to the Sessions title', async () => {
    const { sidebar } = await openSidebar([plainSession, generatingSession]);

    expect(sidebar.getByText('1 running')).toBeTruthy();
  });

  it('user sees how many managers exist next to the Managers title', async () => {
    const { sidebar } = await openSidebar([closedManager, liveManager], [managerView('m1'), managerView('m2')]);

    const managersHeader = groupToggleOf(sidebar, 'Managers').parentElement as HTMLElement;
    expect(within(managersHeader).getByText('2')).toBeTruthy();
  });

  it('user starts a new session from the plus of the Sessions header', async () => {
    const { sidebar } = await openSidebar();

    expect(sidebar.getByRole('link', { name: 'New session' })).toHaveAttribute('href', '/new');
  });

  it('user starts a new manager from the plus of the Managers header', async () => {
    const { sidebar } = await openSidebar();

    expect(sidebar.getByRole('link', { name: 'New manager' })).toHaveAttribute('href', '/new?mode=manager');
  });

  it('user no longer sees the bottom "+ New session" and "+ New manager" buttons', async () => {
    const { sidebar } = await openSidebar([plainSession]);

    expect(sidebar.queryByText('+ New session')).toBeNull();
    expect(sidebar.queryByText('+ New manager')).toBeNull();
  });

  it('user opens the project home from the project title of a session group', async () => {
    const { sidebar, settle } = await openSidebar([plainSession]);
    await settle();

    expect(await sidebar.findByRole('link', { name: '⌂ OpenFleet' })).toHaveAttribute('href', '/project/p1');
  });

  it('user starts a new session in a project from the plus of its project title', async () => {
    const { sidebar } = await openSidebar([plainSession]);

    expect(await sidebar.findByRole('link', { name: 'New session in OpenFleet' })).toHaveAttribute('href', '/new?projectId=p1');
  });

  it('user sees "◎ —" for a closed manager and "◎" with a countdown for a live one', async () => {
    const { sidebar } = await openSidebar([closedManager, liveManager], [managerView('m1'), managerView('m2')]);

    expect(sidebar.getByTestId('manager-row-m1-countdown')).toHaveTextContent('◎ —');
    expect(sidebar.getByTestId('manager-row-m2-countdown')).toHaveTextContent(/^◎ \d+:\d{2}$/);
  });
});
