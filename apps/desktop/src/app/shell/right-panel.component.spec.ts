import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter, type Routes } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { screen, within } from '@testing-library/angular/zoneless';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FleetEventsService } from '../core/fleet-events.service';
import { RightPanelComponent, RightPanelToggleComponent, watchedSessionIdOf } from './right-panel.component';
import { InMemorySessionTodosSource, SESSION_TODOS_SOURCE } from './todos/session-todos-source';
import type { SessionTodos } from './todos/todos.adapter';

@Component({
  selector: 'test-host',
  imports: [RightPanelToggleComponent, RightPanelComponent],
  template: `<button type="button" data-testid="outside-button">outside</button><of-right-panel-toggle /><of-right-panel />`,
})
class HostComponent {}

const routes: Routes = [
  { path: '', pathMatch: 'full', component: HostComponent },
  { path: 'session/:sessionId', component: HostComponent },
  { path: 'manager/:id', component: HostComponent },
];

const OPEN_KEY = 'openfleet.rightPanel.open';

function memoryStorage(initial: Record<string, string> = {}): Storage {
  const data = new Map(Object.entries(initial));
  return {
    get length() { return data.size; },
    clear: () => data.clear(),
    getItem: (key: string) => data.get(key) ?? null,
    key: (index: number) => Array.from(data.keys())[index] ?? null,
    removeItem: (key: string) => { data.delete(key); },
    setItem: (key: string, value: string) => { data.set(key, value); },
  };
}

function throwingStorage(): Storage {
  const fail = () => { throw new DOMException('denied', 'SecurityError'); };
  return { length: 0, clear: fail, getItem: fail, key: fail, removeItem: fail, setItem: fail };
}

function todosOf(sessionId: string): SessionTodos {
  return {
    sessionId,
    items: [{ id: '1', content: 'Review PR', status: 'completed' }, { id: '2', content: 'Fix types', status: 'pending' }],
    counts: { total: 2, completed: 1, inProgress: 0, pending: 1 },
    omitted: 0,
    source: 'task_tools',
    updatedAt: '2026-09-30T14:32:00.000Z',
  };
}

interface SetUpOptions { url?: string; storage?: Storage; sessions?: { id: string; state: string }[]; connected?: boolean }

async function setUp(options: SetUpOptions = {}) {
  vi.stubGlobal('localStorage', options.storage ?? memoryStorage());
  const source = new InMemorySessionTodosSource();
  const events = { sessions: signal(options.sessions ?? []), connected: signal(options.connected ?? true) };
  TestBed.configureTestingModule({
    providers: [
      provideRouter(routes),
      { provide: FleetEventsService, useValue: events },
      { provide: SESSION_TODOS_SOURCE, useValue: source },
    ],
  });
  const harness = await RouterTestingHarness.create(options.url ?? '/');
  harness.fixture.autoDetectChanges();
  return { source, events, harness };
}

const toggle = () => screen.getByTestId('right-panel-toggle');
const panel = () => screen.queryByTestId('right-panel');
const pressShortcut = () => document.dispatchEvent(new KeyboardEvent('keydown', { key: '∫', code: 'KeyB', altKey: true, metaKey: true, bubbles: true }));

describe('RightPanelComponent', () => {
  beforeEach(() => vi.unstubAllGlobals());
  afterEach(() => vi.unstubAllGlobals());

  describe('open state', () => {
    it('is closed by default', async () => {
      await setUp();

      expect(panel()).toBeNull();
      expect(toggle().getAttribute('aria-expanded')).toBe('false');
    });

    it('opens and closes from the top-bar toggle', async () => {
      await setUp();

      await userEvent.click(toggle());
      expect(panel()).not.toBeNull();
      expect(toggle().getAttribute('aria-expanded')).toBe('true');

      await userEvent.click(toggle());
      expect(panel()).toBeNull();
    });

    it('remembers that it was opened', async () => {
      const storage = memoryStorage();
      await setUp({ storage });

      await userEvent.click(toggle());

      expect(storage.getItem(OPEN_KEY)).toBe('true');
    });

    it('starts open when it was left open', async () => {
      await setUp({ storage: memoryStorage({ [OPEN_KEY]: 'true' }) });

      expect(panel()).not.toBeNull();
    });

    it('starts closed and still toggles when storage is unavailable', async () => {
      await setUp({ storage: throwingStorage() });
      expect(panel()).toBeNull();

      await userEvent.click(toggle());

      expect(panel()).not.toBeNull();
    });

    it('toggles with Option+Cmd+B', async () => {
      const { harness } = await setUp();

      pressShortcut();
      await harness.fixture.whenStable();
      expect(panel()).not.toBeNull();

      pressShortcut();
      await harness.fixture.whenStable();
      expect(panel()).toBeNull();
    });

    it('closes with Escape when focus is inside and returns focus to the toggle', async () => {
      await setUp({ storage: memoryStorage({ [OPEN_KEY]: 'true' }) });
      screen.getByRole('tab', { name: /Todos/ }).focus();

      await userEvent.keyboard('{Escape}');

      expect(panel()).toBeNull();
      expect(document.activeElement).toBe(toggle());
    });

    it('ignores Escape when focus is outside the panel', async () => {
      await setUp({ storage: memoryStorage({ [OPEN_KEY]: 'true' }) });
      screen.getByTestId('outside-button').focus();

      await userEvent.keyboard('{Escape}');

      expect(panel()).not.toBeNull();
    });

    it('closes from its collapse button and returns focus to the toggle', async () => {
      await setUp({ storage: memoryStorage({ [OPEN_KEY]: 'true' }) });

      await userEvent.click(screen.getByRole('button', { name: 'Collapse panel' }));

      expect(panel()).toBeNull();
      expect(document.activeElement).toBe(toggle());
    });
  });

  describe('tabs', () => {
    const openPanel = () => setUp({ storage: memoryStorage({ [OPEN_KEY]: 'true' }) });

    it('lists Sessions, Usage and Todos with Todos selected', async () => {
      await openPanel();

      const tabs = within(screen.getByRole('tablist', { name: 'Right panel' })).getAllByRole('tab');
      expect(tabs.map((tab) => tab.getAttribute('data-testid'))).toEqual(['right-panel-tab-sessions', 'right-panel-tab-usage', 'right-panel-tab-todos']);
      expect(tabs.map((tab) => tab.getAttribute('aria-selected'))).toEqual(['false', 'false', 'true']);
    });

    it('announces Sessions and Usage as disabled with the visible label "Coming soon"', async () => {
      await openPanel();

      for (const name of ['sessions', 'usage']) {
        const tab = screen.getByTestId(`right-panel-tab-${name}`);
        expect(tab.getAttribute('aria-disabled')).toBe('true');
        expect(tab.textContent).toContain('Coming soon');
        expect(tab.getAttribute('title')).toBe('Coming soon');
      }
      expect(screen.getByTestId('right-panel-tab-todos').getAttribute('aria-disabled')).toBeNull();
    });

    it('does not activate a disabled tab', async () => {
      await openPanel();

      await userEvent.click(screen.getByTestId('right-panel-tab-usage'));

      expect(screen.getByTestId('right-panel-tab-usage').getAttribute('aria-selected')).toBe('false');
      expect(screen.getByTestId('right-panel-tab-todos').getAttribute('aria-selected')).toBe('true');
      expect(screen.getByRole('tabpanel')).not.toBeNull();
    });

    it('moves focus across the three tabs with arrows, Home and End', async () => {
      await openPanel();
      screen.getByTestId('right-panel-tab-todos').focus();

      await userEvent.keyboard('{ArrowLeft}');
      expect(document.activeElement).toBe(screen.getByTestId('right-panel-tab-usage'));
      await userEvent.keyboard('{Home}');
      expect(document.activeElement).toBe(screen.getByTestId('right-panel-tab-sessions'));
      await userEvent.keyboard('{End}');
      expect(document.activeElement).toBe(screen.getByTestId('right-panel-tab-todos'));
      await userEvent.keyboard('{ArrowRight}');
      expect(document.activeElement).toBe(screen.getByTestId('right-panel-tab-sessions'));
    });

    it('labels the tabpanel by the Todos tab', async () => {
      await openPanel();

      expect(screen.getByRole('tabpanel', { name: /Todos/ })).not.toBeNull();
    });
  });

  describe('watched session', () => {
    it('shows the todos of the session in the route', async () => {
      const storage = memoryStorage({ [OPEN_KEY]: 'true' });
      const { source } = await setUp({ url: '/session/s1', storage });
      source.publish('s1', { kind: 'ready', todos: todosOf('s1') });

      expect(await screen.findAllByTestId('todo-item')).toHaveLength(2);
    });

    it('follows the route to another session', async () => {
      const storage = memoryStorage({ [OPEN_KEY]: 'true' });
      const { source, harness } = await setUp({ url: '/session/s1', storage });
      source.publish('s1', { kind: 'ready', todos: todosOf('s1') });
      await harness.navigateByUrl('/session/s2');

      expect(screen.queryAllByTestId('todo-item')).toHaveLength(0);
      expect(screen.getByTestId('todos-empty')).not.toBeNull();
    });

    it('asks to select a session on a route without one', async () => {
      await setUp({ url: '/', storage: memoryStorage({ [OPEN_KEY]: 'true' }) });

      expect(screen.getByTestId('todos-no-session')).not.toBeNull();
    });

    it('marks the list read-only when the watched session is closed', async () => {
      const storage = memoryStorage({ [OPEN_KEY]: 'true' });
      const { source } = await setUp({ url: '/session/s1', storage, sessions: [{ id: 's1', state: 'closed' }] });
      source.publish('s1', { kind: 'ready', todos: todosOf('s1') });

      expect((await screen.findByTestId('todos-closed-note')).textContent).toContain('This session is closed: last known list');
    });

    it('marks the list stale when the socket is down', async () => {
      const storage = memoryStorage({ [OPEN_KEY]: 'true' });
      const { source } = await setUp({ url: '/session/s1', storage, connected: false });
      source.publish('s1', { kind: 'ready', todos: todosOf('s1') });

      expect((await screen.findByTestId('todos-stale-note')).textContent).toContain('reconnecting to the daemon');
    });
  });

  describe('watchedSessionIdOf', () => {
    it.each([
      ['/session/abc', 'abc'],
      ['/manager/m1', 'm1'],
      ['/session/abc?x=1#frag', 'abc'],
      ['/', undefined],
      ['/inbox', undefined],
      ['/session', undefined],
    ])('reads %s as %s', (url, expected) => {
      expect(watchedSessionIdOf(url)).toBe(expected);
    });
  });
});
