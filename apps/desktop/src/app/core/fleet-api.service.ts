import { Injectable } from '@angular/core';
import type { Approval, Session, SessionSpec } from '@openfleet/shared';
import { environment } from '../../environments/environment';

@Injectable({ providedIn: 'root' })
export class FleetApiService {
  // ponytail: fetch over HttpClient — no interceptors needed yet
  private async call<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await fetch(`${environment.apiUrl}${path}`, {
      ...init,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${environment.adminToken}`, ...(init.headers ?? {}) },
    });
    if (!response.ok) throw new Error(`${init.method ?? 'GET'} ${path} → ${response.status}`);
    return (await response.json()) as T;
  }
  private post<T>(path: string, body: unknown): Promise<T> { return this.call<T>(path, { method: 'POST', body: JSON.stringify(body) }); }

  listSessions() { return this.call<Session[]>('/api/sessions'); }
  recentOutput(id: string) { return this.call<{ output: string }>(`/api/sessions/${id}/output`); }
  createSession(spec: Partial<SessionSpec> & { directory: string; name: string; repoPath?: string; branchName?: string }) { return this.post<Session>('/api/sessions', spec); }
  sendMessage(id: string, body: string) { return this.post<{ status: string }>(`/api/sessions/${id}/messages`, { body }); }
  sendInput(id: string, data: string) { return this.post(`/api/sessions/${id}/input`, { data }); }
  resize(id: string, cols: number, rows: number) { return this.post(`/api/sessions/${id}/resize`, { cols, rows }); }
  closeSession(id: string) { return this.post(`/api/sessions/${id}/close`, {}); }
  listApprovals() { return this.call<Approval[]>('/api/approvals'); }
  decide(id: string, behavior: 'allow' | 'deny') { return this.post<Approval>(`/api/approvals/${id}/decide`, { behavior }); }
}
