import { Injectable } from '@angular/core';
import { DIAGNOSTICS_PATH, isErrorEnvelope } from '@openfleet/shared';
import type {
  Approval, CloseHandoffResult, CloseSessionRequest, CreateNoteRequest, CreateProjectRequest, DataStore, DataStoreDetail, DiagnosticsDocument, DsRow, DsRowHistoryEntry, DsView, ErrorEnvelope, HandoffPreview, HandoffSummary, HandoffTarget, HarnessId, NoteSummary,
  ManagerProfile, ManagerView, NoteVersionSummary, NoteView, OrderTerm, Page, PermissionMode, Project, ReopenMode, RestoreNoteRequest, Session, SessionSpec, SessionTodos,
  UpdateManager, UpdateNoteRequest, UpdateProjectRequest, WhereClause,
} from '@openfleet/shared';
import { environment } from '../../environments/environment';
import { parseCloseHandoffResult, parseHandoffPreview, parseHandoffTarget } from './handoff-response-parser';
import { parseManagerProfile } from './manager-profile-parser';
import { parseProject } from './project-response-parser';
import { parseSessionTodos } from './session-todos-parser';

export type PageRequest = Partial<Pick<Page<unknown>, 'limit' | 'offset'>>;
type NoteChange = Omit<UpdateNoteRequest, 'projectId'>;
type NoteRestore = Omit<RestoreNoteRequest, 'projectId'>;

const DAEMON_ANSWER_TIMEOUT_MS = 5000;
const LIST_PAGE_LIMIT = 200;

const pageParams = ({ limit, offset }: PageRequest): Record<string, string> => ({
  ...(limit === undefined ? {} : { limit: String(limit) }),
  ...(offset === undefined ? {} : { offset: String(offset) }),
});

function errorCodeOf(body: unknown): string | undefined {
  const isObject = body !== null && typeof body === 'object';
  return isObject && 'error' in body && typeof body.error === 'string' ? body.error : undefined;
}

export class ApiError extends Error {
  // `code` is the REST error body's `error` field (e.g. `not_closed`, `directory_missing`) when the
  // server sent one — undefined for a response with no JSON body or no recognizable `error` field.
  // `envelope` is the whole body when it is a well-formed error envelope.
  constructor(public readonly status: number, message: string, public readonly code?: string, public readonly envelope?: ErrorEnvelope) {
    super(message);
  }
}

// A close waits up to the daemon's 5 s SIGTERM grace window and may wait on a relaunch in progress; a request that
// outlasts this is lost, and its session must not stay busy for good.
const REQUEST_TIMEOUT_MS = 60_000;

@Injectable({ providedIn: 'root' })
export class FleetApiService {
  async listHandoffs(projectId: string): Promise<Page<HandoffSummary>> {
    const items: HandoffSummary[] = [];
    let offset = 0;
    let total = 0;
    do {
      const page = await this.call<Page<HandoffSummary>>(`/api/projects/${encodeURIComponent(projectId)}/handoffs${queryString({ limit: LIST_PAGE_LIMIT, offset })}`);
      items.push(...page.items);
      total = page.total;
      offset += LIST_PAGE_LIMIT;
    } while (offset < total);
    return { items, total: items.length, limit: LIST_PAGE_LIMIT, offset: 0 };
  }
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
      const body: unknown = await response.json().catch(() => undefined);
      const code = errorCodeOf(body);
      const envelope = isErrorEnvelope(body) ? body : undefined;
      throw new ApiError(response.status, `${init.method ?? 'GET'} ${path} → ${response.status}`, code, envelope);
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

  async health(): Promise<{ ok: true; version?: string }> {
    const body = await this.getWithin<{ ok?: boolean; version?: unknown } | null>('/health', DAEMON_ANSWER_TIMEOUT_MS);
    if (body?.ok !== true) throw new ApiError(200, 'GET /health → the daemon does not report itself ok');
    const reportedVersion = typeof body.version === 'string' && body.version !== '' ? body.version : undefined;
    return { ok: true, version: reportedVersion };
  }
  diagnostics() { return this.call<DiagnosticsDocument>(DIAGNOSTICS_PATH); }
  listSessions() { return this.getWithin<Session[]>('/api/sessions', DAEMON_ANSWER_TIMEOUT_MS); }
  models() { return this.call<Record<string, string>>('/api/models'); }
  availableModels() { return this.call<{ models: string[] }>('/api/models/available'); }
  saveModels(patch: Record<string, string>) { return this.put<{ models: Record<string, string> }>('/api/models', patch); }
  createSession(spec: Partial<SessionSpec> & { directory: string; name: string; repoPath?: string; branchName?: string }) { return this.post<Session>('/api/sessions', spec); }
  createManagerSession(spec: { directory: string; name: string; emoji?: string; model?: string; harness?: HarnessId; permissionMode?: PermissionMode; projectId?: string; pulseSeconds?: number; childrenCap: number; mission: string }) {
    return this.post<Session>('/api/sessions', {
      directory: spec.directory, name: spec.name, emoji: spec.emoji, model: spec.model,
      harness: spec.harness, permissionMode: spec.permissionMode, projectId: spec.projectId,
      manager: { pulseSeconds: spec.pulseSeconds, childrenCap: spec.childrenCap, mission: spec.mission },
    });
  }
  pulseNow(sessionId: string) { return this.post<{ pulsed: boolean; coalesced?: boolean }>(`/api/managers/${sessionId}/pulse`, {}); }
  sendMessage(id: string, body: string, messageId?: string) { return this.post<{ status: 'delivered' | 'queued'; messageId: string }>(`/api/sessions/${id}/messages`, { body, messageId }); }
  sendInput(id: string, data: string) { return this.post(`/api/sessions/${id}/input`, { data }); }
  resize(id: string, cols: number, rows: number) { return this.post(`/api/sessions/${id}/resize`, { cols, rows }); }
  async closeSession(id: string, request: CloseSessionRequest = {}): Promise<{ handoff?: CloseHandoffResult }> {
    const answer = await this.post<{ handoff?: unknown } | undefined>(`/api/sessions/${id}/close`, request);
    const handoff = parseCloseHandoffResult(answer?.handoff);
    return handoff ? { handoff } : {};
  }
  updateModel(id: string, model: string) { return this.post<{ status: 'relaunching' | 'deferred' }>(`/api/sessions/${id}/model`, { model }); }
  updatePermissionMode(id: string, mode: PermissionMode) { return this.post<{ status: 'relaunching' | 'deferred' }>(`/api/sessions/${id}/permission-mode`, { mode }); }
  renameSession(id: string, patch: { name?: string; emoji?: string }) { return this.patch<Session>(`/api/sessions/${id}`, patch); }
  reopenSession(id: string, mode: ReopenMode = 'resume') { return this.post<Session>(`/api/sessions/${id}/reopen`, { mode }); }
  async getManagerProfile(id: string): Promise<ManagerProfile> {
    const path = `/api/managers/${encodeURIComponent(id)}`;
    const profile = parseManagerProfile(await this.call<unknown>(path));
    if (!profile) throw new ApiError(200, `GET ${path} → unreadable manager profile`);
    return profile;
  }
  updateManager(id: string, patch: UpdateManager) { return this.patch<ManagerView>(`/api/managers/${encodeURIComponent(id)}`, patch); }
  async getSessionTodos(id: string): Promise<SessionTodos> {
    const path = `/api/sessions/${encodeURIComponent(id)}/todos`;
    const todos = parseSessionTodos(await this.call<unknown>(path));
    if (!todos) throw new ApiError(200, `GET ${path} → unreadable todo list`);
    return todos;
  }
  async getHandoffPreview(id: string): Promise<HandoffPreview> {
    const path = `/api/sessions/${encodeURIComponent(id)}/handoff-preview`;
    const preview = parseHandoffPreview(await this.call<unknown>(path));
    if (!preview) throw new ApiError(200, `GET ${path} → unreadable handoff preview`);
    return preview;
  }
  async getHandoffTarget(id: string): Promise<HandoffTarget> {
    const path = `/api/sessions/${encodeURIComponent(id)}/handoff-target`;
    const target = parseHandoffTarget(await this.call<unknown>(path));
    if (!target) throw new ApiError(200, `GET ${path} → unreadable handoff target`);
    return target;
  }
  decide(id: string, behavior: 'allow' | 'deny') { return this.post<Approval>(`/api/approvals/${id}/decide`, { behavior }); }

  private noteUrl(noteId: string, suffix = '', query: Record<string, string> = {}): string {
    const queryString = new URLSearchParams(query).toString();
    const path = `/api/notes/${encodeURIComponent(noteId)}${suffix}`;
    return queryString ? `${path}?${queryString}` : path;
  }
  listProjects(page?: PageRequest) {
    return page ? this.call<Page<Project>>(`/api/projects?${new URLSearchParams(pageParams(page))}`) : this.listAllPages<Project>('/api/projects', {});
  }
  async createProject(request: CreateProjectRequest): Promise<Project> {
    return this.readProject('POST', '/api/projects', await this.post<unknown>('/api/projects', request));
  }
  async updateProject(projectId: string, patch: UpdateProjectRequest): Promise<Project> {
    const path = `/api/projects/${encodeURIComponent(projectId)}`;
    return this.readProject('PATCH', path, await this.patch<unknown>(path, patch));
  }
  private readProject(method: string, path: string, payload: unknown): Project {
    const project = parseProject(payload);
    if (!project) throw new ApiError(200, `${method} ${path} → unreadable project`);
    return project;
  }
  listNotes(projectId: string, page: PageRequest = {}) { return this.call<Page<NoteSummary>>(`/api/notes?${new URLSearchParams({ projectId, ...pageParams(page) })}`); }
  getNote(projectId: string, noteId: string) { return this.call<NoteView>(this.noteUrl(noteId, '', { projectId })); }
  createNote(note: CreateNoteRequest) { return this.post<NoteView>('/api/notes', note); }
  updateNote(projectId: string, noteId: string, change: NoteChange) { return this.patch<NoteView>(this.noteUrl(noteId), { projectId, ...change }); }
  listNoteVersions(projectId: string, noteId: string, page: PageRequest = {}) {
    return this.call<Page<NoteVersionSummary>>(this.noteUrl(noteId, '/versions', { projectId, ...pageParams(page) }));
  }
  restoreNoteVersion(projectId: string, noteId: string, restore: NoteRestore) {
    return this.post<NoteView>(this.noteUrl(noteId, '/restore'), { projectId, ...restore });
  }
  // --- Data stores (Tables screen, P3-T18) ---
  listDataStores(projectId: string) { return this.listAllPages<DataStore>('/api/data-stores', { projectId }); }
  createDataStore(body: { projectId: string; displayName: string }) { return this.post<DataStore>('/api/data-stores', body); }
  getDataStore(scope: StoreScope) { return this.call<DataStoreDetail>(`${storePath(scope.storeId)}${queryString({ projectId: scope.projectId })}`); }
  queryDataStore(query: StoreScope & { where?: WhereClause[]; orderBy?: OrderTerm[]; limit?: number; offset?: number }) {
    const { storeId, where, orderBy, ...rest } = query;
    const params = { ...rest, where: where && JSON.stringify(where), orderBy: orderBy && JSON.stringify(orderBy) };
    return this.call<Page<DsRow>>(`${storePath(storeId)}/rows${queryString(params)}`);
  }
  insertRows(request: StoreScope & { rows: Record<string, unknown>[] }) {
    return this.post<{ items: DsRow[] }>(`${storePath(request.storeId)}/rows`, { projectId: request.projectId, rows: request.rows });
  }
  updateRows(request: StoreScope & { updates: { rowId: string; patch: Record<string, unknown> }[] }) {
    return this.patch<{ items: DsRow[] }>(`${storePath(request.storeId)}/rows`, { projectId: request.projectId, updates: request.updates });
  }
  listRowChanges(request: StoreScope & { rowId: string; limit?: number }) {
    const params = { projectId: request.projectId, limit: request.limit };
    return this.call<{ items: DsRowHistoryEntry[]; total: number }>(`${storePath(request.storeId)}/rows/${encodeURIComponent(request.rowId)}/changes${queryString(params)}`);
  }
  listViews(scope: StoreScope) { return this.call<{ items: DsView[] }>(`${storePath(scope.storeId)}/views${queryString({ projectId: scope.projectId })}`); }
  // --- end data stores ---
}

// --- Data stores (Tables screen, P3-T18) ---
export interface StoreScope { projectId: string; storeId: string }

const storePath = (storeId: string) => `/api/data-stores/${encodeURIComponent(storeId)}`;

function queryString(params: Record<string, string | number | undefined>): string {
  const presentParams = Object.entries(params).filter((entry): entry is [string, string | number] => entry[1] !== undefined);
  const search = new URLSearchParams(presentParams.map(([key, value]) => [key, String(value)]));
  return presentParams.length > 0 ? `?${search}` : '';
}
// --- end data stores ---
