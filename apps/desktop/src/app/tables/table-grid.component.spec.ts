import { render, screen } from '@testing-library/angular/zoneless';
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
