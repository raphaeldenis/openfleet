import { render, screen, within } from '@testing-library/angular/zoneless';
import userEvent from '@testing-library/user-event';
import { inputBinding, outputBinding } from '@angular/core';
import type { DsColumn, DsRow } from '@openfleet/shared';
import { describe, expect, it, vi } from 'vitest';
import { TableGridComponent } from './table-grid.component';

const column = (overrides: Partial<DsColumn> & Pick<DsColumn, 'id' | 'displayName' | 'columnType'>): DsColumn => ({
  storeId: 's1',
  options: null,
  sortOrder: 0,
  ...overrides,
});

const row = (id: string, data: Record<string, unknown>): DsRow => ({
  id,
  storeId: 's1',
  data,
  createdAt: '2026-09-29T10:00:00.000Z',
  updatedAt: '2026-09-29T10:00:00.000Z',
});

const columns = [
  column({ id: 'c-status', displayName: 'Status', columnType: 'select', sortOrder: 1, options: [{ id: 'doing', label: 'in progress' }] }),
  column({ id: 'c-title', displayName: 'Title', columnType: 'text', sortOrder: 0 }),
  column({ id: 'c-meta', displayName: 'Meta', columnType: 'json', sortOrder: 2 }),
];

const rows = [
  row('r1', { 'c-title': 'Desktop reconnect', 'c-status': 'doing', 'c-meta': { pr: 214 } }),
  row('r2', { 'c-title': 'Usage budgets', 'c-status': 'unknown-option' }),
];

const bindings = (extra: ReturnType<typeof outputBinding>[] = []) => [
  inputBinding('columns', () => columns),
  inputBinding('rows', () => rows),
  ...extra,
];

describe('TableGridComponent', () => {
  it('user sees one header per column, in column order', async () => {
    await render(TableGridComponent, { bindings: bindings() });

    const headers = screen.getAllByTestId(/^grid-header-/).map((header) => header.textContent?.trim());
    expect(headers).toEqual(['Title', 'Status', 'Meta']);
  });

  it('user sees a row per record with its values under the matching columns', async () => {
    await render(TableGridComponent, { bindings: bindings() });

    expect(screen.getByTestId('grid-cell-r1-c-title')).toHaveTextContent('Desktop reconnect');
    expect(screen.getByTestId('grid-cell-r2-c-title')).toHaveTextContent('Usage budgets');
  });

  it('user reads a select value as its option label', async () => {
    await render(TableGridComponent, { bindings: bindings() });

    expect(screen.getByTestId('grid-cell-r1-c-status')).toHaveTextContent('in progress');
  });

  it('user reads a json value as compact JSON', async () => {
    await render(TableGridComponent, { bindings: bindings() });

    expect(screen.getByTestId('grid-cell-r1-c-meta')).toHaveTextContent('{"pr":214}');
  });

  it('user sees a blank cell when the row has no value for that column', async () => {
    await render(TableGridComponent, { bindings: bindings() });

    expect(screen.getByTestId('grid-cell-r2-c-meta')).toHaveTextContent(/^\s*$/);
  });

  it('user can open a row by clicking it', async () => {
    const rowSelected = vi.fn();
    await render(TableGridComponent, { bindings: bindings([outputBinding('rowSelected', rowSelected)]) });

    await userEvent.click(screen.getByTestId('grid-row-r2'));

    expect(rowSelected).toHaveBeenCalledExactlyOnceWith('r2');
  });

  it('user can open a focused row with the keyboard', async () => {
    const rowSelected = vi.fn();
    await render(TableGridComponent, { bindings: bindings([outputBinding('rowSelected', rowSelected)]) });

    screen.getByTestId('grid-row-r1').focus();
    await userEvent.keyboard('{Enter}');

    expect(rowSelected).toHaveBeenCalledExactlyOnceWith('r1');
  });

  it('user of a screen reader navigates a grid whose rows can be selected', async () => {
    await render(TableGridComponent, { bindings: bindings() });

    expect(screen.getByTestId('table-grid')).toHaveAttribute('role', 'grid');
    expect(screen.getByTestId('grid-cell-r1-c-title')).toHaveAttribute('role', 'gridcell');
  });

  it('user can tell which row is open', async () => {
    await render(TableGridComponent, {
      bindings: [...bindings(), inputBinding('selectedRowId', () => 'r1')],
    });

    expect(screen.getByTestId('grid-row-r1')).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByTestId('grid-row-r2')).toHaveAttribute('aria-selected', 'false');
  });

  describe('layout contract with one very long value', () => {
    const longValue = 'x'.repeat(500);
    const rowsWithLongValue = [row('r1', { 'c-title': longValue, 'c-status': 'doing' }), row('r2', { 'c-title': 'Short', 'c-status': 'doing' })];
    const renderWithLongValue = () =>
      render(TableGridComponent, { bindings: [inputBinding('columns', () => columns), inputBinding('rows', () => rowsWithLongValue)] });

    it('user sees the grid wide enough for every column and the # column, so many columns scroll horizontally', async () => {
      await render(TableGridComponent, { bindings: bindings() });

      const grid = screen.getByTestId('table-grid');
      expect(grid.style.getPropertyValue('--grid-min-width')).toBe('27rem');
    });

    it('user sees the grid width grow by 8rem per column on top of the 3rem # column', async () => {
      const twoColumns = columns.slice(0, 2);
      await render(TableGridComponent, { bindings: [inputBinding('columns', () => twoColumns), inputBinding('rows', () => rows)] });

      const grid = screen.getByTestId('table-grid');
      expect(grid.style.getPropertyValue('--grid-min-width')).toBe('19rem');
    });

    it('user sees every cell take an equal share of its row whatever it contains', async () => {
      await renderWithLongValue();

      const cells = [...screen.getAllByTestId(/^grid-cell-/), ...screen.getAllByTestId(/^grid-header-/)];
      for (const cell of cells) {
        const style = getComputedStyle(cell);
        expect([style.flexGrow, style.flexShrink, style.flexBasis]).toEqual(['1', '1', '0%']);
      }
    });

    it('user sees each cell, the long one included, cut with an ellipsis instead of widening its row', async () => {
      await renderWithLongValue();

      const cells = [...screen.getAllByTestId(/^grid-cell-/), ...screen.getAllByTestId(/^grid-header-/)];
      for (const cell of cells) {
        const style = getComputedStyle(cell);
        expect([style.overflow, style.textOverflow, style.whiteSpace, style.minWidth]).toEqual(['hidden', 'ellipsis', 'nowrap', '8rem']);
      }
    });

    it('user can read the full long value from the cell tooltip', async () => {
      await renderWithLongValue();

      expect(screen.getByTestId('grid-cell-r1-c-title')).toHaveAttribute('title', longValue);
    });

    it('user sees the header and every row laid out as the same flex row', async () => {
      await renderWithLongValue();

      const laidOutElements = [screen.getByTestId('grid-head'), screen.getByTestId('grid-row-r1'), screen.getByTestId('grid-row-r2')];
      for (const element of laidOutElements) {
        const style = getComputedStyle(element);
        expect([style.display, style.minWidth]).toEqual(['flex', 'var(--grid-min-width)']);
      }
    });
  });

  describe('keyboard', () => {
    const tabIndexOf = (rowId: string) => screen.getByTestId(`grid-row-${rowId}`).getAttribute('tabindex');

    it('user tabs into the grid on a single row, the others stay out of the tab order', async () => {
      await render(TableGridComponent, { bindings: bindings() });

      expect([tabIndexOf('r1'), tabIndexOf('r2')]).toEqual(['0', '-1']);
    });

    it('user tabs into the open row when one is open', async () => {
      await render(TableGridComponent, { bindings: [...bindings(), inputBinding('selectedRowId', () => 'r2')] });

      expect([tabIndexOf('r1'), tabIndexOf('r2')]).toEqual(['-1', '0']);
    });

    it('user moves between rows with the arrow keys and the tab stop follows', async () => {
      await render(TableGridComponent, { bindings: bindings() });
      screen.getByTestId('grid-row-r1').focus();

      await userEvent.keyboard('{ArrowDown}');

      expect(screen.getByTestId('grid-row-r2')).toHaveFocus();
      expect([tabIndexOf('r1'), tabIndexOf('r2')]).toEqual(['-1', '0']);
      await userEvent.keyboard('{ArrowUp}');
      expect(screen.getByTestId('grid-row-r1')).toHaveFocus();
    });

    it('user can open a focused row with the space bar', async () => {
      const rowSelected = vi.fn();
      await render(TableGridComponent, { bindings: bindings([outputBinding('rowSelected', rowSelected)]) });

      screen.getByTestId('grid-row-r2').focus();
      await userEvent.keyboard(' ');

      expect(rowSelected).toHaveBeenCalledExactlyOnceWith('r2');
    });
  });
});

describe('TableGridComponent design fidelity', () => {
  const statusColumns = [
    column({ id: 'c-title', displayName: 'Title', columnType: 'text', sortOrder: 0 }),
    column({ id: 'c-status', displayName: 'Status', columnType: 'select', sortOrder: 1, options: [{ id: 'doing', label: 'in progress', color: 'var(--s-gen)' }, { id: 'todo', label: 'todo' }] }),
    column({ id: 'c-model', displayName: 'Model', columnType: 'text', sortOrder: 2 }),
  ];
  const statusRows = [
    row('r1', { 'c-title': 'Desktop reconnect', 'c-status': 'doing', 'c-model': 'sonnet' }),
    row('r2', { 'c-title': 'Usage budgets', 'c-status': 'todo', 'c-model': 'haiku' }),
  ];
  const render2 = () => render(TableGridComponent, { bindings: [inputBinding('columns', () => statusColumns), inputBinding('rows', () => statusRows)] });

  it('user sees a select value as a chip with a dot in its option colour and readable text', async () => {
    await render2();

    const chip = screen.getByText('in progress');
    expect(chip).toHaveStyle({ color: 'var(--fg)' });
    expect(within(chip).getByTestId('chip-dot')).toHaveStyle({ background: 'var(--s-gen)' });
  });

  it('user sees a select value without option colour as a neutral chip', async () => {
    await render2();

    const chip = screen.getByText('todo');
    expect(chip).toHaveStyle({ color: 'var(--fg)' });
    expect(within(chip).getByTestId('chip-dot')).toHaveStyle({ background: 'var(--mut)' });
  });

  it('user sees a "#" column numbering the rows', async () => {
    await render2();

    expect(screen.getByRole('columnheader', { name: '#' })).toBeTruthy();
    expect(screen.getByTestId('grid-number-r1')).toHaveTextContent('1');
    expect(screen.getByTestId('grid-number-r2')).toHaveTextContent('2');
  });

  it('user sees model values in monospace', async () => {
    await render2();

    expect(screen.getByText('sonnet')).toHaveStyle({ fontFamily: 'var(--mono)' });
    expect(screen.getByText('Desktop reconnect')).not.toHaveStyle({ fontFamily: 'var(--mono)' });
  });

  it('user sees compact Edit buttons that do not grow the row', async () => {
    const rankColumn = column({ id: 'c-rank', displayName: 'Rank', columnType: 'number', format: 'rank', sortOrder: 3 });
    await render(TableGridComponent, { bindings: [inputBinding('columns', () => [...statusColumns, rankColumn]), inputBinding('rows', () => statusRows)] });

    const [editButton] = screen.getAllByRole('button', { name: /^Edit Rank in row/ });
    expect(editButton).toHaveClass('of-btn', 'of-btn--secondary', 'of-btn--compact');
  });
});
