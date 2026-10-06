import { render, screen, within } from '@testing-library/angular/zoneless';
import userEvent from '@testing-library/user-event';
import { inputBinding, signal } from '@angular/core';
import type { DataStore, DsColumn, DsRow, DsRowHistoryEntry } from '@openfleet/shared';
import { describe, expect, it, vi } from 'vitest';
import { ApiError, FleetApiService } from '../core/fleet-api.service';
import { NO_VALUE_GROUP_ID } from './table-kanban.component';
import { TablesViewComponent } from './tables-view.component';

const NOW = '2026-09-29T10:00:00.000Z';

const store = (id: string, displayName: string): DataStore => ({ id, projectId: 'p1', displayName, createdAt: NOW, updatedAt: NOW });
const page = <T>(items: T[], total = items.length) => ({ items, total, limit: 100, offset: 0 });
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
const settle = async (fixture: { detectChanges: () => void; whenStable: () => Promise<unknown> }) => {
  await new Promise((resolve) => setTimeout(resolve, 0));
  fixture.detectChanges();
  await fixture.whenStable();
};
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
      const { fixture } = await renderView(api);
      await userEvent.selectOptions(await screen.findByTestId('tables-project-scope'), 'p2');
      await screen.findByTestId('table-pill-s9');

      slowFirstProject.resolve(page([store('s1', 'backlog')]));
      await settle(fixture);

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
      const { fixture } = await renderView(api);
      await userEvent.click(await screen.findByTestId('table-pill-s2'));
      await screen.findByTestId('grid-cell-r9-c-title');

      slowBacklog.resolve(page([row('r1', { 'c-title': 'From backlog' })]));
      await settle(fixture);

      expect(screen.getByTestId('grid-cell-r9-c-title')).toBeTruthy();
      expect(screen.queryByTestId('grid-cell-r1-c-title')).toBeNull();
    });

    it('user sees the history of the row they clicked last, not of a slower earlier one', async () => {
      const api = fakeApi({ rows: twoRows });
      const slowFirstRow = deferred<{ items: DsRowHistoryEntry[]; total: number }>();
      api.listRowChanges.mockImplementation(({ rowId }: { rowId: string }) =>
        rowId === 'r1' ? slowFirstRow.promise : Promise.resolve({ items: [historyEntry({ id: 'h2', rowId: 'r2' })], total: 1 }));
      const { fixture } = await renderView(api);
      await screen.findByTestId('table-grid');
      await userEvent.click(screen.getByTestId('grid-row-r1'));
      await userEvent.click(screen.getByTestId('grid-row-r2'));
      await screen.findByTestId('history-entry-h2');

      slowFirstRow.resolve({ items: [historyEntry({ id: 'h1' })], total: 1 });
      await settle(fixture);

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

      await userEvent.click(screen.getByTestId('table-add'));
      await userEvent.type(screen.getByTestId('tables-new-name'), 'sprint');
      await userEvent.click(screen.getByTestId('tables-create'));

      expect(await screen.findByTestId('table-pill-s3')).toHaveTextContent('sprint');
      await vi.waitFor(() => expect(api.queryDataStore).toHaveBeenLastCalledWith(expect.objectContaining({ storeId: 's3' })));
    });
  });

  describe('rows beyond the first page', () => {
    it('user is told how many rows are shown of the total and can load the rest', async () => {
      const api = fakeApi();
      api.queryDataStore
        .mockResolvedValueOnce(page([row('r1', { 'c-title': 'First' })], 3))
        .mockResolvedValueOnce({ ...page([row('r2', { 'c-title': 'Second' }), row('r3', { 'c-title': 'Third' })], 3), offset: 1 });
      await renderView(api);
      expect(await screen.findByTestId('tables-rows-truncated')).toHaveTextContent('Showing 1 of 3');

      await userEvent.click(screen.getByTestId('tables-load-more'));

      expect(await screen.findByTestId('grid-cell-r3-c-title')).toBeTruthy();
      expect(screen.getByTestId('grid-cell-r1-c-title')).toBeTruthy();
      expect(api.queryDataStore).toHaveBeenLastCalledWith(expect.objectContaining({ storeId: 's1', offset: 1 }));
      expect(screen.queryByTestId('tables-rows-truncated')).toBeNull();
    });

    it('user never sees a row twice when the next page overlaps the rows already loaded', async () => {
      const api = fakeApi();
      api.queryDataStore
        .mockResolvedValueOnce(page([row('r1', { 'c-title': 'First' })], 2))
        .mockResolvedValueOnce(page([row('r1', { 'c-title': 'First' }), row('r2', { 'c-title': 'Second' })], 2));
      await renderView(api);

      await userEvent.click(await screen.findByTestId('tables-load-more'));

      await screen.findByTestId('grid-row-r2');
      expect(screen.getAllByTestId('grid-row-r1')).toHaveLength(1);
    });

    it('user adding a row sees the total of the truncation notice grow', async () => {
      const api = fakeApi();
      api.queryDataStore.mockResolvedValueOnce(page([row('r1', { 'c-title': 'First' })], 2));
      await renderView(api);
      expect(await screen.findByTestId('tables-rows-truncated')).toHaveTextContent('Showing 1 of 2');
      api.queryDataStore.mockResolvedValueOnce(page([row('r1', { 'c-title': 'First' })], 3));

      await userEvent.click(screen.getByTestId('tables-add-row'));

      await vi.waitFor(() => expect(screen.getByTestId('tables-rows-truncated')).toHaveTextContent('Showing 1 of 3'));
    });

    it('user sees no truncation notice when every row is loaded', async () => {
      await renderView(fakeApi({ rows: twoRows }));
      await screen.findByTestId('table-grid');

      expect(screen.queryByTestId('tables-rows-truncated')).toBeNull();
    });

    it('user is told when loading more rows fails and can try again', async () => {
      const api = fakeApi();
      api.queryDataStore.mockResolvedValueOnce(page([row('r1', { 'c-title': 'First' })], 2));
      await renderView(api);
      api.queryDataStore.mockRejectedValueOnce(new ApiError(500, 'GET rows → 500'));

      await userEvent.click(await screen.findByTestId('tables-load-more'));

      expect(await screen.findByTestId('tables-action-error')).toBeTruthy();
      expect(screen.getByTestId('tables-load-more')).toBeTruthy();
    });
  });

  describe('writes are not sent twice', () => {
    it('user can add a row from the toolbar, and double-clicking + Row inserts a single row', async () => {
      const api = fakeApi({ rows: twoRows });
      api.insertRows.mockReturnValue(new Promise(() => undefined));
      await renderView(api);
      await screen.findByTestId('table-grid');

      await userEvent.dblClick(screen.getByTestId('tables-add-row'));

      expect(api.insertRows).toHaveBeenCalledExactlyOnceWith({ projectId: 'p1', storeId: 's1', rows: [{}] });
    });

    it('user double-clicking "Clear those values" clears them once', async () => {
      const api = fakeApi({ rows: [row('r1', { 'c-title': 'Stale', 'c-status': 'archived' })] });
      api.updateRows.mockReturnValue(new Promise(() => undefined));
      await renderView(api);

      await userEvent.dblClick(await screen.findByTestId('tables-clear-mismatches'));

      expect(api.updateRows).toHaveBeenCalledTimes(1);
    });

    it('user pressing Enter twice on the table name creates a single table', async () => {
      const api = fakeApi({ rows: twoRows });
      api.createDataStore.mockReturnValue(new Promise(() => undefined));
      await renderView(api);
      await screen.findByTestId('table-grid');
      await userEvent.click(screen.getByTestId('table-add'));

      await userEvent.type(screen.getByTestId('tables-new-name'), 'sprint{Enter}{Enter}');

      expect(api.createDataStore).toHaveBeenCalledTimes(1);
    });

    it('user can add a row again after a failed attempt and is told about the failure', async () => {
      const api = fakeApi({ rows: twoRows });
      api.insertRows.mockRejectedValue(new ApiError(500, 'POST rows → 500'));
      await renderView(api);
      await screen.findByTestId('table-grid');

      await userEvent.click(screen.getByTestId('tables-add-row'));
      expect(await screen.findByTestId('tables-action-error')).toHaveTextContent('could not be saved');
      await userEvent.click(screen.getByTestId('tables-add-row'));

      await vi.waitFor(() => expect(api.insertRows).toHaveBeenCalledTimes(2));
    });

    it('user is told when clearing the mismatched values fails', async () => {
      const api = fakeApi({ rows: [row('r1', { 'c-title': 'Stale', 'c-status': 'archived' })] });
      api.updateRows.mockRejectedValue(new ApiError(500, 'PATCH rows → 500'));
      await renderView(api);

      await userEvent.click(await screen.findByTestId('tables-clear-mismatches'));

      expect(await screen.findByTestId('tables-action-error')).toHaveTextContent('could not be saved');
    });
  });

  describe('clearing more mismatched values than one request can carry', () => {
    const MAX_UPDATES_PER_REQUEST = 500;
    const staleRow = (index: number) => row(`r${index}`, { 'c-title': `Stale ${index}`, 'c-status': 'archived' });
    const staleRows = (count: number) => Array.from({ length: count }, (_unused, index) => staleRow(index));

    const apiHoldingRows = (initialRows: DsRow[]) => {
      let storedRows = initialRows;
      const api = fakeApi();
      api.queryDataStore.mockImplementation(() => Promise.resolve(page(storedRows)));
      api.updateRows.mockImplementation(({ updates }: { updates: { rowId: string; patch: Record<string, unknown> }[] }) => {
        if (updates.length > MAX_UPDATES_PER_REQUEST) return Promise.reject(new ApiError(400, 'PATCH rows → 400', 'invalid_body'));
        const patchesByRowId = new Map(updates.map(({ rowId, patch }) => [rowId, patch]));
        storedRows = storedRows.map((stored) => ({ ...stored, data: { ...stored.data, ...patchesByRowId.get(stored.id) } }));
        return Promise.resolve({ items: [] });
      });
      return api;
    };
    const sentBatchSizes = (api: ReturnType<typeof fakeApi>) =>
      api.updateRows.mock.calls.map(([request]) => request.updates.length);

    it('user can clear 501 mismatched rows, sent as one request of 500 and one of 1', async () => {
      const api = apiHoldingRows(staleRows(501));
      await renderView(api);

      await userEvent.click(await screen.findByTestId('tables-clear-mismatches'));

      expect(await screen.findByTestId('table-grid')).toBeTruthy();
      expect(sentBatchSizes(api)).toEqual([500, 1]);
      expect(screen.queryByTestId('tables-schema-mismatch')).toBeNull();
      expect(screen.queryByTestId('tables-action-error')).toBeNull();
    });

    it('user clearing exactly 500 mismatched rows sends a single request', async () => {
      const api = apiHoldingRows(staleRows(500));
      await renderView(api);

      await userEvent.click(await screen.findByTestId('tables-clear-mismatches'));

      expect(await screen.findByTestId('table-grid')).toBeTruthy();
      expect(sentBatchSizes(api)).toEqual([500]);
    });

    it('user is told how many values were cleared when a later request fails, and can retry only the remaining ones', async () => {
      const api = apiHoldingRows(staleRows(501));
      const applyingUpdates = api.updateRows.getMockImplementation() as (request: unknown) => Promise<unknown>;
      api.updateRows.mockImplementationOnce(applyingUpdates);
      api.updateRows.mockRejectedValueOnce(new ApiError(500, 'PATCH rows → 500'));
      await renderView(api);

      await userEvent.click(await screen.findByTestId('tables-clear-mismatches'));

      expect(await screen.findByTestId('tables-action-error')).toHaveTextContent(
        'Cleared 500 of 501 values; the rest could not be saved. Retry to clear the remaining ones',
      );
      expect(screen.getByTestId('tables-schema-mismatch')).toHaveTextContent('1 row');

      await userEvent.click(screen.getByTestId('tables-clear-mismatches'));

      expect(await screen.findByTestId('table-grid')).toBeTruthy();
      expect(api.updateRows).toHaveBeenCalledTimes(3);
      expect(api.updateRows).toHaveBeenLastCalledWith({ projectId: 'p1', storeId: 's1', updates: [{ rowId: 'r500', patch: { 'c-status': null } }] });
      expect(screen.queryByTestId('tables-action-error')).toBeNull();
    });

    it('user who opened another table while a chunked clear fails halfway keeps the other table and sees no error about the first one', async () => {
      const api = apiHoldingRows(staleRows(501));
      api.queryDataStore.mockImplementation(({ storeId }: { storeId: string }) =>
        Promise.resolve(page(storeId === 's2' ? [row('r-other', { 'c-title': 'From releases' })] : staleRows(501))));
      const slowFirstChunk = deferred<{ items: DsRow[] }>();
      api.updateRows.mockReturnValueOnce(slowFirstChunk.promise);
      api.updateRows.mockRejectedValueOnce(new ApiError(500, 'PATCH rows → 500'));
      const { fixture } = await renderView(api);
      await userEvent.click(await screen.findByTestId('tables-clear-mismatches'));
      await userEvent.click(screen.getByTestId('table-pill-s2'));
      await screen.findByTestId('grid-cell-r-other-c-title');

      slowFirstChunk.resolve({ items: [] });
      await settle(fixture);

      expect(api.updateRows).toHaveBeenCalledTimes(2);
      expect(screen.getByTestId('grid-cell-r-other-c-title')).toBeTruthy();
      expect(screen.queryByTestId('tables-action-error')).toBeNull();
      expect(screen.queryByTestId('tables-schema-mismatch')).toBeNull();
    });

    it('user who opened another table sees no error when the first request of the clear fails', async () => {
      const api = apiHoldingRows(staleRows(501));
      api.queryDataStore.mockImplementation(({ storeId }: { storeId: string }) =>
        Promise.resolve(page(storeId === 's2' ? [row('r-other', { 'c-title': 'From releases' })] : staleRows(501))));
      const slowFirstChunk = deferred<{ items: DsRow[] }>();
      api.updateRows.mockReturnValueOnce(slowFirstChunk.promise);
      const { fixture } = await renderView(api);
      await userEvent.click(await screen.findByTestId('tables-clear-mismatches'));
      await userEvent.click(screen.getByTestId('table-pill-s2'));
      await screen.findByTestId('grid-cell-r-other-c-title');

      slowFirstChunk.reject(new ApiError(500, 'PATCH rows → 500'));
      await settle(fixture);

      expect(screen.getByTestId('grid-cell-r-other-c-title')).toBeTruthy();
      expect(screen.queryByTestId('tables-action-error')).toBeNull();
    });

    it('user cannot add a row or start a second clear while a clear is running', async () => {
      const api = apiHoldingRows(staleRows(501));
      const slowFirstChunk = deferred<{ items: DsRow[] }>();
      api.updateRows.mockReturnValueOnce(slowFirstChunk.promise);
      const { fixture } = await renderView(api);
      await userEvent.click(await screen.findByTestId('tables-clear-mismatches'));

      expect(screen.getByTestId('tables-add-row')).toBeDisabled();
      expect(screen.getByTestId('tables-clear-mismatches')).toBeDisabled();

      slowFirstChunk.resolve({ items: [] });
      await settle(fixture);
    });

    it('user reopening the same table during a clear that fails halfway still sees how many values were cleared', async () => {
      const api = apiHoldingRows(staleRows(501));
      const applyingUpdates = api.updateRows.getMockImplementation() as (request: unknown) => Promise<unknown>;
      const slowFirstChunk = deferred<{ items: DsRow[] }>();
      api.updateRows.mockReturnValueOnce(slowFirstChunk.promise.then(() => applyingUpdates({ updates: [] })));
      api.updateRows.mockRejectedValueOnce(new ApiError(500, 'PATCH rows → 500'));
      const { fixture } = await renderView(api);
      await userEvent.click(await screen.findByTestId('tables-clear-mismatches'));
      await userEvent.click(screen.getByTestId('table-pill-s1'));

      slowFirstChunk.resolve({ items: [] });
      await settle(fixture);

      expect(await screen.findByTestId('tables-action-error')).toHaveTextContent(
        'Cleared 500 of 501 values; the rest could not be saved. Retry to clear the remaining ones',
      );
    });

    it('user sees the count of cleared values, not of rows, when a row holds two stale values', async () => {
      const priorityColumn: DsColumn = {
        id: 'c-priority', storeId: 's1', displayName: 'Priority', columnType: 'select', sortOrder: 2,
        options: [{ id: 'low', label: 'low' }, { id: 'high', label: 'high' }],
      };
      const rowsWithOneRowHoldingTwoStaleValues = staleRows(501).map((stale, index) =>
        index === 0 ? row(stale.id, { ...stale.data, 'c-priority': 'urgent' }) : stale);
      const api = fakeApi({ columns: [...columns, priorityColumn] });
      api.queryDataStore.mockResolvedValue(page(rowsWithOneRowHoldingTwoStaleValues));
      api.updateRows.mockResolvedValueOnce({ items: [] });
      api.updateRows.mockRejectedValueOnce(new ApiError(500, 'PATCH rows → 500'));
      await renderView(api);

      expect(await screen.findByTestId('tables-schema-mismatch')).toHaveTextContent('for 501 rows');
      await userEvent.click(screen.getByTestId('tables-clear-mismatches'));

      expect(await screen.findByTestId('tables-action-error')).toHaveTextContent('Cleared 501 of 502 values');
    });
  });

  describe('creating a table without a project', () => {
    it('user is told there is no project to create a table in instead of getting a dead form', async () => {
      await renderView(fakeApi({ projects: [] }));
      await screen.findByTestId('tables-no-project');

      await userEvent.click(screen.getByTestId('table-add'));

      expect(screen.getByTestId('tables-action-error')).toHaveTextContent('No project');
      expect(screen.queryByTestId('tables-new-name')).toBeNull();
    });
  });

  describe('kanban buckets', () => {
    it('applies saved card settings, partial column order and ungrouped visibility from the same view', async () => {
      const api = fakeApi({ rows: [...twoRows, row('r3', { 'c-title': 'Ungrouped' })] });
      api.listViews.mockResolvedValue({ items: [{ id: 'v1', storeId: 's1', displayName: 'Board', viewType: 'kanban', config: {
        groupByColumnId: 'c-status', cardTitleColumnId: 'c-status', cardFields: [], columnOrder: ['done'], showUngrouped: false,
      }, sortOrder: 0 }] });
      await renderView(api);
      await userEvent.click(await screen.findByTestId('table-pill-s1'));
      await screen.findByTestId('grid-row-r1');
      await userEvent.click(screen.getByTestId('tables-toggle-kanban'));

      expect(screen.getAllByTestId(/^kanban-column-/).map((element) => element.getAttribute('data-testid'))).toEqual(['kanban-column-done', 'kanban-column-todo', 'kanban-column-doing']);
      expect(screen.getByTestId('kanban-card-r1')).toHaveTextContent('in progress');
      expect(screen.getByTestId('kanban-card-r1')).not.toHaveTextContent('Desktop reconnect');
      expect(screen.queryByTestId('kanban-card-r3')).toBeNull();
    });
    const statusAndPriority: DsColumn[] = [
      ...columns,
      { id: 'c-priority', storeId: 's1', displayName: 'Priority', columnType: 'select', sortOrder: 2, options: [{ id: 'p-high', label: 'high' }, { id: 'p-low', label: 'low' }] },
    ];

    it('user still sees a row with no status in a "No value" bucket of the kanban', async () => {
      await renderView(fakeApi({ rows: [...twoRows, row('r3', {})] }));
      await screen.findByTestId('table-grid');

      await userEvent.click(screen.getByTestId('tables-toggle-kanban'));

      const bucket = screen.getByTestId(`kanban-column-${NO_VALUE_GROUP_ID}`);
      expect(bucket).toHaveTextContent('No value');
      expect(within(bucket).getByTestId('kanban-card-r3')).toBeTruthy();
    });

    it('user finds a row whose status is not an option in the "No value" bucket after viewing it anyway', async () => {
      await renderView(fakeApi({ rows: [row('r1', { 'c-title': 'Stale', 'c-status': 'archived' })] }));
      await userEvent.click(await screen.findByTestId('tables-view-rows'));

      await userEvent.click(screen.getByTestId('tables-toggle-kanban'));

      expect(within(screen.getByTestId(`kanban-column-${NO_VALUE_GROUP_ID}`)).getByTestId('kanban-card-r1')).toBeTruthy();
    });

    it('user sees no "No value" bucket when every row has a status', async () => {
      await renderView(fakeApi({ rows: twoRows }));
      await screen.findByTestId('table-grid');

      await userEvent.click(screen.getByTestId('tables-toggle-kanban'));

      expect(screen.queryByTestId(`kanban-column-${NO_VALUE_GROUP_ID}`)).toBeNull();
    });

    it('user sees the kanban grouped by the column its saved kanban view names', async () => {
      const api = fakeApi({ rows: [row('r1', { 'c-title': 'A', 'c-status': 'todo', 'c-priority': 'p-high' })], columns: statusAndPriority });
      api.listViews.mockResolvedValue({ items: [{ id: 'v1', storeId: 's1', displayName: 'Board', viewType: 'kanban', config: { groupByColumnId: 'c-priority' }, sortOrder: 0 }] });
      await renderView(api);
      await screen.findByTestId('table-grid');

      await userEvent.click(screen.getByTestId('tables-toggle-kanban'));

      expect(screen.getByTestId('kanban-count-p-high')).toHaveTextContent('1');
      expect(screen.queryByTestId('kanban-count-todo')).toBeNull();
    });

    it('user groups by the first select column when no kanban view names one', async () => {
      await renderView(fakeApi({ rows: [row('r1', { 'c-title': 'A', 'c-status': 'todo' })], columns: statusAndPriority }));
      await screen.findByTestId('table-grid');

      await userEvent.click(screen.getByTestId('tables-toggle-kanban'));

      expect(screen.getByTestId('kanban-count-todo')).toHaveTextContent('1');
    });
  });

  describe('a table without columns', () => {
    it('user is told to add a column first instead of seeing empty stripes, in the grid and in the kanban', async () => {
      await renderView(fakeApi({ rows: [row('r1', {})], columns: [] }));

      expect(await screen.findByTestId('tables-no-columns')).toHaveTextContent('Add a column first');
      await userEvent.click(screen.getByTestId('tables-toggle-kanban'));

      expect(screen.getByTestId('tables-no-columns')).toBeTruthy();
      expect(screen.queryByTestId('tables-kanban-needs-select')).toBeNull();
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

    it('user sees that a table has no rows and can add the first one', async () => {
      const api = fakeApi({ rows: [] });
      await renderView(api);

      expect(await screen.findByTestId('tables-empty')).toHaveTextContent('“backlog” has no rows');
      await userEvent.click(screen.getByTestId('tables-add-first-row'));

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

    it('user sees the schema mismatch card announced as a labelled region', async () => {
      await renderView(fakeApi({ rows: [row('r1', { 'c-status': 'archived' })] }));

      const card = await screen.findByTestId('tables-schema-mismatch');

      expect(card).toHaveAttribute('role', 'region');
      expect(card).toHaveAccessibleName(/schema mismatch/i);
    });

    it('user can still clear the offending values after choosing View rows', async () => {
      const api = fakeApi({ rows: [row('r1', { 'c-title': 'Stale', 'c-status': 'archived' })] });
      await renderView(api);
      await userEvent.click(await screen.findByTestId('tables-view-rows'));

      const banner = await screen.findByTestId('tables-mismatch-banner');
      expect(banner).toHaveTextContent('1 row');
      expect(screen.getByTestId('grid-cell-r1-c-status')).toHaveTextContent('archived');
      api.queryDataStore.mockResolvedValue(page([row('r1', { 'c-title': 'Stale', 'c-status': null })]));

      await userEvent.click(screen.getByTestId('tables-clear-mismatches'));

      expect(api.updateRows).toHaveBeenCalledWith({ projectId: 'p1', storeId: 's1', updates: [{ rowId: 'r1', patch: { 'c-status': null } }] });
      await vi.waitFor(() => expect(screen.queryByTestId('tables-mismatch-banner')).toBeNull());
    });

    it('user keeps the keyboard focus inside the tables view after choosing View rows', async () => {
      await renderView(fakeApi({ rows: [row('r1', { 'c-title': 'Stale', 'c-status': 'archived' })] }));

      await userEvent.click(await screen.findByTestId('tables-view-rows'));

      await vi.waitFor(() => expect(screen.getByTestId('tables-clear-mismatches')).toHaveFocus());
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
    it('user can switch to a kanban', async () => {
      await renderView(fakeApi({ rows: twoRows }));
      await screen.findByTestId('table-grid');

      await userEvent.click(screen.getByTestId('tables-toggle-kanban'));

      expect(screen.getByTestId('kanban-column-doing')).toBeTruthy();
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

  describe('keyboard focus', () => {
    it('user opening a row lands on the labelled history panel', async () => {
      await renderView(fakeApi({ rows: twoRows }));
      await screen.findByTestId('table-grid');

      await userEvent.click(screen.getByTestId('grid-row-r1'));

      const panel = await screen.findByTestId('tables-history');
      await vi.waitFor(() => expect(panel).toHaveFocus());
    });

    it('user closing the history lands back on the row that was open', async () => {
      await renderView(fakeApi({ rows: twoRows }));
      await screen.findByTestId('table-grid');
      await userEvent.click(screen.getByTestId('grid-row-r2'));
      await screen.findByTestId('tables-history');

      await userEvent.click(screen.getByTestId('tables-history-close'));

      expect(screen.getByTestId('grid-row-r2')).toHaveFocus();
    });

    it('user can close the history with Escape and lands back on the row that was open', async () => {
      await renderView(fakeApi({ rows: twoRows }));
      await screen.findByTestId('table-grid');
      await userEvent.click(screen.getByTestId('grid-row-r2'));
      const panel = await screen.findByTestId('tables-history');
      await vi.waitFor(() => expect(panel).toHaveFocus());

      await userEvent.keyboard('{Escape}');

      expect(screen.queryByTestId('tables-history')).toBeNull();
      expect(screen.getByTestId('grid-row-r2')).toHaveFocus();
    });

    it('user sees the same focus ring on the project select, the layout toggles and the history panel as on the rest of the app', async () => {
      await renderView(fakeApi({ rows: twoRows, projects: projectsNamed('p1', 'p2') }));
      await screen.findByTestId('table-grid');
      await userEvent.click(screen.getByTestId('grid-row-r1'));
      await screen.findByTestId('tables-history');

      const ringed = ['tables-project-scope', 'tables-toggle-grid', 'tables-toggle-kanban', 'tables-history', 'tables-history-close'];
      for (const testId of ringed) expect(screen.getByTestId(testId), testId).toHaveClass('of-focus-ring');
    });

    it('user closing the history lands back on the kanban card that was open', async () => {
      await renderView(fakeApi({ rows: twoRows }));
      await screen.findByTestId('table-grid');
      await userEvent.click(screen.getByTestId('tables-toggle-kanban'));
      await userEvent.click(screen.getByTestId('kanban-card-r1'));
      await screen.findByTestId('tables-history');

      await userEvent.click(screen.getByTestId('tables-history-close'));

      expect(screen.getByTestId('kanban-card-r1')).toHaveFocus();
    });
  });

  describe('recovering from failures', () => {
    it('user reaches the tables again with one Retry after both the projects and the tables failed on a deep link', async () => {
      const api = fakeApi({ rows: twoRows });
      const storesFailure = deferred<never>();
      const projectsFailure = deferred<never>();
      api.listDataStores.mockReturnValueOnce(storesFailure.promise);
      api.listProjects.mockReturnValueOnce(projectsFailure.promise);
      await renderView(api, [inputBinding('projectId', () => 'p1')]);
      await vi.waitFor(() => expect(api.listDataStores).toHaveBeenCalledTimes(1));
      storesFailure.reject(new ApiError(500, 'GET stores → 500'));
      await vi.waitFor(() => expect(screen.getByTestId('tables-load-error')).toHaveTextContent('Could not load the tables'));
      projectsFailure.reject(new ApiError(500, 'GET projects → 500'));
      await vi.waitFor(() => expect(screen.getByTestId('tables-load-error')).toHaveTextContent('Could not load the projects'));

      await userEvent.click(screen.getByTestId('tables-retry'));

      expect(await screen.findByTestId('table-grid')).toBeTruthy();
      expect(screen.queryByTestId('tables-loading')).toBeNull();
      expect(screen.queryByTestId('tables-load-error')).toBeNull();
    });

    it('user does not see "No tables yet" flash while the tables are still loading', async () => {
      const api = fakeApi();
      api.listDataStores.mockReturnValue(new Promise(() => undefined));

      await renderView(api);

      expect(await screen.findByTestId('tables-loading')).toBeTruthy();
      expect(screen.queryByTestId('tables-no-tables')).toBeNull();
    });
  });

  describe('switching project or table', () => {
    it('user switching project no longer sees the previous project tables while the new list loads', async () => {
      const api = fakeApi({ projects: projectsNamed('p1', 'p2') });
      api.listDataStores.mockImplementation((projectId: string) => (projectId === 'p1' ? Promise.resolve(page([store('s1', 'backlog')])) : new Promise(() => undefined)));
      await renderView(api);
      await screen.findByTestId('table-pill-s1');

      await userEvent.selectOptions(screen.getByTestId('tables-project-scope'), 'p2');

      await vi.waitFor(() => expect(screen.queryByTestId('table-pill-s1')).toBeNull());
    });

    it('user creating a table then switching project before the answer never sees it in the other project', async () => {
      const api = fakeApi({ projects: projectsNamed('p1', 'p2'), rows: twoRows });
      const slowCreation = deferred<DataStore>();
      api.createDataStore.mockReturnValue(slowCreation.promise);
      api.listDataStores.mockImplementation((projectId: string) => Promise.resolve(page(projectId === 'p1' ? [store('s1', 'backlog')] : [store('s9', 'other-table')])));
      const { fixture } = await renderView(api);
      await screen.findByTestId('table-grid');
      await userEvent.click(screen.getByTestId('table-add'));
      await userEvent.type(screen.getByTestId('tables-new-name'), 'sprint');
      await userEvent.click(screen.getByTestId('tables-create'));
      await userEvent.selectOptions(screen.getByTestId('tables-project-scope'), 'p2');
      await screen.findByTestId('table-pill-s9');

      slowCreation.resolve(store('s3', 'sprint'));
      await settle(fixture);

      expect(screen.queryByTestId('table-pill-s3')).toBeNull();
      expect(api.queryDataStore).not.toHaveBeenCalledWith(expect.objectContaining({ storeId: 's3' }));
    });

    it('user no longer sees a failed-action message after opening another table', async () => {
      const api = fakeApi({ rows: twoRows });
      api.insertRows.mockRejectedValue(new ApiError(500, 'POST rows → 500'));
      await renderView(api);
      await screen.findByTestId('table-grid');
      await userEvent.click(screen.getByTestId('tables-add-row'));
      await screen.findByTestId('tables-action-error');

      await userEvent.click(screen.getByTestId('table-pill-s2'));

      await vi.waitFor(() => expect(screen.queryByTestId('tables-action-error')).toBeNull());
    });

    it('user no longer sees a failed-action message after switching project', async () => {
      const api = fakeApi({ projects: projectsNamed('p1', 'p2'), rows: twoRows });
      api.insertRows.mockRejectedValue(new ApiError(500, 'POST rows → 500'));
      await renderView(api);
      await screen.findByTestId('table-grid');
      await userEvent.click(screen.getByTestId('tables-add-row'));
      await screen.findByTestId('tables-action-error');

      await userEvent.selectOptions(screen.getByTestId('tables-project-scope'), 'p2');

      await vi.waitFor(() => expect(screen.queryByTestId('tables-action-error')).toBeNull());
    });

    it('user never sees the rows of a slow "Load more" land in the table they switched to', async () => {
      const api = fakeApi();
      const slowNextPage = deferred<ReturnType<typeof page<DsRow>>>();
      api.queryDataStore.mockImplementation(({ storeId, offset }: { storeId: string; offset?: number }) => {
        if (storeId === 's2') return Promise.resolve(page([row('r9', { 'c-title': 'From releases' })]));
        return offset ? slowNextPage.promise : Promise.resolve(page([row('r1', { 'c-title': 'First' })], 2));
      });
      const { fixture } = await renderView(api);
      await userEvent.click(await screen.findByTestId('tables-load-more'));
      await userEvent.click(screen.getByTestId('table-pill-s2'));
      await screen.findByTestId('grid-cell-r9-c-title');

      slowNextPage.resolve(page([row('r2', { 'c-title': 'Second' })], 2));
      await settle(fixture);

      expect(screen.queryByTestId('grid-cell-r2-c-title')).toBeNull();
    });
  });

  describe('a write answering after the user moved on', () => {
    const rowsByStore = (api: ReturnType<typeof fakeApi>) =>
      api.queryDataStore.mockImplementation(({ storeId }: { storeId: string }) =>
        Promise.resolve(page(storeId === 's2' ? [row('r9', { 'c-title': 'From releases' })] : twoRows)));

    it('user adding a row then opening another table keeps the other table on screen', async () => {
      const api = fakeApi();
      rowsByStore(api);
      const slowInsert = deferred<{ items: DsRow[] }>();
      api.insertRows.mockReturnValue(slowInsert.promise);
      const { fixture } = await renderView(api);
      await screen.findByTestId('grid-cell-r1-c-title');
      await userEvent.click(screen.getByTestId('tables-add-row'));
      await userEvent.click(screen.getByTestId('table-pill-s2'));
      await screen.findByTestId('grid-cell-r9-c-title');

      slowInsert.resolve({ items: [] });
      await settle(fixture);

      expect(screen.getByTestId('grid-cell-r9-c-title')).toBeTruthy();
      expect(screen.queryByTestId('grid-cell-r1-c-title')).toBeNull();
      expect(api.queryDataStore).toHaveBeenCalledTimes(2);
    });

    it('user clearing mismatched values then opening another table keeps the other table on screen', async () => {
      const api = fakeApi();
      api.queryDataStore.mockImplementation(({ storeId }: { storeId: string }) =>
        Promise.resolve(page(storeId === 's2' ? [row('r9', { 'c-title': 'From releases' })] : [row('r1', { 'c-title': 'Stale', 'c-status': 'archived' })])));
      const slowUpdate = deferred<{ items: DsRow[] }>();
      api.updateRows.mockReturnValue(slowUpdate.promise);
      const { fixture } = await renderView(api);
      await userEvent.click(await screen.findByTestId('tables-clear-mismatches'));
      await userEvent.click(screen.getByTestId('table-pill-s2'));
      await screen.findByTestId('grid-cell-r9-c-title');

      slowUpdate.resolve({ items: [] });
      await settle(fixture);

      expect(screen.getByTestId('grid-cell-r9-c-title')).toBeTruthy();
      expect(screen.queryByTestId('tables-schema-mismatch')).toBeNull();
    });

    it('user adding a row then switching project sees the tables of the new project, with no error', async () => {
      const api = fakeApi({ projects: projectsNamed('p1', 'p2'), rows: twoRows });
      api.listDataStores.mockImplementation((projectId: string) => Promise.resolve(page(projectId === 'p1' ? [store('s1', 'backlog')] : [store('s9', 'other-table')])));
      api.getDataStore.mockImplementation(({ projectId, storeId }: { projectId: string; storeId: string }) =>
        projectId === 'p2' && storeId === 's1' ? Promise.reject(new ApiError(404, 'GET → 404')) : Promise.resolve({ ...store(storeId, 'any'), columns }));
      api.queryDataStore.mockImplementation(({ storeId }: { storeId: string }) =>
        Promise.resolve(page(storeId === 's9' ? [row('r9', { 'c-title': 'From other project' })] : twoRows)));
      const slowInsert = deferred<{ items: DsRow[] }>();
      api.insertRows.mockReturnValue(slowInsert.promise);
      const { fixture } = await renderView(api);
      await screen.findByTestId('grid-cell-r1-c-title');
      await userEvent.click(screen.getByTestId('tables-add-row'));
      await userEvent.selectOptions(screen.getByTestId('tables-project-scope'), 'p2');
      await screen.findByTestId('grid-cell-r9-c-title');

      slowInsert.resolve({ items: [] });
      await settle(fixture);

      expect(screen.queryByTestId('tables-load-error')).toBeNull();
      expect(screen.getByTestId('grid-cell-r9-c-title')).toBeTruthy();
      expect(screen.queryByTestId('grid-cell-r1-c-title')).toBeNull();
      expect(api.getDataStore).not.toHaveBeenCalledWith({ projectId: 'p2', storeId: 's1' });
    });
  });

  describe('row history reliability', () => {
    it('user is told the history could not be loaded, not that there are no changes, when the daemon errors', async () => {
      const api = fakeApi({ rows: twoRows });
      api.listRowChanges.mockRejectedValue(new ApiError(500, 'GET changes → 500', 'internal_error'));
      await renderView(api);
      await screen.findByTestId('table-grid');

      await userEvent.click(screen.getByTestId('grid-row-r1'));

      expect(await screen.findByTestId('tables-history-error')).toBeTruthy();
      expect(screen.queryByTestId('history-empty')).toBeNull();
    });

    it('user reading a row history gets up to the daemon maximum of 500 entries', async () => {
      const api = fakeApi({ rows: twoRows });
      await renderView(api);
      await screen.findByTestId('table-grid');

      await userEvent.click(screen.getByTestId('grid-row-r1'));

      await screen.findByTestId('history-entry-h1');
      expect(api.listRowChanges).toHaveBeenCalledWith(expect.objectContaining({ rowId: 'r1', limit: 500 }));
    });

    it('user adding a row keeps the history panel of the open row', async () => {
      const api = fakeApi({ rows: twoRows });
      await renderView(api);
      await screen.findByTestId('table-grid');
      await userEvent.click(screen.getByTestId('grid-row-r1'));
      await screen.findByTestId('history-entry-h1');

      await userEvent.click(screen.getByTestId('tables-add-row'));

      await vi.waitFor(() => expect(api.queryDataStore).toHaveBeenCalledTimes(2));
      await screen.findByTestId('table-grid');
      expect(screen.getByTestId('tables-history')).toBeTruthy();
      expect(screen.getByTestId('history-entry-h1')).toBeTruthy();
    });
  });

  describe('naming a new table', () => {
    it('user cannot type a table name longer than the daemon accepts', async () => {
      await renderView(fakeApi({ rows: twoRows }));
      await screen.findByTestId('table-grid');

      await userEvent.click(screen.getByTestId('table-add'));

      expect(screen.getByTestId('tables-new-name')).toHaveAttribute('maxlength', '200');
    });

    it.each([
      { failure: new ApiError(404, 'POST → 404', 'project_not_found'), expected: 'project no longer exists' },
      { failure: new ApiError(400, 'POST → 400', 'invalid_body'), expected: 'name is not valid' },
    ])('user reads why the table was refused: $failure.code', async ({ failure, expected }) => {
      const api = fakeApi({ rows: twoRows });
      api.createDataStore.mockRejectedValue(failure);
      await renderView(api);
      await screen.findByTestId('table-grid');
      await userEvent.click(screen.getByTestId('table-add'));
      await userEvent.type(screen.getByTestId('tables-new-name'), 'sprint');

      await userEvent.click(screen.getByTestId('tables-create'));

      expect(await screen.findByTestId('tables-create-error')).toHaveTextContent(expected);
    });
  });

  describe('errors are announced', () => {
    it('user of a screen reader is told of a load error, an action error and a create error', async () => {
      const api = fakeApi({ rows: twoRows });
      api.insertRows.mockRejectedValue(new ApiError(500, 'POST rows → 500'));
      api.createDataStore.mockRejectedValue(new ApiError(409, 'POST → 409', 'duplicate_name'));
      api.listProjects.mockRejectedValueOnce(new ApiError(502, 'GET → 502'));
      await renderView(api);
      expect(await screen.findByTestId('tables-load-error')).toHaveAttribute('role', 'status');
      await userEvent.click(screen.getByTestId('tables-retry'));
      await screen.findByTestId('table-grid');
      await userEvent.click(screen.getByTestId('tables-add-row'));
      expect(await screen.findByTestId('tables-action-error')).toHaveAttribute('role', 'status');
      await userEvent.click(screen.getByTestId('table-add'));
      await userEvent.type(screen.getByTestId('tables-new-name'), 'backlog{Enter}');

      expect(await screen.findByTestId('tables-create-error')).toHaveAttribute('role', 'status');
    });
  });
});
