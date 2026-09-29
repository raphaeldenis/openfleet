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
  it('user sees one column per option, titled with the option label and its card count, an empty one included', async () => {
    await render(TableKanbanComponent, { bindings: bindings() });

    expect(screen.getByTestId('kanban-column-todo')).toHaveTextContent('todo');
    expect(screen.getByTestId('kanban-count-todo')).toHaveTextContent('2');
    expect(screen.getByTestId('kanban-column-doing')).toHaveTextContent('in progress');
    expect(screen.getByTestId('kanban-count-doing')).toHaveTextContent('1');
    expect(screen.getByTestId('kanban-column-done')).toHaveTextContent('done');
    expect(screen.getByTestId('kanban-count-done')).toHaveTextContent('0');
    expect(screen.queryAllByTestId(/^kanban-card-/)).toHaveLength(3);
  });

  it('user sees a card with its title and owner, without the row id', async () => {
    await render(TableKanbanComponent, { bindings: bindings() });

    const card = screen.getByTestId('kanban-card-r3');
    expect(card).toHaveTextContent('Desktop reconnect');
    expect(card).toHaveTextContent('Gimli');
    expect(card).not.toHaveTextContent('r3');
  });

  it('user sees an "Untitled" placeholder on the card of a row without a title', async () => {
    const untitledGroups = [{ option: option('todo', 'todo'), rows: [row('r7', '')] }];
    await render(TableKanbanComponent, { bindings: [inputBinding('columns', () => columns), inputBinding('groups', () => untitledGroups)] });

    expect(screen.getByTestId('kanban-card-r7')).toHaveTextContent('Untitled');
  });

  describe('layout contract with a very long value', () => {
    const longValue = 'y'.repeat(500);
    const longGroups = [{ option: option('todo', 'todo'), rows: [row('r9', 'Title', longValue)] }];
    const renderLongCard = () =>
      render(TableKanbanComponent, { bindings: [inputBinding('columns', () => columns), inputBinding('groups', () => longGroups)] });

    it('user sees the details of a card clamped to a few lines that wrap anywhere', async () => {
      await renderLongCard();

      const style = getComputedStyle(screen.getByTestId('kanban-details-r9'));
      expect([style.overflow, style.overflowWrap, style.webkitLineClamp]).toEqual(['hidden', 'anywhere', '3']);
    });

    it('user can read the full details of a card from its tooltip', async () => {
      await renderLongCard();

      expect(screen.getByTestId('kanban-details-r9')).toHaveAttribute('title', longValue);
    });

    it('user sees a bounded card that keeps its content on one column', async () => {
      await renderLongCard();

      const style = getComputedStyle(screen.getByTestId('kanban-card-r9'));
      expect([style.maxHeight, style.overflow, style.minWidth]).toEqual(['12rem', 'hidden', '0px']);
    });
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
