import { Injectable } from '@angular/core';
import type {
  Approval, CreateNoteRequest, HarnessId, NoteSummary, NoteVersionSummary, NoteView, Page, PermissionMode, Project,
  RestoreNoteRequest, Session, SessionSpec, UpdateNoteRequest,
} from '@openfleet/shared';
import { environment } from '../../environments/environment';

export type PageRequest = Partial<Pick<Page<unknown>, 'limit' | 'offset'>>;
type NoteChange = Omit<UpdateNoteRequest, 'projectId'>;
type NoteRestore = Omit<RestoreNoteRequest, 'projectId'>;

const DAEMON_ANSWER_TIMEOUT_MS = 5000;

const pageParams = ({ limit, offset }: PageRequest): Record<string, string> => ({
  ...(limit === undefined ? {} : { limit: String(limit) }),
  ...(offset === undefined ? {} : { offset: String(offset) }),
});

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

  private noteUrl(noteId: string, suffix = '', query: Record<string, string> = {}): string {
    const queryString = new URLSearchParams(query).toString();
    const path = `/api/notes/${encodeURIComponent(noteId)}${suffix}`;
    return queryString ? `${path}?${queryString}` : path;
  }
  listProjects(page: PageRequest = {}) { return this.call<Page<Project>>(`/api/projects?${new URLSearchParams(pageParams(page))}`); }
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
}
