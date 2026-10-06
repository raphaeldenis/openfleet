import { inputBinding, outputBinding } from '@angular/core';
import { render, screen } from '@testing-library/angular/zoneless';
import userEvent from '@testing-library/user-event';
import type { DsColumn, DsRow } from '@openfleet/shared';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { TableGridComponent } from './table-grid.component';
import { TableKanbanComponent } from './table-kanban.component';
import { RowHistoryComponent } from './row-history.component';

const columns: DsColumn[] = [
  { id: 'title', storeId: 'store', displayName: 'Title', columnType: 'text', sortOrder: 0, options: null },
  { id: 'when', storeId: 'store', displayName: 'When', columnType: 'date', format: 'datetime', sortOrder: 1, options: null },
  { id: 'details', storeId: 'store', displayName: 'Details', columnType: 'text', format: 'longText', sortOrder: 2, options: null },
  { id: 'url', storeId: 'store', displayName: 'Link', columnType: 'text', format: 'url', sortOrder: 3, options: null },
  { id: 'rank', storeId: 'store', displayName: 'Rank', columnType: 'number', format: 'rank', sortOrder: 4, options: null },
];
const row: DsRow = {
  id: 'row', storeId: 'store', createdAt: 'now', updatedAt: 'now',
  data: { title: 'Task', when: '2026-10-06T08:09:10Z', details: 'First line\nSecond line <script>', url: 'https://example.com/task', rank: 2 },
};
const DateTimeFormat = Intl.DateTimeFormat;
beforeEach(() => {
  vi.spyOn(Intl, 'DateTimeFormat').mockImplementation(function (_locale, options) {
    return new DateTimeFormat('en-GB', { timeZone: 'Europe/Paris', ...options });
  });
});
afterEach(() => vi.restoreAllMocks());
const localDate = () => '6 Oct 2026, 10:09:10 CEST';

it.each(['2026-10-06T08:09:10Z', '2026-10-06T03:09:10-05:00'])('shows Paris date, time and seconds for %s', async (when) => {
  await render(TableGridComponent, { bindings: [inputBinding('columns', () => columns), inputBinding('rows', () => [{ ...row, data: { ...row.data, when } }])] });
  const dateCell = screen.getByTestId('grid-cell-row-when');
  expect(dateCell).toHaveTextContent('6 Oct 2026');
  expect(dateCell).toHaveTextContent('10:09:10');
  expect(dateCell).toHaveTextContent('CEST');
});

it('shows local datetime, full multiline text and a plain numeric rank in the grid', async () => {
  await render(TableGridComponent, { bindings: [inputBinding('columns', () => columns), inputBinding('rows', () => [row])] });

  expect(screen.getByTestId('grid-cell-row-when')).toHaveTextContent(localDate());
  expect(screen.getByTestId('grid-cell-row-details')).toHaveAttribute('title', row.data['details']);
  expect(screen.getByText('First line Second line <script>')).toBeVisible();
  expect(screen.getByTestId('grid-cell-row-rank')).toHaveTextContent('2');
});

it.each(['grid', 'kanban'] as const)('opens web links without selecting their %s row', async (layout) => {
  const selected = vi.fn();
  const bindings = [inputBinding('columns', () => columns), outputBinding('rowSelected', selected)];
  if (layout === 'grid') await render(TableGridComponent, { bindings: [...bindings, inputBinding('rows', () => [row])] });
  else await render(TableKanbanComponent, { bindings: [...bindings, inputBinding('groups', () => [{ option: { id: 'todo', label: 'Todo' }, rows: [row] }])] });

  const link = screen.getByRole('link', { name: String(row.data['url']) });
  expect(link).toHaveAttribute('href', row.data['url']);
  const click = new MouseEvent('click', { bubbles: true, cancelable: true });
  link.dispatchEvent(click);
  expect(click.defaultPrevented).toBe(false);
  await userEvent.click(link);
  link.focus();
  await userEvent.keyboard('{Enter}');
  expect(selected).not.toHaveBeenCalled();
});

it.each(['javascript:alert(1)', 'data:text/html,hello', 'file:///tmp/task', 'not a URL'])('keeps unsafe or invalid URL %s as text', async (url) => {
  await render(TableGridComponent, { bindings: [inputBinding('columns', () => columns), inputBinding('rows', () => [{ ...row, data: { ...row.data, url } }])] });

  expect(screen.queryByRole('link')).toBeNull();
  expect(screen.getByTestId('grid-cell-row-url')).toHaveTextContent(url);
});

it('keeps kanban row selection available with Enter and Space and shows rich details', async () => {
  const selected = vi.fn();
  await render(TableKanbanComponent, { bindings: [
    inputBinding('columns', () => columns),
    inputBinding('groups', () => [{ option: { id: 'todo', label: 'Todo' }, rows: [row] }]),
    outputBinding('rowSelected', selected),
  ] });

  screen.getByRole('button', { name: /Task/ }).focus();
  await userEvent.keyboard('{Enter} ');

  expect(selected).toHaveBeenCalledTimes(2);
  expect(screen.getByText(localDate())).toBeVisible();
  expect(screen.getByText('2')).toBeVisible();
});

it('uses the same local datetime and text values in row history', async () => {
  await render(RowHistoryComponent, { bindings: [
    inputBinding('columns', () => columns),
    inputBinding('entries', () => [{
      id: 'history', rowId: row.id, actorKind: 'human', actorLabel: 'You', createdAt: '2026-10-06T08:00:00Z',
      change: { when: { from: null, to: row.data['when'] }, details: { from: null, to: row.data['details'] } },
    }]),
  ] });

  expect(screen.getByTestId('history-entry-history')).toHaveTextContent(localDate());
  expect(screen.getByText(/First line$/)).toBeVisible();
  expect(screen.getByText('Second line <script>')).toBeVisible();
});
