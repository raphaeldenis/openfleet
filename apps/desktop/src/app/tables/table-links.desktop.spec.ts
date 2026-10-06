import { inputBinding, outputBinding } from '@angular/core';
import { render, screen } from '@testing-library/angular/zoneless';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { TableGridComponent } from './table-grid.component';
import { TableKanbanComponent } from './table-kanban.component';

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@tauri-apps/api/core', () => ({ invoke }));
afterEach(() => {
  vi.unstubAllGlobals();
  invoke.mockClear();
});

it.each(['grid', 'kanban'] as const)('opens %s links through the native boundary by click and Enter', async (layout) => {
  vi.stubGlobal('__TAURI_INTERNALS__', {});
  const selected = vi.fn();
  const columns = [{ id: 'url', storeId: 'store', displayName: 'Link', columnType: 'text' as const, format: 'url' as const, sortOrder: 0, options: null }];
  const row = { id: 'row', storeId: 'store', createdAt: 'now', updatedAt: 'now', data: { url: 'https://example.com/task' } };
  const bindings = [inputBinding('columns', () => columns), outputBinding('rowSelected', selected)];
  if (layout === 'grid') await render(TableGridComponent, { bindings: [...bindings, inputBinding('rows', () => [row])] });
  else await render(TableKanbanComponent, { bindings: [...bindings, inputBinding('groups', () => [{ option: { id: 'todo', label: 'Todo' }, rows: [row] }])] });

  const link = screen.getByRole('link', { name: row.data.url });
  await userEvent.click(link);
  await vi.waitFor(() => expect(invoke).toHaveBeenCalledExactlyOnceWith('open_external_url', { url: row.data.url }));
  link.focus();
  await userEvent.keyboard('{Enter}');
  await vi.waitFor(() => expect(invoke).toHaveBeenCalledTimes(2));
  expect(selected).not.toHaveBeenCalled();
});
