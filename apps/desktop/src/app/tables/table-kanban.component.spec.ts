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
  it('renders selected details of every base type in configured order and ignores stale references', async () => {
    const detailColumns: DsColumn[] = [
      { id: 'number', storeId: 's1', displayName: 'Number', columnType: 'number', options: null, sortOrder: 2 },
      { id: 'date', storeId: 's1', displayName: 'Date', columnType: 'date', options: null, sortOrder: 3 },
      { id: 'select', storeId: 's1', displayName: 'Select', columnType: 'select', options: [option('value', 'Selected label')], sortOrder: 4 },
      { id: 'json', storeId: 's1', displayName: 'Json', columnType: 'json', options: null, sortOrder: 5 },
    ];
    const configuredRow = { ...row('all-types', 'Visible title', 'Hidden owner'), data: {
      'c-title': 'Visible title', 'c-owner': 'Hidden owner', number: 23, date: '2026-10-06', select: 'value', json: { count: 7 },
    } };
    await render(TableKanbanComponent, { bindings: [
      inputBinding('columns', () => [...columns, ...detailColumns]),
      inputBinding('groups', () => [{ option: option('todo', 'todo'), rows: [configuredRow] }]),
      inputBinding('config', () => ({ cardFields: ['json', 'missing', 'select', 'date', 'number'] })),
    ] });
    const card = screen.getByTestId('kanban-card-all-types');
    expect(card).toHaveTextContent('Visible title{"count":7}Selected label2026-10-0623');
    expect(card).not.toHaveTextContent('Hidden owner');
  });

  it.each(['{Enter}', ' '])('opens a configured card from the keyboard with %s', async (key) => {
    const rowSelected = vi.fn();
    await render(TableKanbanComponent, { bindings: [...bindings([outputBinding('rowSelected', rowSelected)]), inputBinding('config', () => ({ cardFields: [] }))] });
    screen.getByTestId('kanban-card-r1').focus();
    await userEvent.keyboard(key);
    expect(rowSelected).toHaveBeenCalledExactlyOnceWith('r1');
  });
  it('shows an explicit numeric title and only selected fields in their configured order', async () => {
    const numericColumn: DsColumn = { id: 'rank', storeId: 's1', displayName: 'Rank', columnType: 'number', options: null, sortOrder: 2 };
    const configuredRow = { ...row('configured', 'Hidden title', 'Owner'), data: { 'c-title': 'Hidden title', 'c-owner': 'Owner', rank: 42 } };
    await render(TableKanbanComponent, { bindings: [
      inputBinding('columns', () => [...columns, numericColumn]),
      inputBinding('groups', () => [{ option: option('todo', 'todo'), rows: [configuredRow] }]),
      inputBinding('config', () => ({ cardTitleColumnId: 'rank', cardFields: ['c-owner', 'rank'] })),
    ] });
    const card = screen.getByTestId('kanban-card-configured');
    expect(card).toHaveTextContent('42Owner');
    expect(card).not.toHaveTextContent('Hidden title');
    expect(card.textContent?.match(/42/g)).toHaveLength(1);
  });

  it('an explicit empty field list hides legacy details', async () => {
    await render(TableKanbanComponent, { bindings: [...bindings(), inputBinding('config', () => ({ cardFields: [] }))] });
    expect(screen.getByTestId('kanban-card-r3')).toHaveTextContent('Desktop reconnect');
    expect(screen.getByTestId('kanban-card-r3')).not.toHaveTextContent('Gimli');
  });
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
