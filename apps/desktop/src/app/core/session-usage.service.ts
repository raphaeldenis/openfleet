import { Injectable, inject, signal, type Signal, type WritableSignal } from '@angular/core';
import { FleetApiService } from './fleet-api.service';
import type { TokenUsage } from './token-usage';

/** `undefined` while the first answer is awaited, `null` when the daemon has no usage, `'unavailable'` when the request failed. */
export type TokenUsageLoad = TokenUsage | null | undefined | 'unavailable';

/** Holds the token usage of each session the screen shows; an entry changes only when `refresh` is called. */
@Injectable({ providedIn: 'root' })
export class SessionUsageService {
  private readonly api = inject(FleetApiService);
  private readonly loads = new Map<string, WritableSignal<TokenUsageLoad>>();
  private readonly sessionsBeingRefreshed = new Set<string>();
  private readonly sessionsToRefreshAgain = new Set<string>();

  usageOf(sessionId: string): Signal<TokenUsageLoad> {
    return this.signalOf(sessionId).asReadonly();
  }

  /** A refresh requested while another one is in flight makes the session read once more when that one ends. */
  async refresh(sessionId: string): Promise<void> {
    const isAlreadyBeingRefreshed = this.sessionsBeingRefreshed.has(sessionId);
    if (isAlreadyBeingRefreshed) {
      this.sessionsToRefreshAgain.add(sessionId);
      return;
    }
    this.sessionsBeingRefreshed.add(sessionId);
    try {
      do {
        this.sessionsToRefreshAgain.delete(sessionId);
        await this.readOnce(sessionId);
      } while (this.sessionsToRefreshAgain.has(sessionId));
    } finally {
      this.sessionsBeingRefreshed.delete(sessionId);
    }
  }

  private async readOnce(sessionId: string): Promise<void> {
    const load = this.signalOf(sessionId);
    try {
      load.set(await this.api.getSessionUsage(sessionId));
    } catch {
      load.set('unavailable');
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
