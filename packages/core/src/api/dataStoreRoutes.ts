import type { ServerResponse } from 'node:http';
import {
  CreateDataStoreRequestSchema, InsertRowsRequestSchema, DEFAULT_PAGE_LIMIT, MAX_HISTORY_LIMIT, MAX_NOTE_PAGE_LIMIT, MAX_ROW_PAGE_LIMIT, OrderTermSchema, UpdateRowsRequestSchema, WhereClauseSchema,
  pageQuerySchema, queryInteger,
  type DataStore, type DataStoreDetail, type DsRow, type DsRowHistoryEntry, type Page, type RowActorKind,
} from '@openfleet/shared';
import { z } from 'zod';
import { DuplicateNameError, RowNotFoundError, StoreNotFoundError, UnknownColumnError, type DataStoreRepository } from '../stores/dataStoreRepository.js';
import {
  ConstraintError, InvalidCellValueError, InvalidNameError, InvalidQueryError, ReferencedRecordMissingError, StoreRowCapError, type DataStoreService,
} from '../stores/dataStoreService.js';
import { json, queryParams, type Router } from './router.js';

const REST_ACTOR: { kind: RowActorKind; label: string } = { kind: 'human', label: 'You' };

const ProjectScopeSchema = z.object({ projectId: z.string().min(1) });
const ListStoresQuerySchema = ProjectScopeSchema.extend(pageQuerySchema(MAX_NOTE_PAGE_LIMIT).shape);

const jsonParam = <T extends z.ZodType>(schema: T) => z.string().transform((text, ctx) => {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    ctx.addIssue({ code: 'custom', message: 'not valid JSON' });
    return z.NEVER;
  }
}).pipe(schema);

const QueryRowsQuerySchema = ProjectScopeSchema.extend(pageQuerySchema(MAX_ROW_PAGE_LIMIT).shape).extend({
  where: jsonParam(z.array(WhereClauseSchema)).optional(),
  orderBy: jsonParam(z.array(OrderTermSchema)).optional(),
});
const ChangesQuerySchema = ProjectScopeSchema.extend({ limit: queryInteger.pipe(z.number().max(MAX_HISTORY_LIMIT)).default(DEFAULT_PAGE_LIMIT) });

export interface DataStoreRouteDeps {
  stores: DataStoreService;
  storeRepo: DataStoreRepository;
}

class ProjectNotFoundError extends Error {
  constructor(projectId: string) {
    super(`project not found: ${projectId}`);
  }
}

function mapMissingReferenceTo<T>(run: () => T, replacement: Error): T {
  try {
    return run();
  } catch (error) {
    throw error instanceof ReferencedRecordMissingError ? replacement : error;
  }
}

/** Maps the data-store domain errors to their HTTP answer; anything else is not a domain error and propagates. */
function respondToStoreErrors(res: ServerResponse, run: () => void): void {
  try {
    run();
  } catch (error) {
    if (error instanceof ProjectNotFoundError) return json(res, 404, { error: 'project_not_found' });
    if (error instanceof StoreNotFoundError || error instanceof RowNotFoundError) return json(res, 404, { error: 'not_found' });
    if (error instanceof DuplicateNameError) return json(res, 409, { error: 'duplicate_name' });
    if (error instanceof ConstraintError) return json(res, 409, { error: 'constraint_violation', detail: error.message });
    if (error instanceof StoreRowCapError) return json(res, 413, { error: 'row_cap' });
    const isInvalidInput = error instanceof InvalidCellValueError || error instanceof InvalidNameError || error instanceof InvalidQueryError || error instanceof UnknownColumnError;
    if (isInvalidInput) return json(res, 400, { error: 'invalid_body', detail: error.message });
    throw error;
  }
}

export function registerDataStoreRoutes(router: Router, { stores, storeRepo }: DataStoreRouteDeps): void {
  /** A store from another project reads exactly like a missing one. */
  function requireOwnStore(projectId: string, storeId: string): DataStore {
    const store = storeRepo.findStore(storeId);
    if (!store || store.projectId !== projectId) throw new StoreNotFoundError(storeId);
    return store;
  }

  router.add('GET', '/api/data-stores', ({ req, res }) => {
    const { projectId, limit, offset } = ListStoresQuerySchema.parse(queryParams(req));
    const all = storeRepo.listStores(projectId);
    const page: Page<DataStore> = { items: all.slice(offset, offset + limit), total: all.length, limit, offset };
    json(res, 200, page);
  });

  router.add('POST', '/api/data-stores', ({ res, body }) => {
    const { projectId, displayName } = CreateDataStoreRequestSchema.parse(body);
    respondToStoreErrors(res, () => {
      // createStore's only foreign key is the project
      const store = mapMissingReferenceTo(() => stores.createStore({ projectId, displayName }), new ProjectNotFoundError(projectId));
      json(res, 201, store);
    });
  });

  router.add('GET', '/api/data-stores/:id', ({ req, res, params }) => {
    const { projectId } = ProjectScopeSchema.parse(queryParams(req));
    respondToStoreErrors(res, () => {
      const store = requireOwnStore(projectId, params.id!);
      const detail: DataStoreDetail = { ...store, columns: storeRepo.listColumns(store.id) };
      json(res, 200, detail);
    });
  });

  router.add('GET', '/api/data-stores/:id/rows', ({ req, res, params }) => {
    const { projectId, where, orderBy, limit, offset } = QueryRowsQuerySchema.parse(queryParams(req));
    respondToStoreErrors(res, () => {
      const matches = stores.query(params.id!, { projectId, where, orderBy });
      const page: Page<DsRow> = { items: matches.slice(offset, offset + limit), total: matches.length, limit, offset };
      json(res, 200, page);
    });
  });

  router.add('POST', '/api/data-stores/:id/rows', ({ res, params, body }) => {
    const { projectId, rows } = InsertRowsRequestSchema.parse(body);
    respondToStoreErrors(res, () => json(res, 201, { items: stores.insertRows(params.id!, { projectId, items: rows, actor: REST_ACTOR }) }));
  });

  router.add('PATCH', '/api/data-stores/:id/rows', ({ res, params, body }) => {
    const { projectId, updates } = UpdateRowsRequestSchema.parse(body);
    respondToStoreErrors(res, () => json(res, 200, { items: stores.updateRows(params.id!, { projectId, items: updates, actor: REST_ACTOR }) }));
  });

  router.add('GET', '/api/data-stores/:id/rows/:rowId/changes', ({ req, res, params }) => {
    const { projectId, limit } = ChangesQuerySchema.parse(queryParams(req));
    respondToStoreErrors(res, () => {
      const store = requireOwnStore(projectId, params.id!);
      const scope = { projectId, storeId: store.id };
      const total = storeRepo.countRowHistory(params.rowId!, scope);
      if (total === 0) throw new RowNotFoundError(params.rowId!);
      const items: DsRowHistoryEntry[] = storeRepo.rowHistory(params.rowId!, { ...scope, limit });
      json(res, 200, { items, total });
    });
  });

  router.add('GET', '/api/data-stores/:id/views', ({ req, res, params }) => {
    const { projectId } = ProjectScopeSchema.parse(queryParams(req));
    respondToStoreErrors(res, () => json(res, 200, { items: stores.listViews(params.id!, { projectId }) }));
  });
}
