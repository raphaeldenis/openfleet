import { render, screen } from '@testing-library/angular/zoneless';
import userEvent from '@testing-library/user-event';
import { inputBinding, outputBinding } from '@angular/core';
import type { DsColumn, DsRow, SelectOption } from '@openfleet/shared';
import { describe, expect, it, vi } from 'vitest';
import { TableKanbanComponent } from './table-kanban.component';

const columns: DsColumn[] = [
  { id: 'c-title', storeId: 's1', displayName: 'Title', columnType: 'text', options: null, sortOrder: 0 },
  { id: 'c-owner', storeId: 's1', displayName: 'Owner', columnType: 'text', options: null, sortOrder: 1 },
];

const row = (id: string, title: string, owner?: string): DsRow => ({
  id,
  storeId: 's1',
  data: { 'c-title': title, ...(owner ? { 'c-owner': owner } : {}) },
  createdAt: '2026-09-29T10:00:00.000Z',
  updatedAt: '2026-09-29T10:00:00.000Z',
});

const option = (id: string, label: string): SelectOption => ({ id, label });

const groups = [
  { option: option('todo', 'todo'), rows: [row('r1', 'Usage budgets'), row('r2', 'Token-expired flow')] },
  { option: option('doing', 'in progress'), rows: [row('r3', 'Desktop reconnect', 'Gimli')] },
  { option: option('done', 'done'), rows: [] },
];

const bindings = (extra: ReturnType<typeof outputBinding>[] = []) => [
  inputBinding('columns', () => columns),
  inputBinding('groups', () => groups),
  ...extra,
];

describe('TableKanbanComponent', () => {
  it('user sees one column per option, titled with the option label and its card count', async () => {
    await render(TableKanbanComponent, { bindings: bindings() });

    expect(screen.getByTestId('kanban-column-todo')).toHaveTextContent('todo');
    expect(screen.getByTestId('kanban-count-todo')).toHaveTextContent('2');
    expect(screen.getByTestId('kanban-column-doing')).toHaveTextContent('in progress');
    expect(screen.getByTestId('kanban-count-doing')).toHaveTextContent('1');
  });

  it('user still sees the column of an empty bucket, with a count of 0', async () => {
    await render(TableKanbanComponent, { bindings: bindings() });

    expect(screen.getByTestId('kanban-column-done')).toHaveTextContent('done');
    expect(screen.getByTestId('kanban-count-done')).toHaveTextContent('0');
    expect(screen.queryAllByTestId(/^kanban-card-/)).toHaveLength(3);
  });

  it('user sees a card with its title, id and owner', async () => {
    await render(TableKanbanComponent, { bindings: bindings() });

    const card = screen.getByTestId('kanban-card-r3');
    expect(card).toHaveTextContent('Desktop reconnect');
    expect(card).toHaveTextContent('r3');
    expect(card).toHaveTextContent('Gimli');
  });

  it('user can open a row by clicking its card', async () => {
    const rowSelected = vi.fn();
    await render(TableKanbanComponent, { bindings: bindings([outputBinding('rowSelected', rowSelected)]) });

    await userEvent.click(screen.getByTestId('kanban-card-r1'));

    expect(rowSelected).toHaveBeenCalledExactlyOnceWith('r1');
  });

  it('user can tell which card is open', async () => {
    await render(TableKanbanComponent, {
      bindings: [...bindings(), inputBinding('selectedRowId', () => 'r3')],
    });

    expect(screen.getByTestId('kanban-card-r3')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('kanban-card-r1')).toHaveAttribute('aria-pressed', 'false');
  });
});
