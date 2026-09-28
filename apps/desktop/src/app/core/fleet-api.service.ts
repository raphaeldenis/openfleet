import { Injectable } from '@angular/core';
import type { Approval, HarnessId, PermissionMode, Session, SessionSpec } from '@openfleet/shared';
import { environment } from '../../environments/environment';

export class ApiError extends Error {
  // `code` is the REST error body's `error` field (e.g. `not_closed`, `directory_missing`) when the
  // server sent one — undefined for a response with no JSON body or no recognizable `error` field.
  constructor(public readonly status: number, message: string, public readonly code?: string) {
    super(message);
  }
}

@Injectable({ providedIn: 'root' })
export class FleetApiService {
  // ponytail: fetch over HttpClient — no interceptors needed yet
  private async call<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await fetch(`${environment.apiUrl}${path}`, {
      ...init,
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

  models() { return this.call<Record<string, string>>('/api/models'); }
  availableModels() { return this.call<{ models: string[] }>('/api/models/available'); }
  saveModels(patch: Record<string, string>) { return this.put<{ models: Record<string, string>; unknownRungs?: string[] }>('/api/models', patch); }
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
}
