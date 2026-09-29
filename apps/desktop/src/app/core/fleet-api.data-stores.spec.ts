import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FleetApiService } from './fleet-api.service';

const jsonResponse = (body: unknown) => ({ ok: true, status: 200, json: () => Promise.resolve(body) }) as unknown as Response;

describe('FleetApiService data stores', () => {
  let api: FleetApiService;
  let fetchMock: ReturnType<typeof vi.fn>;

  const lastRequest = () => {
    const [url, init] = fetchMock.mock.calls.at(-1) as [string, RequestInit];
    const parsed = new URL(url);
    return { path: parsed.pathname, query: parsed.searchParams, method: init.method ?? 'GET', body: init.body ? JSON.parse(init.body as string) : undefined };
  };

  beforeEach(() => {
    api = new FleetApiService();
    fetchMock = vi.fn().mockResolvedValue(jsonResponse({ items: [] }));
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('lists the projects a table can be scoped to', async () => {
    await api.listProjects();

    expect(lastRequest()).toMatchObject({ path: '/api/projects', method: 'GET' });
  });

  it('lists the data stores of a project', async () => {
    await api.listDataStores('p1');

    expect(lastRequest()).toMatchObject({ path: '/api/data-stores', method: 'GET' });
    expect(lastRequest().query.get('projectId')).toBe('p1');
  });

  it('creates a data store in a project', async () => {
    await api.createDataStore({ projectId: 'p1', displayName: 'backlog' });

    expect(lastRequest()).toMatchObject({ path: '/api/data-stores', method: 'POST', body: { projectId: 'p1', displayName: 'backlog' } });
  });

  it('reads a data store with its columns', async () => {
    await api.getDataStore({ projectId: 'p1', storeId: 's1' });

    expect(lastRequest()).toMatchObject({ path: '/api/data-stores/s1', method: 'GET' });
    expect(lastRequest().query.get('projectId')).toBe('p1');
  });

  it('queries rows with a JSON where, orderBy and paging', async () => {
    const where = [{ columnId: 'c1', op: 'eq' as const, value: 'todo' }];
    const orderBy = [{ columnId: 'c1', dir: 'asc' as const }];

    await api.queryDataStore({ projectId: 'p1', storeId: 's1', where, orderBy, limit: 50, offset: 10 });

    const { path, query } = lastRequest();
    expect(path).toBe('/api/data-stores/s1/rows');
    expect(JSON.parse(query.get('where') as string)).toEqual(where);
    expect(JSON.parse(query.get('orderBy') as string)).toEqual(orderBy);
    expect([query.get('limit'), query.get('offset')]).toEqual(['50', '10']);
  });

  it('omits where and orderBy from the query when none is given', async () => {
    await api.queryDataStore({ projectId: 'p1', storeId: 's1' });

    expect(lastRequest().query.has('where')).toBe(false);
    expect(lastRequest().query.has('orderBy')).toBe(false);
  });

  it('inserts rows', async () => {
    await api.insertRows({ projectId: 'p1', storeId: 's1', rows: [{ c1: 'a' }] });

    expect(lastRequest()).toMatchObject({ path: '/api/data-stores/s1/rows', method: 'POST', body: { projectId: 'p1', rows: [{ c1: 'a' }] } });
  });

  it('updates rows', async () => {
    await api.updateRows({ projectId: 'p1', storeId: 's1', updates: [{ rowId: 'r1', patch: { c1: 'b' } }] });

    expect(lastRequest()).toMatchObject({ path: '/api/data-stores/s1/rows', method: 'PATCH', body: { projectId: 'p1', updates: [{ rowId: 'r1', patch: { c1: 'b' } }] } });
  });

  it('lists the changes of a row', async () => {
    await api.listRowChanges({ projectId: 'p1', storeId: 's1', rowId: 'r1' });

    expect(lastRequest()).toMatchObject({ path: '/api/data-stores/s1/rows/r1/changes', method: 'GET' });
    expect(lastRequest().query.get('projectId')).toBe('p1');
  });

  it('lists the views of a data store', async () => {
    await api.listViews({ projectId: 'p1', storeId: 's1' });

    expect(lastRequest()).toMatchObject({ path: '/api/data-stores/s1/views', method: 'GET' });
    expect(lastRequest().query.get('projectId')).toBe('p1');
  });
});
