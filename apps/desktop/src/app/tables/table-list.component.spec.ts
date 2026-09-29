import { render, screen } from '@testing-library/angular/zoneless';
import userEvent from '@testing-library/user-event';
import { inputBinding, outputBinding } from '@angular/core';
import type { DataStore } from '@openfleet/shared';
import { describe, expect, it, vi } from 'vitest';
import { TableListComponent } from './table-list.component';

const store = (id: string, displayName: string): DataStore => ({
  id,
  projectId: 'p1',
  displayName,
  createdAt: '2026-09-29T10:00:00.000Z',
  updatedAt: '2026-09-29T10:00:00.000Z',
});

const stores = [store('s1', 'backlog'), store('s2', 'releases')];

describe('TableListComponent', () => {
  it('user sees one pill per table, named after the table', async () => {
    await render(TableListComponent, { bindings: [inputBinding('stores', () => stores)] });

    expect(screen.getByTestId('table-pill-s1')).toHaveTextContent('backlog');
    expect(screen.getByTestId('table-pill-s2')).toHaveTextContent('releases');
  });

  it('user can pick a table by clicking its pill', async () => {
    const selected = vi.fn();
    await render(TableListComponent, {
      bindings: [inputBinding('stores', () => stores), outputBinding('selected', selected)],
    });

    await userEvent.click(screen.getByTestId('table-pill-s2'));

    expect(selected).toHaveBeenCalledExactlyOnceWith('s2');
  });

  it('user can tell which table is open', async () => {
    await render(TableListComponent, {
      bindings: [inputBinding('stores', () => stores), inputBinding('activeStoreId', () => 's1')],
    });

    expect(screen.getByTestId('table-pill-s1')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('table-pill-s2')).toHaveAttribute('aria-pressed', 'false');
  });

  it('user can ask for a new table with the plus button', async () => {
    const addRequested = vi.fn();
    await render(TableListComponent, {
      bindings: [inputBinding('stores', () => stores), outputBinding('addRequested', addRequested)],
    });

    await userEvent.click(screen.getByTestId('table-add'));

    expect(addRequested).toHaveBeenCalledTimes(1);
  });
});
