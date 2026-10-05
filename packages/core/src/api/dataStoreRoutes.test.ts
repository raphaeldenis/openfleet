import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { DsColumn } from '@openfleet/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openDatabase } from '../db/database.js';
import { EventBus } from '../events/eventBus.js';
import { ApprovalService } from '../governance/approvalService.js';
import { FakeHarness } from '../harness/fakeHarness.js';
import { newId } from '../ids.js';
import { ManagerRepository } from '../managers/managerRepository.js';
import { ManagerService } from '../managers/managerService.js';
import { PulseScheduler } from '../managers/pulseScheduler.js';
import { createMcpHandler } from '../mcp/mcpServer.js';
import { DEFAULT_MODEL_TABLE } from '../models.js';
import { DocsFolderService } from '../notes/docsFolderService.js';
import { expandMentions } from '../notes/mentionExpander.js';
import { nodeDocsFolderFs } from '../notes/nodeDocsFolderFs.js';
import { NoteRepository } from '../notes/noteRepository.js';
import { NoteService } from '../notes/noteService.js';
import { ProjectRepository } from '../projects/projectRepository.js';
import { SessionService } from '../sessions/sessionService.js';
import { WorkingStateService } from '../workingState/workingStateService.js';
import { DataStoreRepository } from '../stores/dataStoreRepository.js';
import { DataStoreService, MAX_ROWS_PER_STORE } from '../stores/dataStoreService.js';
import { startServer } from './server.js';

const ADMIN = { authorization: 'Bearer admin', 'content-type': 'application/json' };
const FILL_TO_CAP_TIMEOUT_MS = 60_000;
const AGENT ={ kind: 'agent', label: '⛏️ Gimli' } as const;

let server: Awaited<ReturnType<typeof startServer>>;
let stores: DataStoreService;
let storeRepo: DataStoreRepository;
let mcpToken: string;

const call = (method: string, path: string, body?: unknown, headers: Record<string, string> = ADMIN) =>
  fetch(`${server.url}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
const json = async <T = any>(response: Response) => (await response.json()) as T;
const q = (params: Record<string, unknown>) => new URLSearchParams(Object.entries(params).map(([k, v]) => [k, typeof v === 'string' ? v : JSON.stringify(v)])).toString();

/** A store in p1 with a text "name", a number "qty" and a select "status" column, seeded through the service port. */
function seedStore(displayName = 'Inventory') {
  const store = stores.createStore({ projectId: 'p1', displayName });
  const name = stores.addColumn(store.id, { projectId: 'p1', displayName: 'name', columnType: 'text' });
  const qty = stores.addColumn(store.id, { projectId: 'p1', displayName: 'qty', columnType: 'number' });
  const status = stores.addColumn(store.id, { projectId: 'p1', displayName: 'status', columnType: 'select', options: [{ id: 'todo', label: 'To do' }, { id: 'done', label: 'Done' }] });
  return { store, name, qty, status };
}
const insertRows = async (storeId: string, columns: { name: DsColumn; qty: DsColumn }, rows: [string, number][]) =>
  json<{ items: { id: string }[] }>(await call('POST', `/api/data-stores/${storeId}/rows`, {
    projectId: 'p1', rows: rows.map(([name, qty]) => ({ [columns.name.id]: name, [columns.qty.id]: qty })),
  }));

beforeEach(async () => {
  const db = openDatabase(':memory:');
  const bus = new EventBus();
  const harness = new FakeHarness();
  const sessions = new SessionService({ db, bus, harnesses: [harness], baseUrl: 'http://127.0.0.1:0', worktreesRoot: '/tmp/of-wt', submitKeystrokeDelayMs: 0 });
  const managerRepo = new ManagerRepository(db);
  const pulseScheduler = new PulseScheduler({ managers: managerRepo, sessions, bus });
  const managers = new ManagerService({ managers: managerRepo, sessions, bus, scheduler: pulseScheduler });
  const approvals = new ApprovalService({ db, bus });
  const modelTable = { ...DEFAULT_MODEL_TABLE };

  const projects = new ProjectRepository(db);
  projects.insert({ id: 'p1', name: 'One', docsFolderPath: null, createdAt: 't0' });
  projects.insert({ id: 'p2', name: 'Two', docsFolderPath: null, createdAt: 't0' });

  storeRepo = new DataStoreRepository(db);
  let tick = 0;
  stores = new DataStoreService({ repo: storeRepo, db, clock: () => `2026-01-01T00:00:${String(tick++ % 60).padStart(2, '0')}.000Z`, newId });
  const noteRepo = new NoteRepository(db);
  const notes = new NoteService({ repo: noteRepo, db, expandMentions, clock: () => '2026-01-01T00:00:00.000Z', newId });
  const docs = new DocsFolderService({ notes, noteRepo, projects, fs: nodeDocsFolderFs, clock: () => '2026-01-01T00:00:00.000Z' });

  server = await startServer({
    host: '127.0.0.1', port: 0, adminToken: 'admin', sessions, approvals, managers, pulseScheduler, bus, modelTable, modelConfigPath: '/tmp/of-unused/config.json',
    notes, noteRepo, docs, stores, storeRepo, projects,
    mcp: createMcpHandler({ sessions, approvals, managers, pulseScheduler, modelTable, worktreesRoot: '/tmp/of-wt', stores, storeRepo, notes, noteRepo, docs, projects, workingStates: new WorkingStateService({ db, clock: () => new Date().toISOString(), stateRoot: '/tmp/of-unused/state', maxBytes: 6144 }) }),
  });

  const session = await sessions.create({ directory: '/tmp', name: 'Gimli', harness: 'fake', emoji: '⛏️' });
  db.prepare('UPDATE sessions SET project_id = ? WHERE id = ?').run('p1', session.id);
  mcpToken = harness.launches[0]!.mcpToken;
});
afterEach(() => server.close());

describe('data store REST routes', () => {
  it('hides another project\'s store behind 404 on every :id route', async () => {
    const { store, name, qty } = seedStore();
    const [row] = (await insertRows(store.id, { name, qty }, [['bolt', 1]])).items;
    const foreignRoutes = [
      call('GET', `/api/data-stores/${store.id}?projectId=p2`),
      call('GET', `/api/data-stores/${store.id}/rows?projectId=p2`),
      call('POST', `/api/data-stores/${store.id}/rows`, { projectId: 'p2', rows: [] }),
      call('PATCH', `/api/data-stores/${store.id}/rows`, { projectId: 'p2', updates: [] }),
      call('GET', `/api/data-stores/${store.id}/rows/${row!.id}/changes?projectId=p2`),
      call('GET', `/api/data-stores/${store.id}/views?projectId=p2`),
    ];

    const statuses = (await Promise.all(foreignRoutes)).map((response) => response.status);

    expect(statuses).toEqual([404, 404, 404, 404, 404, 404]);
  });

  describe('user can create and list data stores', () => {
    it('creates a store that appears in the project list only', async () => {
      const created = await call('POST', '/api/data-stores', { projectId: 'p1', displayName: 'Inventory' });
      const store = await json(created);
      stores.createStore({ projectId: 'p2', displayName: 'Elsewhere' });

      const list = await json(await call('GET', '/api/data-stores?projectId=p1'));

      expect(created.status).toBe(201);
      expect(store).toMatchObject({ displayName: 'Inventory', projectId: 'p1' });
      expect(list).toEqual({ items: [store], total: 1, limit: 100, offset: 0 });
    });

    it('bounds the list by limit and offset and refuses a limit over 200', async () => {
      for (const displayName of ['a', 'b', 'c']) stores.createStore({ projectId: 'p1', displayName });

      const everything = await json(await call('GET', '/api/data-stores?projectId=p1'));
      const page = await json(await call('GET', '/api/data-stores?projectId=p1&limit=2&offset=1'));
      const tooMany = await call('GET', '/api/data-stores?projectId=p1&limit=201');

      expect(page).toMatchObject({ total: 3, limit: 2, offset: 1, items: everything.items.slice(1, 3) });
      expect(tooMany.status).toBe(400);
    });

    it('refuses a duplicate name with 409, an empty name with 400 and an unknown project with 404', async () => {
      stores.createStore({ projectId: 'p1', displayName: 'Inventory' });

      const duplicate = await call('POST', '/api/data-stores', { projectId: 'p1', displayName: 'Inventory' });
      const empty = await call('POST', '/api/data-stores', { projectId: 'p1', displayName: '   ' });
      const noName = await call('POST', '/api/data-stores', { projectId: 'p1' });
      const ghost = await call('POST', '/api/data-stores', { projectId: 'ghost', displayName: 'X' });

      expect(duplicate.status).toBe(409);
      expect(await duplicate.json()).toMatchObject({ error: 'duplicate_name' });
      expect(empty.status).toBe(400);
      expect(noName.status).toBe(400);
      expect(ghost.status).toBe(404);
      expect(await ghost.json()).toMatchObject({ error: 'project_not_found', kind: 'not_found', retry: 'never' });
    });

    it('refuses a store name over 200 characters with 400 and accepts exactly 200', async () => {
      const tooLong = await call('POST', '/api/data-stores', { projectId: 'p1', displayName: 'n'.repeat(201) });
      const atLimit = await call('POST', '/api/data-stores', { projectId: 'p1', displayName: 'n'.repeat(200) });

      expect(tooLong.status).toBe(400);
      expect(atLimit.status).toBe(201);
    });

    it.each(['', '%20', '-1', '1.5', 'abc'])('refuses limit=%j on a list with 400', async (limit) => {
      const response = await call('GET', `/api/data-stores?projectId=p1&limit=${limit}`);

      expect(response.status).toBe(400);
    });

    it('refuses a blank limit on the row changes with 400', async () => {
      const { store, name, qty } = seedStore();
      const [bolt] = (await insertRows(store.id, { name, qty }, [['bolt', 1]])).items;

      const response = await call('GET', `/api/data-stores/${store.id}/rows/${bolt!.id}/changes?projectId=p1&limit=`);

      expect(response.status).toBe(400);
    });

    it('shows a store with its columns in order', async () => {
      const { store, name, qty, status } = seedStore();

      const response = await call('GET', `/api/data-stores/${store.id}?projectId=p1`);

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ...store, columns: [name, qty, status] });
    });

    it('answers 404 for a missing store', async () => {
      const response = await call('GET', '/api/data-stores/nope?projectId=p1');

      expect(response.status).toBe(404);
    });

    it('requires the project scope', async () => {
      const response = await call('GET', '/api/data-stores');

      expect(response.status).toBe(400);
    });
  });

  describe('user can add and edit rows', () => {
    it('inserts a batch and gets the rows back', async () => {
      const { store, name, qty } = seedStore();

      const response = await call('POST', `/api/data-stores/${store.id}/rows`, { projectId: 'p1', rows: [{ [name.id]: 'bolt', [qty.id]: 5 }, { [name.id]: 'nut' }] });
      const { items } = await json(response);

      expect(response.status).toBe(201);
      expect(items.map((row: any) => row.data)).toEqual([{ [name.id]: 'bolt', [qty.id]: 5 }, { [name.id]: 'nut' }]);
      expect(items[0]).toMatchObject({ storeId: store.id });
    });

    it('rejects a wrongly typed cell or an unknown column with 400 and inserts nothing', async () => {
      const { store, name, qty } = seedStore();

      const wrongType = await call('POST', `/api/data-stores/${store.id}/rows`, { projectId: 'p1', rows: [{ [name.id]: 'ok' }, { [qty.id]: 'not a number' }] });
      const unknownColumn = await call('POST', `/api/data-stores/${store.id}/rows`, { projectId: 'p1', rows: [{ ghost: 1 }] });
      const stored = await json(await call('GET', `/api/data-stores/${store.id}/rows?projectId=p1`));

      expect(wrongType.status).toBe(400);
      expect(unknownColumn.status).toBe(400);
      expect(stored.total).toBe(0);
    });

    it('rejects more than 500 rows in one batch with 400', async () => {
      const { store, name } = seedStore();

      const response = await call('POST', `/api/data-stores/${store.id}/rows`, { projectId: 'p1', rows: Array.from({ length: 501 }, () => ({ [name.id]: 'x' })) });

      expect(response.status).toBe(400);
    });

    it('accepts the row that reaches the store row cap and refuses the next one with 413', async () => {
      const { store, name } = seedStore();
      const rowsBelowCap = MAX_ROWS_PER_STORE - 1;
      for (let inserted = 0; inserted < rowsBelowCap; inserted += 500) {
        const batchSize = Math.min(500, rowsBelowCap - inserted);
        stores.insertRows(store.id, { projectId: 'p1', items: Array.from({ length: batchSize }, () => ({ [name.id]: 'x' })), actor: AGENT });
      }

      const reachingCap = await call('POST', `/api/data-stores/${store.id}/rows`, { projectId: 'p1', rows: [{ [name.id]: 'last one' }] });
      const pastCap = await call('POST', `/api/data-stores/${store.id}/rows`, { projectId: 'p1', rows: [{ [name.id]: 'one too many' }] });

      expect(reachingCap.status).toBe(201);
      expect(pastCap.status).toBe(413);
      expect(await pastCap.json()).toMatchObject({ error: 'row_cap' });
    }, FILL_TO_CAP_TIMEOUT_MS);

    it('patches rows and gets the updated rows back', async () => {
      const { store, name, qty } = seedStore();
      const [bolt, nut] = (await insertRows(store.id, { name, qty }, [['bolt', 1], ['nut', 2]])).items;

      const response = await call('PATCH', `/api/data-stores/${store.id}/rows`, {
        projectId: 'p1', updates: [{ rowId: bolt!.id, patch: { [qty.id]: 10 } }, { rowId: nut!.id, patch: { [name.id]: 'washer' } }],
      });
      const { items } = await json(response);

      expect(response.status).toBe(200);
      expect(items.map((row: any) => row.data)).toEqual([{ [name.id]: 'bolt', [qty.id]: 10 }, { [name.id]: 'washer', [qty.id]: 2 }]);
    });

    it('answers 404 for an unknown row and 400 for a bad patch, changing nothing', async () => {
      const { store, name, qty } = seedStore();
      const [bolt] = (await insertRows(store.id, { name, qty }, [['bolt', 1]])).items;

      const unknownRow = await call('PATCH', `/api/data-stores/${store.id}/rows`, { projectId: 'p1', updates: [{ rowId: bolt!.id, patch: { [qty.id]: 2 } }, { rowId: 'nope', patch: {} }] });
      const badPatch = await call('PATCH', `/api/data-stores/${store.id}/rows`, { projectId: 'p1', updates: [{ rowId: bolt!.id, patch: { [qty.id]: 'x' } }] });
      const stored = await json(await call('GET', `/api/data-stores/${store.id}/rows?projectId=p1`));

      expect(unknownRow.status).toBe(404);
      expect(badPatch.status).toBe(400);
      expect(stored.items[0].data[qty.id]).toBe(1);
    });
  });

  describe('user cannot write a daemon-set column', () => {
    function seedStoreWithCreatedAt() {
      const seeded = seedStore();
      const createdAt = stores.addColumn(seeded.store.id, { projectId: 'p1', displayName: 'created', columnType: 'date', autoValue: 'created_at' });
      return { ...seeded, createdAt };
    }

    it('answers 400 invalid_body when a patch sets the column, to a value or to null, changing nothing', async () => {
      const { store, name, qty, createdAt } = seedStoreWithCreatedAt();
      const [bolt] = (await insertRows(store.id, { name, qty }, [['bolt', 1]])).items;
      const before = await json(await call('GET', `/api/data-stores/${store.id}/rows?projectId=p1`));

      const toValue = await call('PATCH', `/api/data-stores/${store.id}/rows`, { projectId: 'p1', updates: [{ rowId: bolt!.id, patch: { [createdAt.id]: '2020-01-01T00:00:00.000Z' } }] });
      const toNull = await call('PATCH', `/api/data-stores/${store.id}/rows`, { projectId: 'p1', updates: [{ rowId: bolt!.id, patch: { [createdAt.id]: null } }] });
      const after = await json(await call('GET', `/api/data-stores/${store.id}/rows?projectId=p1`));

      expect(toValue.status).toBe(400);
      expect(await toValue.json()).toMatchObject({ error: 'invalid_body', kind: 'invalid_request', retry: 'never', detail: `Column ${createdAt.id} is set by the daemon and cannot be updated` });
      expect(toNull.status).toBe(400);
      expect(after).toEqual(before);
    });

    it('answers 400 and applies no item of a batch whose second item sets the column', async () => {
      const { store, name, qty, createdAt } = seedStoreWithCreatedAt();
      const [bolt, nut] = (await insertRows(store.id, { name, qty }, [['bolt', 1], ['nut', 2]])).items;
      const before = await json(await call('GET', `/api/data-stores/${store.id}/rows?projectId=p1`));

      const response = await call('PATCH', `/api/data-stores/${store.id}/rows`, {
        projectId: 'p1', updates: [{ rowId: bolt!.id, patch: { [qty.id]: 10 } }, { rowId: nut!.id, patch: { [createdAt.id]: '2020-01-01T00:00:00.000Z' } }],
      });
      const after = await json(await call('GET', `/api/data-stores/${store.id}/rows?projectId=p1`));

      expect(response.status).toBe(400);
      expect(after).toEqual(before);
    });

    it('answers 201 on an insert that supplies the column and stamps the daemon clock instead of the supplied value', async () => {
      const { store, name, createdAt } = seedStoreWithCreatedAt();
      const suppliedValue = '2020-01-01T00:00:00.000Z';

      const response = await call('POST', `/api/data-stores/${store.id}/rows`, { projectId: 'p1', rows: [{ [name.id]: 'bolt', [createdAt.id]: suppliedValue }] });
      const { items } = await json(response);

      expect(response.status).toBe(201);
      expect(items[0].data[createdAt.id]).toMatch(/^2026-01-01T/);
    });
  });

  describe('user can query rows', () => {
    it('filters, orders and pages, counting the matches before paging', async () => {
      const { store, name, qty } = seedStore();
      await insertRows(store.id, { name, qty }, [['a', 5], ['b', 1], ['c', 9], ['d', 3]]);

      const response = await call('GET', `/api/data-stores/${store.id}/rows?${q({
        projectId: 'p1', where: [{ columnId: qty.id, op: 'gte', value: 3 }], orderBy: [{ columnId: qty.id, dir: 'desc' }], limit: '2', offset: '1',
      })}`);
      const page = await json(response);

      expect(response.status).toBe(200);
      expect(page.items.map((row: any) => row.data[name.id])).toEqual(['a', 'd']);
      expect(page).toMatchObject({ total: 3, limit: 2, offset: 1 });
    });

    it('defaults to 100 rows a page and refuses a limit over 1000', async () => {
      const { store } = seedStore();

      const page = await json(await call('GET', `/api/data-stores/${store.id}/rows?projectId=p1`));
      const tooMany = await call('GET', `/api/data-stores/${store.id}/rows?projectId=p1&limit=1001`);

      expect(page).toMatchObject({ items: [], total: 0, limit: 100, offset: 0 });
      expect(tooMany.status).toBe(400);
    });

    it('refuses a malformed filter, an unknown column or a bad operator with 400', async () => {
      const { store } = seedStore();

      const notJson = await call('GET', `/api/data-stores/${store.id}/rows?projectId=p1&where=%7Bnope`);
      const unknownColumn = await call('GET', `/api/data-stores/${store.id}/rows?${q({ projectId: 'p1', where: [{ columnId: 'ghost', op: 'eq', value: 1 }] })}`);
      const badOperator = await call('GET', `/api/data-stores/${store.id}/rows?${q({ projectId: 'p1', where: [{ columnId: 'x', op: 'like', value: 1 }] })}`);
      const badOrder = await call('GET', `/api/data-stores/${store.id}/rows?${q({ projectId: 'p1', orderBy: [{ columnId: 'x', dir: 'up' }] })}`);

      expect([notJson.status, unknownColumn.status, badOperator.status, badOrder.status]).toEqual([400, 400, 400, 400]);
    });

    it('returns the same rows as the MCP query_data_store tool for the same filter', async () => {
      const { store, name, qty } = seedStore();
      await insertRows(store.id, { name, qty }, [['a', 5], ['b', 1], ['c', 9]]);
      const where = [{ columnId: qty.id, op: 'gt', value: 2 }];
      const orderBy = [{ columnId: qty.id, dir: 'asc' }];
      const client = new Client({ name: 'test', version: '0.0.0' });
      await client.connect(new StreamableHTTPClientTransport(new URL(`${server.url}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${mcpToken}` } } }));

      const viaMcp = JSON.parse(((await client.callTool({ name: 'query_data_store', arguments: { store: store.id, where, order_by: orderBy } })) as { content: { text: string }[] }).content[0]!.text);
      const viaHttp = await json(await call('GET', `/api/data-stores/${store.id}/rows?${q({ projectId: 'p1', where, orderBy })}`));

      expect(viaHttp.items).toMatchObject(viaMcp.rows);
    });
  });

  describe('user can read a row history and the views', () => {
    it('shows the changes newest first with who made them', async () => {
      const { store, name, qty } = seedStore();
      const [bolt] = (await insertRows(store.id, { name, qty }, [['bolt', 1]])).items;
      await call('PATCH', `/api/data-stores/${store.id}/rows`, { projectId: 'p1', updates: [{ rowId: bolt!.id, patch: { [qty.id]: 2 } }] });
      stores.updateRow(store.id, bolt!.id, { projectId: 'p1', patch: { [qty.id]: 3 }, actor: AGENT });

      const response = await call('GET', `/api/data-stores/${store.id}/rows/${bolt!.id}/changes?projectId=p1`);
      const { items, total } = await json(response);

      expect(response.status).toBe(200);
      expect(total).toBe(3);
      expect(items.map((entry: any) => [entry.actorKind, entry.actorLabel])).toEqual([['agent', '⛏️ Gimli'], ['human', 'You'], ['human', 'You']]);
      expect(items[0].change).toEqual({ [qty.id]: { from: 2, to: 3 } });
      expect(items[2].change).toEqual({ kind: 'create' });
    });

    it('bounds the history by limit while still counting every change, and refuses a limit over 500', async () => {
      const { store, name, qty } = seedStore();
      const [bolt] = (await insertRows(store.id, { name, qty }, [['bolt', 1]])).items;
      await call('PATCH', `/api/data-stores/${store.id}/rows`, { projectId: 'p1', updates: [{ rowId: bolt!.id, patch: { [qty.id]: 2 } }] });

      const page = await json(await call('GET', `/api/data-stores/${store.id}/rows/${bolt!.id}/changes?projectId=p1&limit=1`));
      const tooMany = await call('GET', `/api/data-stores/${store.id}/rows/${bolt!.id}/changes?projectId=p1&limit=501`);

      expect(page.items).toHaveLength(1);
      expect(page.total).toBe(2);
      expect(tooMany.status).toBe(400);
    });

    it('pages the history by offset and answers the page shape with the real total', async () => {
      const { store, name, qty } = seedStore();
      const [bolt] = (await insertRows(store.id, { name, qty }, [['bolt', 1]])).items;
      for (const quantity of [2, 3]) await call('PATCH', `/api/data-stores/${store.id}/rows`, { projectId: 'p1', updates: [{ rowId: bolt!.id, patch: { [qty.id]: quantity } }] });
      const changesPath = `/api/data-stores/${store.id}/rows/${bolt!.id}/changes?projectId=p1`;

      const everything = await json(await call('GET', changesPath));
      const secondNewest = await json(await call('GET', `${changesPath}&limit=1&offset=1`));

      expect(secondNewest).toEqual({ items: [everything.items[1]], total: 3, limit: 1, offset: 1 });
    });

    it('asks the repository for only the requested number of changes', async () => {
      const { store, name, qty } = seedStore();
      const [bolt] = (await insertRows(store.id, { name, qty }, [['bolt', 1]])).items;
      const rowHistory = vi.spyOn(storeRepo, 'rowHistory');

      await call('GET', `/api/data-stores/${store.id}/rows/${bolt!.id}/changes?projectId=p1&limit=5`);

      expect(rowHistory).toHaveBeenCalledWith(bolt!.id, expect.objectContaining({ limit: 5 }));
    });

    it('answers 404 for a row without history', async () => {
      const { store } = seedStore();

      const response = await call('GET', `/api/data-stores/${store.id}/rows/nope/changes?projectId=p1`);

      expect(response.status).toBe(404);
    });

    it('answers 404 for the history of a row that belongs to another store of the same project', async () => {
      const storeA = seedStore('A');
      const storeB = seedStore('B');
      const [rowOfB] = (await insertRows(storeB.store.id, storeB, [['bolt', 1]])).items;

      const underOwnStore = await call('GET', `/api/data-stores/${storeB.store.id}/rows/${rowOfB!.id}/changes?projectId=p1`);
      const underOtherStore = await call('GET', `/api/data-stores/${storeA.store.id}/rows/${rowOfB!.id}/changes?projectId=p1`);

      expect(underOwnStore.status).toBe(200);
      expect(underOtherStore.status).toBe(404);
    });

    it('lists the saved views of a store', async () => {
      const { store, status } = seedStore();
      const view = stores.createView(store.id, { projectId: 'p1', displayName: 'Board', viewType: 'kanban', config: { groupByColumnId: status.id } });

      const response = await call('GET', `/api/data-stores/${store.id}/views?projectId=p1`);

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ items: [view] });
    });
  });

  it('user can create a store, fill it, query it filtered and ordered, update a row and read its history', async () => {
    const created = await json(await call('POST', '/api/data-stores', { projectId: 'p1', displayName: 'Stock' }));
    const name = stores.addColumn(created.id, { projectId: 'p1', displayName: 'name', columnType: 'text' });
    const qty = stores.addColumn(created.id, { projectId: 'p1', displayName: 'qty', columnType: 'number' });
    const inserted = await insertRows(created.id, { name, qty }, [['bolt', 5], ['nut', 1], ['screw', 9]]);
    const filtered = await json(await call('GET', `/api/data-stores/${created.id}/rows?${q({ projectId: 'p1', where: [{ columnId: qty.id, op: 'gt', value: 2 }], orderBy: [{ columnId: qty.id, dir: 'desc' }] })}`));
    const updated = await json(await call('PATCH', `/api/data-stores/${created.id}/rows`, { projectId: 'p1', updates: [{ rowId: inserted.items[1]!.id, patch: { [qty.id]: 50 } }] }));
    const history = await json(await call('GET', `/api/data-stores/${created.id}/rows/${inserted.items[1]!.id}/changes?projectId=p1`));

    expect(filtered.items.map((row: any) => row.data[name.id])).toEqual(['screw', 'bolt']);
    expect(updated.items[0].data[qty.id]).toBe(50);
    expect(history.items.map((entry: any) => entry.actorKind)).toEqual(['human', 'human']);
  });
});
