import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter, type Routes } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { screen, within } from '@testing-library/angular/zoneless';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FleetEventsService } from '../core/fleet-events.service';
import { RightPanelSessionToggleComponent } from '../sessions/right-panel-session-toggle.component';
import { silentWorkingStateSignals } from '../working-state/working-state-fixtures';
import { RightPanelComponent } from './right-panel.component';
import { InMemorySessionTodosSource, SESSION_TODOS_SOURCE } from './todos/session-todos-source';
import type { SessionTodos } from './todos/todos.adapter';

@Component({
  selector: 'test-host',
  imports: [RightPanelSessionToggleComponent, RightPanelComponent],
  template: `<button type="button" data-testid="outside-button">outside</button><of-right-panel-session-toggle /><of-right-panel />`,
})
class HostComponent {}

const routes: Routes = [
  { path: '', pathMatch: 'full', component: HostComponent },
  { path: 'inbox', component: HostComponent },
  { path: 'notes', component: HostComponent },
  { path: 'tables', component: HostComponent },
  { path: 'project', component: HostComponent },
  { path: 'settings', component: HostComponent },
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

const SELECTED_SESSION_URL = '/session/s1';
const closedPreference = () => memoryStorage({ [OPEN_KEY]: 'false' });

async function setUp(options: SetUpOptions = {}) {
  vi.stubGlobal('localStorage', options.storage ?? closedPreference());
  const source = new InMemorySessionTodosSource();
  const events = { sessions: signal(options.sessions ?? []), connected: signal(options.connected ?? true), ...silentWorkingStateSignals() };
  TestBed.configureTestingModule({
    providers: [
      provideRouter(routes),
      { provide: FleetEventsService, useValue: events },
      { provide: SESSION_TODOS_SOURCE, useValue: source },
    ],
  });
  const harness = await RouterTestingHarness.create(options.url ?? SELECTED_SESSION_URL);
  harness.fixture.autoDetectChanges();
  return { source, events, harness };
}

const showButton = () => screen.queryByRole('button', { name: 'Show the right panel' });
const hideButton = () => screen.queryByRole('button', { name: 'Hide the right panel' });
const sessionToggle = () => screen.getByRole('button', { name: 'Right panel' });
const panel = () => screen.queryByTestId('right-panel');
const press = (init: KeyboardEventInit) => document.dispatchEvent(new KeyboardEvent('keydown', { key: '∫', code: 'KeyB', bubbles: true, cancelable: true, ...init }));
const pressShortcut = () => press({ altKey: true, metaKey: true });

describe('RightPanelComponent', () => {
  beforeEach(() => vi.unstubAllGlobals());
  afterEach(() => vi.unstubAllGlobals());

  describe('presence', () => {
    it.each(['/', '/inbox', '/notes', '/tables', '/project', '/settings'])('has no panel, rail button or shortcut on %s', async (url) => {
      const { harness } = await setUp({ url, storage: memoryStorage({ [OPEN_KEY]: 'true' }) });

      pressShortcut();
      await harness.fixture.whenStable();

      expect(panel()).toBeNull();
      expect(showButton()).toBeNull();
      expect(hideButton()).toBeNull();
    });

    it.each(['/session/s1', '/manager/m1'])('is present on %s', async (url) => {
      await setUp({ url, storage: memoryStorage({ [OPEN_KEY]: 'true' }) });

      expect(panel()).not.toBeNull();
    });

    it('offers the rail button on a selected manager when the panel is closed, and opens from it', async () => {
      await setUp({ url: '/manager/m1' });

      await userEvent.click(showButton()!);

      expect(panel()).not.toBeNull();
    });

    it('disappears when the selection is left and comes back in the state it was left', async () => {
      const { harness } = await setUp({ storage: memoryStorage() });
      await userEvent.click(screen.getByTestId('right-panel-tab-todos'));
      await userEvent.click(hideButton()!);

      await harness.navigateByUrl('/inbox');
      expect(showButton()).toBeNull();
      await harness.navigateByUrl('/session/s2');

      expect(panel()).toBeNull();
      await userEvent.click(showButton()!);
      expect(screen.getByTestId('right-panel-tab-todos').getAttribute('aria-selected')).toBe('true');
    });

    it('stays open across the selection being left and picked again', async () => {
      const { harness } = await setUp({ storage: memoryStorage() });

      await harness.navigateByUrl('/inbox');
      await harness.navigateByUrl('/manager/m1');

      expect(panel()).not.toBeNull();
    });
  });

  describe('open state', () => {
    it('is closed when the user closed it', async () => {
      await setUp();

      expect(panel()).toBeNull();
      expect(showButton()?.getAttribute('aria-expanded')).toBe('false');
      expect(sessionToggle().getAttribute('aria-pressed')).toBe('false');
    });

    it('is open for a user who never chose, since it holds the identity and actions of the selection', async () => {
      await setUp({ storage: memoryStorage() });

      expect(panel()).not.toBeNull();
      expect(sessionToggle().getAttribute('aria-pressed')).toBe('true');
    });

    it('opens from the rail button and closes from the panel header button', async () => {
      await setUp();

      await userEvent.click(showButton()!);
      expect(panel()).not.toBeNull();
      expect(showButton()).toBeNull();
      expect(hideButton()?.getAttribute('aria-expanded')).toBe('true');

      await userEvent.click(hideButton()!);
      expect(panel()).toBeNull();
      expect(hideButton()).toBeNull();
    });

    it('opens and closes from the session toggle, which reports its state with aria-pressed', async () => {
      await setUp();

      await userEvent.click(sessionToggle());
      expect(panel()).not.toBeNull();
      expect(sessionToggle().getAttribute('aria-pressed')).toBe('true');

      await userEvent.click(sessionToggle());
      expect(panel()).toBeNull();
      expect(sessionToggle().getAttribute('aria-pressed')).toBe('false');
    });

    it('toggles from the session toggle with the keyboard', async () => {
      await setUp();
      sessionToggle().focus();

      await userEvent.keyboard('{Enter}');
      expect(panel()).not.toBeNull();

      await userEvent.keyboard(' ');
      expect(panel()).toBeNull();
    });

    it('keeps the rail, the header button and the session toggle in sync with the shortcut', async () => {
      const { harness } = await setUp();

      pressShortcut();
      await harness.fixture.whenStable();
      expect(hideButton()).not.toBeNull();
      expect(sessionToggle().getAttribute('aria-pressed')).toBe('true');

      pressShortcut();
      await harness.fixture.whenStable();
      expect(showButton()).not.toBeNull();
      expect(sessionToggle().getAttribute('aria-pressed')).toBe('false');
    });

    it('describes the controls with their shortcut', async () => {
      await setUp();

      expect(showButton()?.getAttribute('title')).toBe('Show the right panel — session, todos, usage (⌥⌘B)');
      expect(sessionToggle().getAttribute('title')).toBe('Show the right panel (⌥⌘B)');
      await userEvent.click(sessionToggle());
      expect(hideButton()?.getAttribute('title')).toBe('Hide the right panel (⌥⌘B)');
      expect(sessionToggle().getAttribute('title')).toBe('Hide the right panel (⌥⌘B)');
    });

    it('remembers that it was opened', async () => {
      const storage = closedPreference();
      await setUp({ storage });

      await userEvent.click(showButton()!);

      expect(storage.getItem(OPEN_KEY)).toBe('true');
    });

    it('remembers that it was closed', async () => {
      const storage = memoryStorage();
      await setUp({ storage });

      await userEvent.click(hideButton()!);

      expect(storage.getItem(OPEN_KEY)).toBe('false');
    });

    it('starts open when it was left open', async () => {
      await setUp({ storage: memoryStorage({ [OPEN_KEY]: 'true' }) });

      expect(panel()).not.toBeNull();
    });

    it('starts open and still toggles when storage is unavailable', async () => {
      await setUp({ storage: throwingStorage() });
      expect(panel()).not.toBeNull();

      await userEvent.click(hideButton()!);

      expect(panel()).toBeNull();
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

    it.each([
      ['plain Cmd+B, which an editor may use for bold', { metaKey: true }],
      ['Ctrl+Alt+B, the VoiceOver chord', { altKey: true, ctrlKey: true }],
      ['AltGr+B, which arrives as Ctrl+Alt+Cmd', { altKey: true, ctrlKey: true, metaKey: true }],
      ['Option+Cmd with another key', { altKey: true, metaKey: true, code: 'KeyA' }],
    ])('ignores %s', async (_name, init) => {
      const { harness } = await setUp();

      press(init);
      await harness.fixture.whenStable();

      expect(panel()).toBeNull();
    });

    it('ignores the repeats of a key held down', async () => {
      const { harness } = await setUp();
      pressShortcut();
      await harness.fixture.whenStable();

      press({ altKey: true, metaKey: true, repeat: true });
      await harness.fixture.whenStable();

      expect(panel()).not.toBeNull();
    });

    it('ignores the shortcut while a modal such as the close-session dialog makes the page inert', async () => {
      const { harness } = await setUp();
      harness.fixture.nativeElement.setAttribute('inert', '');

      pressShortcut();
      await harness.fixture.whenStable();

      expect(panel()).toBeNull();
    });

    it('returns focus to the rail button when the shortcut closes the panel from inside', async () => {
      const { harness } = await setUp({ storage: memoryStorage({ [OPEN_KEY]: 'true' }) });
      screen.getByRole('tab', { name: /Todos/ }).focus();

      pressShortcut();
      await harness.fixture.whenStable();

      expect(panel()).toBeNull();
      expect(document.activeElement).toBe(showButton());
    });

    it('closes with Escape when focus is inside and returns focus to the rail button', async () => {
      await setUp({ storage: memoryStorage({ [OPEN_KEY]: 'true' }) });
      screen.getByRole('tab', { name: /Todos/ }).focus();

      await userEvent.keyboard('{Escape}');

      expect(panel()).toBeNull();
      expect(document.activeElement).toBe(showButton());
    });

    it('ignores Escape when focus is outside the panel', async () => {
      await setUp({ storage: memoryStorage({ [OPEN_KEY]: 'true' }) });
      screen.getByTestId('outside-button').focus();

      await userEvent.keyboard('{Escape}');

      expect(panel()).not.toBeNull();
    });

    it('returns focus to the rail button when the header button closes the panel', async () => {
      await setUp({ storage: memoryStorage({ [OPEN_KEY]: 'true' }) });

      await userEvent.click(hideButton()!);

      expect(panel()).toBeNull();
      expect(document.activeElement).toBe(showButton());
    });
  });

  describe('tabs', () => {
    const openPanel = () => setUp({ storage: memoryStorage({ [OPEN_KEY]: 'true' }) });

    it('lists Session, Sessions, Usage and Todos with Session selected', async () => {
      await openPanel();

      const tabs = within(screen.getByRole('tablist', { name: 'Right panel' })).getAllByRole('tab');
      expect(tabs.map((tab) => tab.getAttribute('data-testid'))).toEqual(['right-panel-tab-session', 'right-panel-tab-sessions', 'right-panel-tab-usage', 'right-panel-tab-todos']);
      expect(tabs.map((tab) => tab.getAttribute('aria-selected'))).toEqual(['true', 'false', 'false', 'false']);
    });

    it('selects the Session tab by default while a session is watched', async () => {
      await setUp({ url: '/session/s1', storage: memoryStorage({ [OPEN_KEY]: 'true' }) });

      expect(screen.getByTestId('right-panel-tab-session').getAttribute('aria-selected')).toBe('true');
      expect(screen.getByRole('tabpanel', { name: /Session/ })).not.toBeNull();
      expect(screen.getByTestId('session-tab')).not.toBeNull();
    });

    it('keeps the tab the user picked when the route moves to another session', async () => {
      const { harness } = await setUp({ url: '/session/s1', storage: memoryStorage({ [OPEN_KEY]: 'true' }) });
      await userEvent.click(screen.getByTestId('right-panel-tab-todos'));

      await harness.navigateByUrl('/session/s2');

      expect(screen.getByTestId('right-panel-tab-todos').getAttribute('aria-selected')).toBe('true');
    });

    it('announces Sessions and Usage as disabled with the visible label "Coming soon"', async () => {
      await openPanel();

      for (const name of ['sessions', 'usage']) {
        const tab = screen.getByTestId(`right-panel-tab-${name}`);
        expect(tab.getAttribute('aria-disabled')).toBe('true');
        expect(tab.textContent).toContain('Coming soon');
        expect(tab.getAttribute('title')).toBe('Coming soon');
      }
      expect(screen.getByTestId('right-panel-tab-session').getAttribute('aria-disabled')).toBeNull();
      expect(screen.getByTestId('right-panel-tab-todos').getAttribute('aria-disabled')).toBeNull();
    });

    it('does not activate a disabled tab', async () => {
      await openPanel();

      await userEvent.click(screen.getByTestId('right-panel-tab-usage'));

      expect(screen.getByTestId('right-panel-tab-usage').getAttribute('aria-selected')).toBe('false');
      expect(screen.getByTestId('right-panel-tab-session').getAttribute('aria-selected')).toBe('true');
      expect(screen.getByRole('tabpanel')).not.toBeNull();
    });

    it('moves focus across the four tabs with arrows, Home and End', async () => {
      await openPanel();
      screen.getByTestId('right-panel-tab-todos').focus();

      await userEvent.keyboard('{ArrowLeft}');
      expect(document.activeElement).toBe(screen.getByTestId('right-panel-tab-usage'));
      await userEvent.keyboard('{Home}');
      expect(document.activeElement).toBe(screen.getByTestId('right-panel-tab-session'));
      await userEvent.keyboard('{End}');
      expect(document.activeElement).toBe(screen.getByTestId('right-panel-tab-todos'));
      await userEvent.keyboard('{ArrowRight}');
      expect(document.activeElement).toBe(screen.getByTestId('right-panel-tab-session'));
    });

    it('labels the tabpanel by the selected tab', async () => {
      await openPanel();
      await userEvent.click(screen.getByTestId('right-panel-tab-todos'));

      expect(screen.getByRole('tabpanel', { name: /Todos/ })).not.toBeNull();
    });
  });

  describe('watched session', () => {
    const showTodosTab = () => userEvent.click(screen.getByTestId('right-panel-tab-todos'));

    it('shows the todos of the session in the route', async () => {
      const storage = memoryStorage({ [OPEN_KEY]: 'true' });
      const { source } = await setUp({ url: '/session/s1', storage });
      await showTodosTab();
      source.publish('s1', { kind: 'ready', todos: todosOf('s1') });

      expect(await screen.findAllByTestId('todo-item')).toHaveLength(2);
    });

    it('asks to select a session in the Session tab when the route shows an unknown session', async () => {
      await setUp({ url: '/session/ghost', storage: memoryStorage({ [OPEN_KEY]: 'true' }) });

      expect(screen.getByTestId('session-tab-no-session')).not.toBeNull();
    });

    it('follows the route to another session', async () => {
      const storage = memoryStorage({ [OPEN_KEY]: 'true' });
      const { source, harness } = await setUp({ url: '/session/s1', storage });
      await showTodosTab();
      source.publish('s1', { kind: 'ready', todos: todosOf('s1') });
      await harness.navigateByUrl('/session/s2');

      expect(screen.queryAllByTestId('todo-item')).toHaveLength(0);
      expect(screen.getByTestId('todos-empty')).not.toBeNull();
    });

    it('marks the list read-only when the watched session is closed', async () => {
      const storage = memoryStorage({ [OPEN_KEY]: 'true' });
      const { source } = await setUp({ url: '/session/s1', storage, sessions: [{ id: 's1', state: 'closed' }] });
      await showTodosTab();
      source.publish('s1', { kind: 'ready', todos: todosOf('s1') });

      expect((await screen.findByTestId('todos-closed-note')).textContent).toMatch(/Session closed — list as of \d{2}:\d{2}\./);
    });

    it('marks the list stale when the socket is down', async () => {
      const storage = memoryStorage({ [OPEN_KEY]: 'true' });
      const { source } = await setUp({ url: '/session/s1', storage, connected: false });
      await showTodosTab();
      source.publish('s1', { kind: 'ready', todos: todosOf('s1') });

      expect((await screen.findByTestId('todos-stale-note')).textContent).toContain('reconnecting to the daemon');
    });
  });
});
