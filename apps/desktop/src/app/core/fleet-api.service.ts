import { Injectable } from '@angular/core';
import type { Approval, DataStore, DsColumn, DsRow, DsRowHistoryEntry, DsView, HarnessId, OrderTerm, PermissionMode, Session, SessionSpec, WhereClause } from '@openfleet/shared';
import { environment } from '../../environments/environment';

const DAEMON_ANSWER_TIMEOUT_MS = 5000;
const LIST_PAGE_LIMIT = 200;

export class ApiError extends Error {
  // `code` is the REST error body's `error` field (e.g. `not_closed`, `directory_missing`) when the
  // server sent one — undefined for a response with no JSON body or no recognizable `error` field.
  constructor(public readonly status: number, message: string, public readonly code?: string) {
    super(message);
  }
}

// A close waits up to the daemon's 5 s SIGTERM grace window and may wait on a relaunch in progress; a request that
// outlasts this is lost, and its session must not stay busy for good.
const REQUEST_TIMEOUT_MS = 60_000;

@Injectable({ providedIn: 'root' })
export class FleetApiService {
  // ponytail: fetch over HttpClient — no interceptors needed yet
  private async call<T>(path: string, init: RequestInit = {}): Promise<T> {
    const requestTimeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    const abortsOnCallerOrTimeout = init.signal ? AbortSignal.any([init.signal, requestTimeout]) : requestTimeout;
    const response = await fetch(`${environment.apiUrl}${path}`, {
      ...init,
      signal: abortsOnCallerOrTimeout,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${environment.adminToken}`, ...(init.headers ?? {}) },
    });
    if (!response.ok) {
      const code = await response
        .json()
        .then((body: unknown) => (body && typeof body === 'object' && 'error' in body && typeof body.error === 'string' ? body.error : undefined))
        .catch(() => undefined);
      throw new ApiError(response.status, `${init.method ?? 'GET'} ${path} → ${response.status}`, code);
    }
    return (await response.json()) as T;
  }
  private async listAllPages<T>(path: string, params: Record<string, string>): Promise<Page<T>> {
    const items: T[] = [];
    let total = 0;
    do {
      const page = await this.call<Page<T>>(`${path}${queryString({ ...params, limit: LIST_PAGE_LIMIT, offset: items.length })}`);
      items.push(...page.items);
      total = page.total ?? 0;
      if (page.items.length === 0) break;
    } while (items.length < total);
    return { items, total: Math.max(total, items.length), limit: LIST_PAGE_LIMIT, offset: 0 };
  }
  private post<T>(path: string, body: unknown): Promise<T> { return this.call<T>(path, { method: 'POST', body: JSON.stringify(body) }); }
  private patch<T>(path: string, body: unknown): Promise<T> { return this.call<T>(path, { method: 'PATCH', body: JSON.stringify(body) }); }
  private put<T>(path: string, body: unknown): Promise<T> { return this.call<T>(path, { method: 'PUT', body: JSON.stringify(body) }); }

  // Rejects when the daemon has not answered within `timeoutMs`, so a daemon that accepts the
  // connection and never replies counts as unreachable instead of hanging its caller.
  private async getWithin<T>(path: string, timeoutMs: number): Promise<T> {
    const controller = new AbortController();
    const abortTimer = setTimeout(() => controller.abort(), timeoutMs);
    const hasTimedOut = new Promise<never>((_resolve, reject) =>
      controller.signal.addEventListener('abort', () => reject(new ApiError(0, `GET ${path} → no answer within ${timeoutMs} ms`))),
    );
    try {
      return await Promise.race([this.call<T>(path, { signal: controller.signal }), hasTimedOut]);
    } finally {
      clearTimeout(abortTimer);
    }
  }

  async health(): Promise<{ ok: true }> {
    const body = await this.getWithin<{ ok?: boolean } | null>('/health', DAEMON_ANSWER_TIMEOUT_MS);
    if (body?.ok !== true) throw new ApiError(200, 'GET /health → the daemon does not report itself ok');
    return { ok: true };
  }
  listSessions() { return this.getWithin<Session[]>('/api/sessions', DAEMON_ANSWER_TIMEOUT_MS); }
  models() { return this.call<Record<string, string>>('/api/models'); }
  availableModels() { return this.call<{ models: string[] }>('/api/models/available'); }
  saveModels(patch: Record<string, string>) { return this.put<{ models: Record<string, string> }>('/api/models', patch); }
  createSession(spec: Partial<SessionSpec> & { directory: string; name: string; repoPath?: string; branchName?: string }) { return this.post<Session>('/api/sessions', spec); }
  createManagerSession(spec: { directory: string; name: string; emoji?: string; model?: string; harness?: HarnessId; permissionMode?: PermissionMode; pulseSeconds: number; childrenCap: number; mission: string }) {
    return this.post<Session>('/api/sessions', {
      directory: spec.directory, name: spec.name, emoji: spec.emoji, model: spec.model,
      harness: spec.harness, permissionMode: spec.permissionMode,
      manager: { pulseSeconds: spec.pulseSeconds, childrenCap: spec.childrenCap, mission: spec.mission },
    });
  }
  pulseNow(sessionId: string) { return this.post<{ pulsed: boolean; coalesced?: boolean }>(`/api/managers/${sessionId}/pulse`, {}); }
  sendMessage(id: string, body: string) { return this.post<{ status: 'delivered' | 'queued'; messageId: string }>(`/api/sessions/${id}/messages`, { body }); }
  sendInput(id: string, data: string) { return this.post(`/api/sessions/${id}/input`, { data }); }
  resize(id: string, cols: number, rows: number) { return this.post(`/api/sessions/${id}/resize`, { cols, rows }); }
  closeSession(id: string) { return this.post(`/api/sessions/${id}/close`, {}); }
  updateModel(id: string, model: string) { return this.post<{ status: 'relaunching' | 'deferred' }>(`/api/sessions/${id}/model`, { model }); }
  updatePermissionMode(id: string, mode: PermissionMode) { return this.post<{ status: 'relaunching' | 'deferred' }>(`/api/sessions/${id}/permission-mode`, { mode }); }
  renameSession(id: string, patch: { name?: string; emoji?: string }) { return this.patch<Session>(`/api/sessions/${id}`, patch); }
  reopenSession(id: string) { return this.post<Session>(`/api/sessions/${id}/reopen`, {}); }
  decide(id: string, behavior: 'allow' | 'deny') { return this.post<Approval>(`/api/approvals/${id}/decide`, { behavior }); }

  // --- Data stores (Tables screen, P3-T18) ---
  listProjects() { return this.listAllPages<Project>('/api/projects', {}); }
  listDataStores(projectId: string) { return this.listAllPages<DataStore>('/api/data-stores', { projectId }); }
  createDataStore(body: { projectId: string; displayName: string }) { return this.post<DataStore>('/api/data-stores', body); }
  getDataStore(scope: StoreScope) { return this.call<DataStoreDetail>(`/api/data-stores/${scope.storeId}${queryString({ projectId: scope.projectId })}`); }
  queryDataStore(query: StoreScope & { where?: WhereClause[]; orderBy?: OrderTerm[]; limit?: number; offset?: number }) {
    const { storeId, where, orderBy, ...rest } = query;
    const params = { ...rest, where: where && JSON.stringify(where), orderBy: orderBy && JSON.stringify(orderBy) };
    return this.call<Page<DsRow>>(`/api/data-stores/${storeId}/rows${queryString(params)}`);
  }
  insertRows(request: StoreScope & { rows: Record<string, unknown>[] }) {
    return this.post<{ items: DsRow[] }>(`/api/data-stores/${request.storeId}/rows`, { projectId: request.projectId, rows: request.rows });
  }
  updateRows(request: StoreScope & { updates: { rowId: string; patch: Record<string, unknown> }[] }) {
    return this.patch<{ items: DsRow[] }>(`/api/data-stores/${request.storeId}/rows`, { projectId: request.projectId, updates: request.updates });
  }
  listRowChanges(request: StoreScope & { rowId: string; limit?: number }) {
    const params = { projectId: request.projectId, limit: request.limit };
    return this.call<{ items: DsRowHistoryEntry[]; total: number }>(`/api/data-stores/${request.storeId}/rows/${request.rowId}/changes${queryString(params)}`);
  }
  listViews(scope: StoreScope) { return this.call<{ items: DsView[] }>(`/api/data-stores/${scope.storeId}/views${queryString({ projectId: scope.projectId })}`); }
  // --- end data stores ---
}

// --- Data stores (Tables screen, P3-T18) ---
// ponytail: Page and DataStoreDetail are declared here until P3-REST01 exports them from @openfleet/shared; then import them.
export interface Page<T> { items: T[]; total: number; limit: number; offset: number }
export interface DataStoreDetail extends DataStore { columns: DsColumn[] }
export interface Project { id: string; name: string; docsFolderPath: string | null }
export interface StoreScope { projectId: string; storeId: string }

function queryString(params: Record<string, string | number | undefined>): string {
  const presentParams = Object.entries(params).filter((entry): entry is [string, string | number] => entry[1] !== undefined);
  const search = new URLSearchParams(presentParams.map(([key, value]) => [key, String(value)]));
  return presentParams.length > 0 ? `?${search}` : '';
}
// --- end data stores ---
