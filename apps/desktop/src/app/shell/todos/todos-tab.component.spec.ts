import { inputBinding } from '@angular/core';
import { render, screen, within } from '@testing-library/angular/zoneless';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { InMemorySessionTodosSource, SESSION_TODOS_SOURCE } from './session-todos-source';
import type { SessionTodos, TodoItem, TodoStatus } from './todos.adapter';
import { TodosTabComponent } from './todos-tab.component';

const SESSION_ID = 'session-1';

function item(id: string, status: TodoStatus, content = `Task ${id}`, extra: Partial<TodoItem> = {}): TodoItem {
  return { id, content, status, ...extra };
}

function todosOf(items: TodoItem[], extra: Partial<SessionTodos> = {}): SessionTodos {
  const completed = items.filter((i) => i.status === 'completed').length;
  const inProgress = items.filter((i) => i.status === 'in_progress').length;
  return {
    sessionId: SESSION_ID,
    items,
    counts: { total: items.length, completed, inProgress, pending: items.length - completed - inProgress },
    omitted: 0,
    source: 'task_tools',
    updatedAt: '2026-09-30T14:32:00.000Z',
    ...extra,
  };
}

interface Options {
  sessionId?: string | undefined;
  sessionClosed?: boolean;
  connected?: boolean;
  renderCap?: number;
}

async function renderTab(load: Parameters<InMemorySessionTodosSource['publish']>[1] | undefined, options: Options = {}) {
  const source = new InMemorySessionTodosSource();
  if (load) source.publish(SESSION_ID, load);
  const inputs = { sessionId: SESSION_ID, ...options };
  const bindings = Object.entries(inputs).map(([name, value]) => inputBinding(name, () => value));
  const view = await render(TodosTabComponent, { bindings, providers: [{ provide: SESSION_TODOS_SOURCE, useValue: source }] });
  return { source, view };
}

describe('TodosTabComponent', () => {
  describe('states', () => {
    it('asks to select a session when no session is watched', async () => {
      await renderTab(undefined, { sessionId: undefined });

      expect(screen.getByTestId('todos-no-session').textContent).toContain('Select a session to see its todos.');
    });

    it('shows a loading status while the first load is in flight', async () => {
      await renderTab({ kind: 'loading' });

      const loading = screen.getByTestId('todos-loading');
      expect(loading.getAttribute('role')).toBe('status');
      expect(loading.textContent).toContain('Loading todos…');
    });

    it('says the session has not made a list when it has none', async () => {
      await renderTab({ kind: 'ready', todos: null });

      expect(screen.getByTestId('todos-empty').textContent).toContain("No todos yet — this session hasn't made a list.");
    });

    it('says the session has not made a list when the list holds zero tasks', async () => {
      await renderTab({ kind: 'ready', todos: todosOf([]) });

      expect(screen.getByTestId('todos-empty').textContent).toContain("No todos yet — this session hasn't made a list.");
    });

    it('shows the error copy in an alert with a "Try again" action that retries the watched session', async () => {
      const { source } = await renderTab({ kind: 'error', text: "Can't load the todos — try again.", retryable: true });

      const alert = screen.getByTestId('todos-error');
      expect(alert.getAttribute('role')).toBe('alert');
      expect(alert.textContent).toContain("Can't load the todos — try again.");
      await userEvent.click(screen.getByTestId('todos-retry'));

      expect(source.retried).toEqual([SESSION_ID]);
    });

    it('offers no "Try again" when retrying cannot help', async () => {
      await renderTab({ kind: 'error', text: 'That item no longer exists.', retryable: false });

      expect(screen.getByTestId('todos-error').textContent).toContain('That item no longer exists.');
      expect(screen.queryByTestId('todos-retry')).toBeNull();
    });

    it('tells an old daemon does not report todos', async () => {
      await renderTab({ kind: 'unsupported' });

      expect(screen.getByTestId('todos-unsupported').textContent).toContain("This daemon doesn't report todos — update the daemon.");
    });

    it('shows a read-only closed note above the last known list of a closed session', async () => {
      await renderTab({ kind: 'ready', todos: todosOf([item('1', 'completed'), item('2', 'pending')]) }, { sessionClosed: true });

      const note = screen.getByTestId('todos-closed-note');
      expect(note.getAttribute('role')).toBe('status');
      expect(note.textContent).toMatch(/Session closed — list as of \d{2}:\d{2}\./);
      expect(screen.getAllByTestId('todo-item')).toHaveLength(2);
      expect(screen.queryByTestId('todos-retry')).toBeNull();
    });

    it('says the list is not kept for a closed session without a list', async () => {
      await renderTab({ kind: 'ready', todos: null }, { sessionClosed: true });

      expect(screen.getByTestId('todos-empty').textContent).toContain("This list isn't kept once the daemon restarts.");
    });

    it('marks the list stale when the daemon flagged it, and keeps the rows', async () => {
      await renderTab({ kind: 'ready', todos: todosOf([item('1', 'pending')], { stale: true }) });

      expect(screen.getByTestId('todos-stale-note').textContent).toContain("Last known list — the session's transcript can't be read right now.");
      expect(screen.getAllByTestId('todo-item')).toHaveLength(1);
    });

    it('marks the list stale while the socket is down', async () => {
      await renderTab({ kind: 'ready', todos: todosOf([item('1', 'pending')]) }, { connected: false });

      expect(screen.getByTestId('todos-stale-note').textContent).toContain('Last known list — reconnecting to the daemon.');
    });

    it('shows no stale note on a fresh list of a connected daemon', async () => {
      await renderTab({ kind: 'ready', todos: todosOf([item('1', 'pending')]) });

      expect(screen.queryByTestId('todos-stale-note')).toBeNull();
    });

    it('notes an incomplete list and reads an unnamed row as "Task #2 — name not seen yet"', async () => {
      const unnamed = item('2', 'in_progress', 'Task #2', { unnamed: true });
      await renderTab({ kind: 'ready', todos: todosOf([item('1', 'completed'), unnamed], { incomplete: true }) });

      expect(screen.getByTestId('todos-incomplete-note').textContent).toContain("Some tasks aren't named yet");
      const unnamedRow = screen.getAllByTestId('todo-item')[1];
      expect(within(unnamedRow).getByTestId('todo-item-text').textContent).toContain('Task #2');
      expect(within(unnamedRow).getByTestId('todo-item-unnamed').textContent).toContain('name not seen yet');
      expect(within(unnamedRow).getByTestId('todo-item-status').textContent).toContain('In progress');
      expect(unnamedRow.getAttribute('aria-label')).toContain('Task #2 — name not seen yet');
    });
  });

  describe('rows rebuilt from history', () => {
    it('says "from history, not confirmed yet" on an unverified row and on that row only', async () => {
      const unverified = item('1', 'pending', 'Write the spec', { unverified: true });
      await renderTab({ kind: 'ready', todos: todosOf([unverified, item('2', 'pending', 'Ship it')]) });

      const [unverifiedRow, confirmedRow] = screen.getAllByTestId('todo-item');
      expect(within(unverifiedRow).getByTestId('todo-item-unverified').textContent).toContain('from history, not confirmed yet');
      expect(unverifiedRow.getAttribute('aria-label')).toContain('from history, not confirmed yet');
      expect(within(confirmedRow).queryByTestId('todo-item-unverified')).toBeNull();
    });

    it('still shows the status word and the counts of an unverified row', async () => {
      const unverified = item('1', 'in_progress', 'Write the spec', { unverified: true });
      await renderTab({ kind: 'ready', todos: todosOf([unverified, item('2', 'completed')]) });

      const row = screen.getAllByTestId('todo-item')[0];
      expect(within(row).getByTestId('todo-item-status').textContent).toContain('In progress');
      expect(screen.getByTestId('todos-progress').textContent).toContain('1 of 2 completed');
    });

    it('shows no calm hint when the whole list is confirmed', async () => {
      await renderTab({ kind: 'ready', todos: todosOf([item('1', 'pending')]) });

      expect(screen.queryByTestId('todo-item-unverified')).toBeNull();
    });
  });

  describe('watching', () => {
    it('asks the source to watch the session it shows', async () => {
      const { source } = await renderTab({ kind: 'loading' });

      expect(source.watched).toEqual([SESSION_ID]);
    });

    it('stops watching when the tab goes away', async () => {
      const { source, view } = await renderTab({ kind: 'loading' });

      view.fixture.destroy();

      expect(source.watched.at(-1)).toBeUndefined();
    });

    it('watches nothing without a session', async () => {
      const { source } = await renderTab(undefined, { sessionId: undefined });

      expect(source.watched.every((id) => id === undefined)).toBe(true);
    });
  });

  describe('progress', () => {
    it('shows "2 of 5 completed" as text and as a progressbar with the same numbers', async () => {
      const items = [item('1', 'completed'), item('2', 'completed'), item('3', 'in_progress'), item('4', 'pending'), item('5', 'pending')];
      await renderTab({ kind: 'ready', todos: todosOf(items) });

      const bar = screen.getByRole('progressbar');
      expect(bar.getAttribute('aria-valuemin')).toBe('0');
      expect(bar.getAttribute('aria-valuemax')).toBe('5');
      expect(bar.getAttribute('aria-valuenow')).toBe('2');
      expect(bar.getAttribute('aria-valuetext')).toBe('2 of 5 completed');
      expect(screen.getByTestId('todos-progress').textContent).toContain('2 of 5 completed');
      expect(screen.getByTestId('todos-progress-detail').textContent).toContain('1 in progress · 2 pending');
    });

    it('computes progress from the true counts when the list is truncated', async () => {
      const shown = Array.from({ length: 3 }, (_, index) => item(String(index), 'pending'));
      const todos = { ...todosOf(shown), counts: { total: 120, completed: 30, inProgress: 0, pending: 90 }, omitted: 117 };
      await renderTab({ kind: 'ready', todos });

      expect(screen.getByRole('progressbar').getAttribute('aria-valuemax')).toBe('120');
      expect(screen.getByTestId('todos-progress').textContent).toContain('30 of 120 completed');
    });
  });

  describe('rows', () => {
    it('shows an icon and a visible status word for every status, in the CLI order', async () => {
      const items = [item('1', 'completed', 'Review PR'), item('2', 'in_progress', 'Update docs'), item('3', 'pending', 'Fix types')];
      await renderTab({ kind: 'ready', todos: todosOf(items) });

      const rows = screen.getAllByTestId('todo-item');
      expect(rows.map((row) => row.getAttribute('data-status'))).toEqual(['completed', 'in_progress', 'pending']);
      expect(rows.map((row) => within(row).getByTestId('todo-item-status').textContent?.trim())).toEqual(['Done', 'In progress', 'Pending']);
      expect(rows.map((row) => within(row).getByTestId('todo-item-text').textContent?.trim())).toEqual(['Review PR', 'Update docs', 'Fix types']);
    });

    it('reads the active form of the in-progress row when the CLI sent one', async () => {
      const items = [item('1', 'in_progress', 'Update docs', { activeForm: 'Updating docs' }), item('2', 'pending', 'Fix types', { activeForm: 'Fixing types' })];
      await renderTab({ kind: 'ready', todos: todosOf(items) });

      const texts = screen.getAllByTestId('todo-item-text').map((el) => el.textContent?.trim());
      expect(texts).toEqual(['Updating docs', 'Fix types']);
    });

    it('keeps a long unbroken text in the row with the full text in the title and in the accessible name', async () => {
      const longText = 'x'.repeat(200);
      await renderTab({ kind: 'ready', todos: todosOf([item('1', 'pending', longText)]) });

      const text = screen.getByTestId('todo-item-text');
      expect(text.getAttribute('title')).toBe(longText);
      expect(screen.getByTestId('todo-item').getAttribute('aria-label')).toContain(longText);
    });

    it('shows invisible bidi controls in a todo text as escapes', async () => {
      await renderTab({ kind: 'ready', todos: todosOf([item('1', 'pending', 'pay‮gnp.exe')]) });

      expect(screen.getByTestId('todo-item-text').textContent).toContain('<U+202E>');
    });

    it('renders text as plain text, never as markup', async () => {
      await renderTab({ kind: 'ready', todos: todosOf([item('1', 'pending', '<b>bold</b> [link](http://x.test)')]) });

      const text = screen.getByTestId('todo-item-text');
      expect(text.textContent).toContain('<b>bold</b> [link](http://x.test)');
      expect(text.querySelector('b, a')).toBeNull();
    });

    it('offers the list as a focusable labelled region for keyboard scrolling', async () => {
      await renderTab({ kind: 'ready', todos: todosOf([item('1', 'pending')]) });

      const region = screen.getByRole('region', { name: 'Todo list' });
      expect(region.getAttribute('tabindex')).toBe('0');
    });
  });

  describe('volume', () => {
    it('renders 150 items capped at the render budget and says how many are not shown', async () => {
      const items = Array.from({ length: 150 }, (_, index) => item(String(index), 'pending'));
      const startedAt = performance.now();
      await renderTab({ kind: 'ready', todos: todosOf(items) }, { renderCap: 100 });
      const elapsedMs = performance.now() - startedAt;

      expect(screen.getAllByTestId('todo-item')).toHaveLength(100);
      expect(screen.getByTestId('todos-omitted').textContent).toContain('50 more todos not shown');
      expect(elapsedMs).toBeLessThan(2000);
    });

    it('adds the daemon-omitted count to the not-shown line', async () => {
      const items = Array.from({ length: 100 }, (_, index) => item(String(index), 'pending'));
      await renderTab({ kind: 'ready', todos: todosOf(items, { omitted: 20 }) });

      expect(screen.getAllByTestId('todo-item')).toHaveLength(100);
      expect(screen.getByTestId('todos-omitted').textContent).toContain('20 more todos not shown');
    });

    it('says "1 more todo not shown" in the singular', async () => {
      const items = Array.from({ length: 3 }, (_, index) => item(String(index), 'pending'));
      await renderTab({ kind: 'ready', todos: todosOf(items) }, { renderCap: 2 });

      expect(screen.getByTestId('todos-omitted').textContent).toContain('1 more todo not shown');
    });
  });
});
