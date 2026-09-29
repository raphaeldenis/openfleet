import { render, screen } from '@testing-library/angular/zoneless';
import userEvent from '@testing-library/user-event';
import { inputBinding, signal } from '@angular/core';
import type { DataStore, DsColumn, DsRow, DsRowHistoryEntry } from '@openfleet/shared';
import { describe, expect, it, vi } from 'vitest';
import { ApiError, FleetApiService } from '../core/fleet-api.service';
import { TablesViewComponent } from './tables-view.component';

const NOW = '2026-09-29T10:00:00.000Z';

const store = (id: string, displayName: string): DataStore => ({ id, projectId: 'p1', displayName, createdAt: NOW, updatedAt: NOW });
const page = <T>(items: T[]) => ({ items, total: items.length, limit: 100, offset: 0 });
const row = (id: string, data: Record<string, unknown>): DsRow => ({ id, storeId: 's1', data, createdAt: NOW, updatedAt: NOW });

const columns: DsColumn[] = [
  { id: 'c-title', storeId: 's1', displayName: 'Title', columnType: 'text', options: null, sortOrder: 0 },
  {
    id: 'c-status', storeId: 's1', displayName: 'Status', columnType: 'select', sortOrder: 1,
    options: [{ id: 'todo', label: 'todo' }, { id: 'doing', label: 'in progress' }, { id: 'done', label: 'done' }],
  },
];

const historyEntry = (overrides: Partial<DsRowHistoryEntry> = {}): DsRowHistoryEntry => ({
  id: 'h1', rowId: 'r1', actorKind: 'agent', actorLabel: 'Gimli · T6', createdAt: NOW,
  change: { 'c-status': { from: 'todo', to: 'doing' } },
  ...overrides,
});

interface FakeOptions {
  projects?: { id: string; name: string; docsFolderPath: string | null }[];
  stores?: DataStore[];
  rows?: DsRow[];
  columns?: DsColumn[];
  history?: DsRowHistoryEntry[];
}

function fakeApi(options: FakeOptions = {}) {
  const storeList = options.stores ?? [store('s1', 'backlog'), store('s2', 'releases')];
  return {
    listProjects: vi.fn().mockResolvedValue(page(options.projects ?? [{ id: 'p1', name: 'openfleet', docsFolderPath: null }])),
    listDataStores: vi.fn().mockResolvedValue(page(storeList)),
    createDataStore: vi.fn().mockResolvedValue(store('s3', 'sprint')),
    getDataStore: vi.fn().mockImplementation(({ storeId }: { storeId: string }) =>
      Promise.resolve({ ...(storeList.find((candidate) => candidate.id === storeId) ?? storeList[0]), columns: options.columns ?? columns })),
    queryDataStore: vi.fn().mockResolvedValue(page(options.rows ?? [])),
    insertRows: vi.fn().mockResolvedValue({ items: [] }),
    updateRows: vi.fn().mockResolvedValue({ items: [] }),
    listRowChanges: vi.fn().mockResolvedValue({ items: options.history ?? [historyEntry()], total: 1 }),
    listViews: vi.fn().mockResolvedValue({ items: [] }),
  };
}

const renderView = (api: ReturnType<typeof fakeApi>, extraBindings: ReturnType<typeof inputBinding>[] = []) =>
  render(TablesViewComponent, { providers: [{ provide: FleetApiService, useValue: api }], bindings: extraBindings });

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => { resolve = onResolve; reject = onReject; });
  return { promise, resolve, reject };
};
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const projectsNamed = (...ids: string[]) => ids.map((id) => ({ id, name: `project ${id}`, docsFolderPath: null }));

const twoRows = [row('r1', { 'c-title': 'Desktop reconnect', 'c-status': 'doing' }), row('r2', { 'c-title': 'Usage budgets', 'c-status': 'todo' })];

describe('TablesViewComponent', () => {
  describe('project scope', () => {
    it('user sees the tables of the first project by default', async () => {
      const api = fakeApi();

      await renderView(api);

      expect(await screen.findByTestId('table-pill-s1')).toHaveTextContent('backlog');
      expect(api.listDataStores).toHaveBeenCalledWith('p1');
    });

    it('user sees the tables of the project named in the route', async () => {
      const api = fakeApi({ projects: [{ id: 'p1', name: 'openfleet', docsFolderPath: null }, { id: 'p2', name: 'other', docsFolderPath: null }] });

      await renderView(api, [inputBinding('projectId', () => 'p2')]);

      await screen.findByTestId('table-pill-s1');
      expect(api.listDataStores).toHaveBeenCalledWith('p2');
    });

    it('user can switch project from the scope selector', async () => {
      const api = fakeApi({ projects: [{ id: 'p1', name: 'openfleet', docsFolderPath: null }, { id: 'p2', name: 'other', docsFolderPath: null }] });
      await renderView(api);
      await screen.findByTestId('table-pill-s1');

      await userEvent.selectOptions(screen.getByTestId('tables-project-scope'), 'p2');

      await vi.waitFor(() => expect(api.listDataStores).toHaveBeenLastCalledWith('p2'));
    });

    it('user is told there is no project yet when the daemon has none', async () => {
      const api = fakeApi({ projects: [] });

      await renderView(api);

      expect(await screen.findByTestId('tables-no-project')).toBeTruthy();
      expect(api.listDataStores).not.toHaveBeenCalled();
    });
  });

  describe('loading correctness', () => {
    it('user switching project never sees the slow tables of the previous project nor queries them in the new one', async () => {
      const api = fakeApi({ projects: projectsNamed('p1', 'p2') });
      const slowFirstProject = deferred<ReturnType<typeof page<DataStore>>>();
      api.listDataStores.mockImplementation((projectId: string) =>
        projectId === 'p1' ? slowFirstProject.promise : Promise.resolve(page([store('s9', 'other-table')])));
      await renderView(api);
      await userEvent.selectOptions(await screen.findByTestId('tables-project-scope'), 'p2');
      await screen.findByTestId('table-pill-s9');

      slowFirstProject.resolve(page([store('s1', 'backlog')]));
      await settle();

      expect(screen.queryByTestId('table-pill-s1')).toBeNull();
      expect(api.queryDataStore).not.toHaveBeenCalledWith(expect.objectContaining({ projectId: 'p2', storeId: 's1' }));
    });

    it('user sees the error card, not "No project yet", when the projects fail to load, and Retry reloads the projects', async () => {
      const api = fakeApi();
      api.listProjects.mockRejectedValueOnce(new ApiError(502, 'GET /api/projects → 502'));
      await renderView(api);

      expect(await screen.findByTestId('tables-load-error')).toBeTruthy();
      expect(screen.queryByTestId('tables-no-project')).toBeNull();
      await userEvent.click(screen.getByTestId('tables-retry'));

      expect(await screen.findByTestId('table-pill-s1')).toBeTruthy();
      expect(screen.queryByTestId('tables-load-error')).toBeNull();
    });

    it('user can retry after the table list fails to load', async () => {
      const api = fakeApi({ rows: twoRows });
      api.listDataStores.mockRejectedValueOnce(new ApiError(500, 'GET stores → 500'));
      await renderView(api);
      const card = await screen.findByTestId('tables-load-error');
      expect(card).toHaveTextContent('Could not load the tables');
      expect(card).not.toHaveTextContent('“”');

      await userEvent.click(screen.getByTestId('tables-retry'));

      expect(await screen.findByTestId('table-grid')).toBeTruthy();
      expect(api.listDataStores).toHaveBeenCalledTimes(2);
    });

    it.each([
      { failure: new ApiError(404, 'GET → 404'), expected: 'no longer exists' },
      { failure: new ApiError(500, 'GET → 500'), expected: 'hit an error' },
      { failure: new TypeError('Failed to fetch'), expected: 'did not answer' },
    ])('user reads an accurate reason when the rows fail with $failure', async ({ failure, expected }) => {
      const api = fakeApi();
      api.queryDataStore.mockRejectedValue(failure);

      await renderView(api);

      expect(await screen.findByTestId('tables-load-error')).toHaveTextContent(expected);
    });

    it('user sees no tables yet, and no rows are requested, when the project has none', async () => {
      const api = fakeApi({ stores: [] });

      await renderView(api);

      expect(await screen.findByTestId('tables-no-tables')).toBeTruthy();
      expect(api.queryDataStore).not.toHaveBeenCalled();
    });

    it('user asks for a full page of rows', async () => {
      const api = fakeApi({ rows: twoRows });

      await renderView(api);
      await screen.findByTestId('table-grid');

      expect(api.queryDataStore).toHaveBeenCalledWith(expect.objectContaining({ storeId: 's1', limit: 1000 }));
    });

    it('user follows a changed route project even after picking another project by hand', async () => {
      const api = fakeApi({ projects: projectsNamed('p1', 'p2', 'p3') });
      const routeProject = signal<string | undefined>('p2');
      const { fixture } = await renderView(api, [inputBinding('projectId', routeProject)]);
      await userEvent.selectOptions(await screen.findByTestId('tables-project-scope'), 'p1');
      await vi.waitFor(() => expect(api.listDataStores).toHaveBeenLastCalledWith('p1'));

      routeProject.set('p3');
      fixture.detectChanges();

      await vi.waitFor(() => expect(api.listDataStores).toHaveBeenLastCalledWith('p3'));
    });

    it('user sees the rows of the table they clicked last, not of a slower earlier one', async () => {
      const api = fakeApi();
      const slowBacklog = deferred<ReturnType<typeof page<DsRow>>>();
      api.queryDataStore.mockImplementation(({ storeId }: { storeId: string }) =>
        storeId === 's1' ? slowBacklog.promise : Promise.resolve(page([row('r9', { 'c-title': 'From releases' })])));
      await renderView(api);
      await userEvent.click(await screen.findByTestId('table-pill-s2'));
      await screen.findByTestId('grid-cell-r9-c-title');

      slowBacklog.resolve(page([row('r1', { 'c-title': 'From backlog' })]));
      await settle();

      expect(screen.getByTestId('grid-cell-r9-c-title')).toBeTruthy();
      expect(screen.queryByTestId('grid-cell-r1-c-title')).toBeNull();
    });

    it('user sees the history of the row they clicked last, not of a slower earlier one', async () => {
      const api = fakeApi({ rows: twoRows });
      const slowFirstRow = deferred<{ items: DsRowHistoryEntry[]; total: number }>();
      api.listRowChanges.mockImplementation(({ rowId }: { rowId: string }) =>
        rowId === 'r1' ? slowFirstRow.promise : Promise.resolve({ items: [historyEntry({ id: 'h2', rowId: 'r2' })], total: 1 }));
      await renderView(api);
      await screen.findByTestId('table-grid');
      await userEvent.click(screen.getByTestId('grid-row-r1'));
      await userEvent.click(screen.getByTestId('grid-row-r2'));
      await screen.findByTestId('history-entry-h2');

      slowFirstRow.resolve({ items: [historyEntry({ id: 'h1' })], total: 1 });
      await settle();

      expect(screen.queryByTestId('history-entry-h1')).toBeNull();
    });

    it('user who chose to view mismatched rows is warned again in the next table', async () => {
      const staleRows = [row('r1', { 'c-title': 'Stale', 'c-status': 'archived' })];
      await renderView(fakeApi({ rows: staleRows }));
      await userEvent.click(await screen.findByTestId('tables-view-rows'));
      await screen.findByTestId('table-grid');

      await userEvent.click(screen.getByTestId('table-pill-s2'));

      expect(await screen.findByTestId('tables-schema-mismatch')).toBeTruthy();
    });

    it('user sees the new table among the pills and opens it', async () => {
      const api = fakeApi({ rows: twoRows });
      await renderView(api);
      await screen.findByTestId('table-grid');

      await userEvent.click(screen.getByRole('button', { name: 'New table' }));
      await userEvent.type(screen.getByTestId('tables-new-name'), 'sprint');
      await userEvent.click(screen.getByTestId('tables-create'));

      expect(await screen.findByTestId('table-pill-s3')).toHaveTextContent('sprint');
      await vi.waitFor(() => expect(api.queryDataStore).toHaveBeenLastCalledWith(expect.objectContaining({ storeId: 's3' })));
    });
  });

  describe('states', () => {
    it('user sees skeleton rows while the rows are loading', async () => {
      const api = fakeApi();
      api.queryDataStore.mockReturnValue(new Promise(() => undefined));

      await renderView(api);

      expect(await screen.findByTestId('tables-loading')).toBeTruthy();
      expect(screen.queryByTestId('table-grid')).toBeNull();
    });

    it('user sees the rows in a grid once loaded', async () => {
      await renderView(fakeApi({ rows: twoRows }));

      expect(await screen.findByTestId('grid-cell-r1-c-title')).toHaveTextContent('Desktop reconnect');
      expect(screen.queryByTestId('tables-loading')).toBeNull();
    });

    it('user sees that a table has no rows and can add the first one', async () => {
      const api = fakeApi({ rows: [] });
      await renderView(api);

      expect(await screen.findByTestId('tables-empty')).toHaveTextContent('backlog has no rows');
      await userEvent.click(screen.getByTestId('tables-add-first-row'));

      expect(api.insertRows).toHaveBeenCalledWith({ projectId: 'p1', storeId: 's1', rows: [{}] });
    });

    it('user can add a row from the toolbar', async () => {
      const api = fakeApi({ rows: twoRows });
      await renderView(api);
      await screen.findByTestId('table-grid');

      await userEvent.click(screen.getByTestId('tables-add-row'));

      expect(api.insertRows).toHaveBeenCalledWith({ projectId: 'p1', storeId: 's1', rows: [{}] });
    });

    it('user sees a schema mismatch when a stored value no longer matches its column options', async () => {
      const staleRows = [row('r1', { 'c-title': 'Stale', 'c-status': 'archived' }), row('r2', { 'c-title': 'Fine', 'c-status': 'todo' })];
      await renderView(fakeApi({ rows: staleRows }));

      const error = await screen.findByTestId('tables-schema-mismatch');
      expect(error).toHaveTextContent('Schema mismatch in “backlog”');
      expect(error).toHaveTextContent('Status');
      expect(error).toHaveTextContent('1 row');
      expect(screen.queryByTestId('table-grid')).toBeNull();
    });

    it('user can clear the offending values and get the grid back', async () => {
      const staleRows = [row('r1', { 'c-title': 'Stale', 'c-status': 'archived' })];
      const api = fakeApi({ rows: staleRows });
      await renderView(api);
      await screen.findByTestId('tables-schema-mismatch');
      api.queryDataStore.mockResolvedValue(page([row('r1', { 'c-title': 'Stale', 'c-status': null })]));

      await userEvent.click(screen.getByTestId('tables-clear-mismatches'));

      expect(api.updateRows).toHaveBeenCalledWith({ projectId: 'p1', storeId: 's1', updates: [{ rowId: 'r1', patch: { 'c-status': null } }] });
      expect(await screen.findByTestId('table-grid')).toBeTruthy();
    });

    it('user can view the offending rows without fixing them', async () => {
      const staleRows = [row('r1', { 'c-title': 'Stale', 'c-status': 'archived' })];
      await renderView(fakeApi({ rows: staleRows }));
      await screen.findByTestId('tables-schema-mismatch');

      await userEvent.click(screen.getByTestId('tables-view-rows'));

      expect(await screen.findByTestId('grid-cell-r1-c-status')).toHaveTextContent('archived');
    });

    it('user can retry after the rows fail to load', async () => {
      const api = fakeApi({ rows: twoRows });
      api.queryDataStore.mockRejectedValueOnce(new ApiError(500, 'GET rows → 500'));
      await renderView(api);
      expect(await screen.findByTestId('tables-load-error')).toBeTruthy();

      await userEvent.click(screen.getByTestId('tables-retry'));

      expect(await screen.findByTestId('table-grid')).toBeTruthy();
    });
  });

  describe('tables', () => {
    it('user opens another table by clicking its pill', async () => {
      const api = fakeApi({ rows: twoRows });
      await renderView(api);
      await screen.findByTestId('table-grid');

      await userEvent.click(screen.getByTestId('table-pill-s2'));

      await vi.waitFor(() => expect(api.queryDataStore).toHaveBeenLastCalledWith(expect.objectContaining({ storeId: 's2' })));
    });

    it('user can create a table from the plus button', async () => {
      const api = fakeApi({ rows: twoRows });
      await renderView(api);
      await screen.findByTestId('table-grid');

      await userEvent.click(screen.getByTestId('table-add'));
      await userEvent.type(screen.getByTestId('tables-new-name'), 'sprint');
      await userEvent.click(screen.getByTestId('tables-create'));

      expect(api.createDataStore).toHaveBeenCalledWith({ projectId: 'p1', displayName: 'sprint' });
    });

    it('user is told when a table name is already taken', async () => {
      const api = fakeApi({ rows: twoRows });
      api.createDataStore.mockRejectedValue(new ApiError(409, 'POST → 409', 'duplicate_name'));
      await renderView(api);
      await screen.findByTestId('table-grid');

      await userEvent.click(screen.getByTestId('table-add'));
      await userEvent.type(screen.getByTestId('tables-new-name'), 'backlog');
      await userEvent.click(screen.getByTestId('tables-create'));

      expect(await screen.findByTestId('tables-create-error')).toHaveTextContent('already exists');
    });
  });

  describe('grid and kanban', () => {
    it('user can switch to a kanban with one column per status, an empty one included', async () => {
      await renderView(fakeApi({ rows: twoRows }));
      await screen.findByTestId('table-grid');

      await userEvent.click(screen.getByTestId('tables-toggle-kanban'));

      expect(screen.getByTestId('kanban-count-doing')).toHaveTextContent('1');
      expect(screen.getByTestId('kanban-count-done')).toHaveTextContent('0');
      expect(screen.queryByTestId('table-grid')).toBeNull();
    });

    it('user can switch back to the grid', async () => {
      await renderView(fakeApi({ rows: twoRows }));
      await screen.findByTestId('table-grid');
      await userEvent.click(screen.getByTestId('tables-toggle-kanban'));

      await userEvent.click(screen.getByTestId('tables-toggle-grid'));

      expect(screen.getByTestId('table-grid')).toBeTruthy();
    });

    it('user is told a kanban needs a select column when the table has none', async () => {
      await renderView(fakeApi({ rows: twoRows, columns: [columns[0]] }));
      await screen.findByTestId('table-grid');

      await userEvent.click(screen.getByTestId('tables-toggle-kanban'));

      expect(screen.getByTestId('tables-kanban-needs-select')).toBeTruthy();
    });
  });

  describe('row history', () => {
    it('user opens the history of a row with who changed it and what', async () => {
      const api = fakeApi({ rows: twoRows });
      await renderView(api);
      await screen.findByTestId('table-grid');

      await userEvent.click(screen.getByTestId('grid-row-r1'));

      const entry = await screen.findByTestId('history-entry-h1');
      expect(entry).toHaveTextContent('Gimli · T6');
      expect(entry).toHaveTextContent('AGENT');
      expect(entry).toHaveTextContent('Status todo → in progress');
      expect(api.listRowChanges).toHaveBeenCalledWith(expect.objectContaining({ storeId: 's1', rowId: 'r1' }));
      expect(screen.getByTestId('history-heading')).toHaveTextContent('Desktop reconnect');
    });

    it('user opens the history of a card from the kanban', async () => {
      await renderView(fakeApi({ rows: twoRows }));
      await screen.findByTestId('table-grid');
      await userEvent.click(screen.getByTestId('tables-toggle-kanban'));

      await userEvent.click(screen.getByTestId('kanban-card-r1'));

      expect(await screen.findByTestId('history-entry-h1')).toBeTruthy();
    });

    it('user sees an empty history when the row has no recorded changes', async () => {
      const api = fakeApi({ rows: twoRows });
      api.listRowChanges.mockRejectedValue(new ApiError(404, 'GET changes → 404', 'not_found'));
      await renderView(api);
      await screen.findByTestId('table-grid');

      await userEvent.click(screen.getByTestId('grid-row-r1'));

      expect(await screen.findByTestId('history-empty')).toBeTruthy();
    });

    it('user can close the history panel', async () => {
      await renderView(fakeApi({ rows: twoRows }));
      await screen.findByTestId('table-grid');
      await userEvent.click(screen.getByTestId('grid-row-r1'));
      await screen.findByTestId('tables-history');

      await userEvent.click(screen.getByTestId('tables-history-close'));

      expect(screen.queryByTestId('tables-history')).toBeNull();
    });
  });

  describe('used by', () => {
    it('user sees no "used by" bar when nothing supplies it', async () => {
      await renderView(fakeApi({ rows: twoRows }));
      await screen.findByTestId('table-grid');

      expect(screen.queryByTestId('tables-used-by')).toBeNull();
    });

    it('user sees the "used by" bar when it is supplied', async () => {
      await renderView(fakeApi({ rows: twoRows }), [inputBinding('usedBy', () => [{ name: 'Argus', mode: 'read · write' }])]);
      await screen.findByTestId('table-grid');

      expect(screen.getByTestId('tables-used-by')).toHaveTextContent('Argus');
    });
  });
});
