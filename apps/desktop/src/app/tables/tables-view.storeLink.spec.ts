import { render, screen } from '@testing-library/angular/zoneless';
import { inputBinding } from '@angular/core';
import type { DataStore } from '@openfleet/shared';
import { describe, expect, it, vi } from 'vitest';
import { FleetApiService } from '../core/fleet-api.service';
import { TablesViewComponent } from './tables-view.component';

const NOW = '2026-09-29T10:00:00.000Z';
const store = (id: string, displayName: string): DataStore => ({ id, projectId: 'p1', displayName, createdAt: NOW, updatedAt: NOW });
const page = <T>(items: T[]) => ({ items, total: items.length, limit: 100, offset: 0 });

function fakeApiWithTwoEmptyTables() {
  const stores = [store('s1', 'backlog'), store('s2', 'releases')];
  return {
    listProjects: vi.fn().mockResolvedValue(page([{ id: 'p1', name: 'openfleet', docsFolderPath: null }])),
    listDataStores: vi.fn().mockResolvedValue(page(stores)),
    getDataStore: vi.fn().mockImplementation(({ storeId }: { storeId: string }) => Promise.resolve({ ...stores.find((candidate) => candidate.id === storeId), columns: [] })),
    queryDataStore: vi.fn().mockResolvedValue(page([])),
    listViews: vi.fn().mockResolvedValue({ items: [] }),
  };
}

const renderViewLinkedTo = (storeId: string | undefined) =>
  render(TablesViewComponent, {
    providers: [{ provide: FleetApiService, useValue: fakeApiWithTwoEmptyTables() }],
    bindings: [inputBinding('projectId', () => 'p1'), inputBinding('storeId', () => storeId)],
  });

describe('TablesViewComponent opened on a linked table', () => {
  it('opens the linked table instead of the first one', async () => {
    await renderViewLinkedTo('s2');

    expect(await screen.findByText('“releases” has no rows')).toBeVisible();
  });

  it('opens the first table when the link names no table of the project', async () => {
    await renderViewLinkedTo('s-from-another-project');

    expect(await screen.findByText('“backlog” has no rows')).toBeVisible();
  });

  it('opens the first table when no table is linked', async () => {
    await renderViewLinkedTo(undefined);

    expect(await screen.findByText('“backlog” has no rows')).toBeVisible();
  });
});
