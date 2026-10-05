import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter, type Routes } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { screen } from '@testing-library/angular/zoneless';
import userEvent from '@testing-library/user-event';
import type { SessionTodos } from '@openfleet/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FleetApiService } from '../core/fleet-api.service';
import { FleetEventsService } from '../core/fleet-events.service';
import { RightPanelComponent } from './right-panel.component';
import { LiveSessionTodosSource } from './todos/live-session-todos-source';
import { SESSION_TODOS_SOURCE } from './todos/session-todos-source';

@Component({
  selector: 'test-host',
  imports: [RightPanelComponent],
  template: `<of-right-panel />`,
})
class HostComponent {}

async function showRightPanel(): Promise<void> {
  await userEvent.click(screen.getByRole('button', { name: 'Show the right panel' }));
  await userEvent.click(screen.getByTestId('right-panel-tab-todos'));
}

const routes: Routes = [
  { path: '', pathMatch: 'full', component: HostComponent },
  { path: 'session/:sessionId', component: HostComponent },
];

function todosOf(sessionId: string, contents: string[]): SessionTodos {
  const items = contents.map((content, index) => ({ id: String(index + 1), content, status: 'pending' as const }));
  return { sessionId, items, counts: { total: items.length, completed: 0, inProgress: 0, pending: items.length }, omitted: 0, source: 'task_tools', updatedAt: '2026-10-01T10:00:00.000Z' };
}

describe('Right panel wired to the daemon', () => {
  let getSessionTodos: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => undefined });
    getSessionTodos = vi.fn((sessionId: string) => Promise.resolve(todosOf(sessionId, [`Todo of ${sessionId}`])));
    TestBed.configureTestingModule({
      providers: [
        provideRouter(routes),
        { provide: FleetApiService, useValue: { getSessionTodos } },
        { provide: SESSION_TODOS_SOURCE, useExisting: LiveSessionTodosSource },
      ],
    });
    const events = TestBed.inject(FleetEventsService);
    events.snapshotReceived.set(true);
    events.todosReported.set(true);
  });

  afterEach(() => vi.unstubAllGlobals());

  async function open(url: string) {
    const harness = await RouterTestingHarness.create(url);
    harness.fixture.autoDetectChanges();
    return harness;
  }

  it('asks the daemon for nothing while the panel is closed', async () => {
    await open('/session/s1');

    expect(getSessionTodos).not.toHaveBeenCalled();
  });

  it('loads and shows the todos of the session in the route once the panel opens', async () => {
    await open('/session/s1');

    await showRightPanel();

    expect((await screen.findByTestId('todo-item-text')).textContent).toContain('Todo of s1');
    expect(getSessionTodos.mock.calls).toEqual([['s1']]);
  });

  it('follows the route and asks for the newly selected session only', async () => {
    const harness = await open('/session/s1');
    await showRightPanel();
    await screen.findByText('Todo of s1');

    await harness.navigateByUrl('/session/s2');

    expect(await screen.findByText('Todo of s2')).not.toBeNull();
    expect(getSessionTodos.mock.calls).toEqual([['s1'], ['s2']]);
  });

  it('shows the error copy and a Try again that loads the list when the daemon fails once', async () => {
    getSessionTodos.mockRejectedValueOnce(new TypeError('fetch failed'));
    await open('/session/s1');
    await showRightPanel();

    expect((await screen.findByTestId('todos-error')).textContent).toContain('Can’t reach the OpenFleet daemon');
    await userEvent.click(screen.getByTestId('todos-retry'));

    expect(await screen.findByText('Todo of s1')).not.toBeNull();
  });

  it('says the daemon does not report todos when it is older than the feature', async () => {
    TestBed.inject(FleetEventsService).todosReported.set(false);
    await open('/session/s1');

    await showRightPanel();

    expect(await screen.findByTestId('todos-unsupported')).not.toBeNull();
  });
});
