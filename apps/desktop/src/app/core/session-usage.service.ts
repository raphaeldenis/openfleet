import { Injectable, inject, signal, type Signal, type WritableSignal } from '@angular/core';
import { FleetApiService } from './fleet-api.service';
import type { TokenUsage } from './token-usage';

/** `undefined` while the first answer is awaited, `null` when there is no usage to show. */
export type TokenUsageLoad = TokenUsage | null | undefined;

/** Holds the token usage of each session the screen shows; an entry changes only when `refresh` is called. */
@Injectable({ providedIn: 'root' })
export class SessionUsageService {
  private readonly api = inject(FleetApiService);
  private readonly loads = new Map<string, WritableSignal<TokenUsageLoad>>();
  private readonly sessionsBeingRefreshed = new Set<string>();

  usageOf(sessionId: string): Signal<TokenUsageLoad> {
    return this.signalOf(sessionId).asReadonly();
  }

  async refresh(sessionId: string): Promise<void> {
    const isAlreadyBeingRefreshed = this.sessionsBeingRefreshed.has(sessionId);
    if (isAlreadyBeingRefreshed) return;
    this.sessionsBeingRefreshed.add(sessionId);
    const load = this.signalOf(sessionId);
    try {
      load.set(await this.api.getSessionUsage(sessionId));
    } catch {
      load.set(null);
    } finally {
      this.sessionsBeingRefreshed.delete(sessionId);
    }
  }

  private signalOf(sessionId: string): WritableSignal<TokenUsageLoad> {
    const existing = this.loads.get(sessionId);
    if (existing) return existing;
    const created = signal<TokenUsageLoad>(undefined);
    this.loads.set(sessionId, created);
    return created;
  }
}
